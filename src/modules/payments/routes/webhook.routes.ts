import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getPaymentGateway } from '../gateways/registry';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { WebhookOutcome, decideWebhookResponse } from '../domain/webhook-response';
import { paymentWebhookProcessor } from '../services/webhook-processor.service';
import { AppError } from '../../../core/errors';
import { planPurchaseService } from '../../billing/services/plan-purchase.service';
import { creditTopupService } from '../../billing/services/credit-topup.service';
import { paymentDisputeService } from '../services/dispute.service';

const router = Router();

/**
 * Gateway webhook endpoints — `/api/webhooks/{stripe,notchpay,mycoolpay}`.
 *
 * ── ONE VERIFICATION POLICY, THREE ROUTES ────────────────────────────────────
 * Every route runs the same sequence: raw bytes → `gateway.verifyWebhook` →
 * and only then anything that looks at the payload. Before this, the Stripe
 * route had that sequence and the other two had none at all — they read
 * `x-notchpay-signature` / `x-mycoolpay-signature` into a variable and handed
 * it to `handleWebhook`, whose first act was a comment saying it skips
 * verification. `/api/webhooks/*` is exempt from rate limiting and from
 * maintenance windows, so those two endpoints were an unauthenticated,
 * unthrottled path to `handlePaymentSuccess` — stock commit, fulfilment,
 * earnings split.
 *
 * ── WHY THESE HANDLERS ANSWER THEMSELVES ─────────────────────────────────────
 * They do not use `asyncHandler` and do not call `next(error)`. The exact
 * status code IS the contract with the gateway — it decides whether a dropped
 * confirmation is retried or lost — and the global error handler cannot know
 * that. The whole table lives in `domain/webhook-response.ts`, pure, so
 * `test:payments` can assert it without HTTP.
 *
 * The response body uses `message` rather than a key named `error`: the
 * `no-restricted-syntax` ESLint selector matches `error` anywhere in a
 * `res.json()` object literal.
 */

/**
 * The shared shape. Verify, then hand the verified payload to a gateway-specific
 * handler, then map whatever it says to a status code.
 */
async function runWebhook(
  gateway: PaymentGatewayType,
  req: Request,
  res: Response,
  handle: (payload: Record<string, unknown>) => Promise<WebhookOutcome>
): Promise<void> {
  const adapter = getPaymentGateway(gateway);

  const verification = adapter.verifyWebhook({
    rawBody: req.body,
    headers: req.headers as Record<string, string | string[] | undefined>,
    sourceIp: req.ip ?? null,
  });

  if (!verification.ok) {
    console.warn(
      `[${gateway}Webhook] refused: ${verification.reason}${verification.detail ? ` (${verification.detail})` : ''}`
    );
    const refusal = decideWebhookResponse({ kind: 'refused', reason: verification.reason });
    res.status(refusal.status).json(refusal.body);
    return;
  }

  let outcome: WebhookOutcome;
  try {
    outcome = await handle(verification.payload);
  } catch (error) {
    // The retryable/permanent split, and it is on the ERROR rather than on the
    // gateway. A 4xx AppError is a decision that will not change on a retry; a
    // 5xx or an unrecognised throw is a fault that might clear, and answering
    // 200 to one of those is exactly how a confirmation gets lost forever.
    const retryable = !(error instanceof AppError) || error.statusCode >= 500;
    console.error(
      `[${gateway}Webhook] processing error (retryable=${retryable}):`,
      error instanceof Error ? error.message : error
    );
    outcome = { kind: 'processing_failed', retryable };
  }

  const response = decideWebhookResponse(outcome);
  res.status(response.status).json(response.body);
}

/**
 * POST /webhooks/stripe
 *
 * Cards. Verified with `constructEvent` against the raw body — behaviour
 * unchanged; only the location moved, onto `StripeGateway.verifyWebhook`.
 */
router.post('/stripe', async (req: Request, res: Response) => {
  await runWebhook('STRIPE', req, res, async (payload) => {
    const event = payload as unknown as Stripe.Event;

    // ── Disputes and full refunds (money pulled back from us) ────────────────
    // A Dispute/Charge object carries the PaymentIntent id but NOT the
    // PaymentIntent's metadata, so the coordinator locates the source
    // order/plan/top-up by that ref. Freeze on open, resume on win, unwind on
    // loss or full refund.
    if (
      event.type === 'charge.dispute.created' ||
      event.type === 'charge.dispute.closed' ||
      event.type === 'charge.refunded'
    ) {
      const obj = event.data.object as {
        id?: string;
        payment_intent?: string;
        status?: string;
        refunded?: boolean;
      };
      const piId = obj.payment_intent;

      if (!piId) {
        return { kind: 'ignored', detail: `${event.type} carried no payment_intent` };
      }
      if (event.type === 'charge.dispute.created') {
        await paymentDisputeService.onDisputeCreated(piId, obj.id ?? null);
      } else if (event.type === 'charge.dispute.closed') {
        // Only act on a definitive outcome; ignore any non-final close status.
        if (obj.status === 'won') await paymentDisputeService.onDisputeClosed(piId, 'won', obj.id ?? null);
        else if (obj.status === 'lost') await paymentDisputeService.onDisputeClosed(piId, 'lost', obj.id ?? null);
        else return { kind: 'ignored', detail: `dispute closed as ${obj.status}` };
      } else if (obj.refunded === true) {
        // Only unwind on a FULL refund. Partial refunds (and the platform's own
        // refund flow) manage their own accounting.
        await paymentDisputeService.onRefunded(piId);
      } else {
        return { kind: 'ignored', detail: `partial charge.refunded for ${piId}` };
      }
      return { kind: 'processed', detail: event.type };
    }

    // ── Billing (plan purchases, credit top-ups) ─────────────────────────────
    // Stripe can route on the PaymentIntent's own metadata, which the mobile
    // gateways have no equivalent of — they settle through the merchant
    // reference instead, in the shared processor below.
    const object = event.data.object as { metadata?: Record<string, string> };
    const purpose = object?.metadata?.purpose;
    const isSucceeded = event.type === 'payment_intent.succeeded';

    if (purpose === 'plan_purchase') {
      if (isSucceeded && object.metadata?.purchaseId) {
        await planPurchaseService.completePurchase(object.metadata.purchaseId);
        return { kind: 'processed', detail: 'plan_purchase' };
      }
      return { kind: 'ignored', detail: `plan_purchase / ${event.type}` };
    }

    if (purpose === 'credit_topup') {
      if (isSucceeded && object.metadata?.topupId) {
        await creditTopupService.completeTopup(object.metadata.topupId);
        return { kind: 'processed', detail: 'credit_topup' };
      }
      return { kind: 'ignored', detail: `credit_topup / ${event.type}` };
    }

    // Orders and bookings.
    return paymentWebhookProcessor.process('STRIPE', getPaymentGateway('STRIPE'), payload);
  });
});

/**
 * POST /webhooks/notchpay
 *
 * Mobile money. HMAC-SHA256 over the raw body against the dashboard's Hash Key,
 * presented in `x-notch-signature`.
 */
router.post('/notchpay', async (req: Request, res: Response) => {
  await runWebhook('NOTCHPAY', req, res, (payload) =>
    paymentWebhookProcessor.process('NOTCHPAY', getPaymentGateway('NOTCHPAY'), payload)
  );
});

/**
 * POST /webhooks/mycoolpay
 *
 * Mobile money. MD5 over six concatenated fields keyed by the private key, plus
 * an `application` check against our public key.
 */
router.post('/mycoolpay', async (req: Request, res: Response) => {
  await runWebhook('MYCOOLPAY', req, res, (payload) =>
    paymentWebhookProcessor.process('MYCOOLPAY', getPaymentGateway('MYCOOLPAY'), payload)
  );
});

export const paymentWebhookRouter = router;
