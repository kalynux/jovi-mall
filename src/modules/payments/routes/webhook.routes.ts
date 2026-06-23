import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { getStripeClient } from '../gateways/stripe.client';
import { planPurchaseService } from '../../billing/services/plan-purchase.service';
import { creditTopupService } from '../../billing/services/credit-topup.service';

const router = Router();
const paymentOrchestrator = new PaymentOrchestratorService();

/**
 * POST /webhooks/stripe
 * 
 * Stripe webhook endpoint
 * 
 * IDEMPOTENT: Payload hash prevents duplicate processing
 * SECURITY: Verifies Stripe signature
 * 
 * Stripe sends webhooks for events:
 * - payment_intent.succeeded
 * - payment_intent.payment_failed
 * - payment_intent.canceled
 * - etc.
 */
router.post('/stripe', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string | undefined;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Verify the signature against the RAW body (express.raw mounted in app.ts).
  // Reject (4xx) on bad/missing signature so Stripe retries rather than us
  // silently dropping the event.
  let event: Stripe.Event;
  try {
    if (!webhookSecret) {
      console.error('[StripeWebhook] STRIPE_WEBHOOK_SECRET is not configured');
      res.status(400).send('Webhook secret not configured');
      return;
    }
    if (!signature) {
      res.status(400).send('Missing stripe-signature header');
      return;
    }
    event = getStripeClient().webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err: any) {
    console.error('[StripeWebhook] Signature verification failed:', err?.message ?? err);
    res.status(400).send(`Webhook signature verification failed: ${err?.message ?? 'invalid'}`);
    return;
  }

  try {
    console.log('[StripeWebhook] Verified event:', event.type, event.id);

    const object = event.data.object as { metadata?: Record<string, string> };
    const purpose = object?.metadata?.purpose;
    const isSucceeded = event.type === 'payment_intent.succeeded';

    // Billing flows (plan purchases, credit top-ups) don't create
    // PaymentTransactions — route them by metadata.purpose. Both completion
    // methods are idempotent, so duplicate deliveries are safe.
    if (purpose === 'plan_purchase') {
      if (isSucceeded && object.metadata?.purchaseId) {
        await planPurchaseService.completePurchase(object.metadata.purchaseId);
      }
      res.status(200).json({ success: true, handled: purpose, type: event.type });
      return;
    }

    if (purpose === 'credit_topup') {
      if (isSucceeded && object.metadata?.topupId) {
        await creditTopupService.completeTopup(object.metadata.topupId);
      }
      res.status(200).json({ success: true, handled: purpose, type: event.type });
      return;
    }

    // Orders & bookings: the orchestrator dedups by payload hash and updates the
    // PaymentTransaction looked up via the PaymentIntent id (gatewayRef).
    const result = await paymentOrchestrator.handleWebhook('STRIPE', event, signature);
    res.status(200).json(result);
  } catch (error: any) {
    console.error('[StripeWebhook] Processing error:', error?.message ?? error);
    // Signature already verified — return 200 so Stripe doesn't retry a
    // poison event indefinitely; the verify/poll path remains a safety net.
    res.status(200).json({
      success: false,
      message: 'Webhook verified but processing failed'
    });
  }
});

/**
 * POST /webhooks/notchpay
 * 
 * NotchPay webhook endpoint
 * 
 * IDEMPOTENT: Payload hash prevents duplicate processing
 * SECURITY: Should verify NotchPay signature if supported
 */
router.post('/notchpay', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const signature = req.headers['x-notchpay-signature'] as string;

    // TODO: Verify NotchPay signature if available
    // const webhookSecret = process.env.NOTCHPAY_WEBHOOK_SECRET;

    console.log('[NotchPayWebhook] Received event:', payload.event || payload.status);

    // Process webhook
    const result = await paymentOrchestrator.handleWebhook(
      'NOTCHPAY',
      payload,
      signature
    );

    // Always return 200 to prevent retries
    res.status(200).json(result);

  } catch (error: any) {
    console.error('[NotchPayWebhook] Processing error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed'
    });
  }
});

/**
 * POST /webhooks/mycoolpay
 * 
 * MyCoolPay webhook endpoint
 * 
 * IDEMPOTENT: Payload hash prevents duplicate processing
 * SECURITY: Should verify MyCoolPay signature if supported
 */
router.post('/mycoolpay', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const signature = req.headers['x-mycoolpay-signature'] as string;

    // TODO: Verify MyCoolPay signature if available
    // const webhookSecret = process.env.MYCOOLPAY_WEBHOOK_SECRET;

    console.log('[MyCoolPayWebhook] Received event:', payload.event);

    // Process webhook
    const result = await paymentOrchestrator.handleWebhook(
      'MYCOOLPAY',
      payload,
      signature
    );

    // Always return 200 to prevent retries
    res.status(200).json(result);

  } catch (error: any) {
    console.error('[MyCoolPayWebhook] Processing error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed'
    });
  }
});

export const paymentWebhookRouter = router;
