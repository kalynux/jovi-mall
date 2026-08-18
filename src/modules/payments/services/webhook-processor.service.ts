import { PaymentGateway } from '../gateways/gateway.interface';
import { NormalizedWebhookEvent } from '../domain/webhook-verification';
import { WebhookOutcome } from '../domain/webhook-response';
import { merchantRefKind } from '../domain/merchant-reference';
import { PaymentWebhookEventModel, WebhookEventOutcome } from '../models/payment-webhook-event.model';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { PaymentOrchestratorService } from './payment-orchestrator.service';
import { planPurchaseService } from '../../billing/services/plan-purchase.service';
import { creditTopupService } from '../../billing/services/credit-topup.service';

/**
 * What happens to a callback after its signature passes.
 *
 * Three responsibilities, in this order, and the order is the design:
 *
 *   1. **Claim the event id.** The unique index on
 *      `(gateway, eventId)` is the concurrency control — insert-first-wins, so
 *      two simultaneous deliveries of one event cannot both proceed and there
 *      is no read-then-write window to lose.
 *   2. **Route by what the reference points at.** A `PaymentTransaction`, a
 *      plan purchase or a credit top-up. The last two create no
 *      `PaymentTransaction` at all, which is why a mobile-money billing
 *      callback used to reach an orchestrator that looked its reference up in
 *      `payment_transaction`, found nothing, and answered success — leaving
 *      client polling as the only way a vendor ever got the plan they paid for.
 *   3. **Record the verdict**, so "did that callback arrive, and what did we do
 *      with it" is answerable from the database rather than from log grep.
 *
 * The prefix on a merchant reference is a routing HINT and never an
 * authorisation: each branch still resolves the row, and a forged `jm_pp_…`
 * finds no purchase and settles nothing.
 */
export class PaymentWebhookProcessor {
  constructor(private readonly orchestrator = new PaymentOrchestratorService()) {}

  async process(
    gateway: PaymentGatewayType,
    adapter: PaymentGateway,
    payload: Record<string, unknown>
  ): Promise<WebhookOutcome> {
    const event = adapter.parseWebhookEvent(payload);
    if (!event) {
      return { kind: 'ignored', detail: 'no actionable reference in payload' };
    }

    // Claim first. If this throws a duplicate-key error the event has already
    // been handled — by a previous delivery or by a concurrent one — and the
    // honest answer is "duplicate", not a second application of it.
    const claimed = await this.claim(gateway, event);
    if (!claimed) return { kind: 'duplicate' };

    try {
      const outcome = await this.route(gateway, event);
      await this.recordOutcome(gateway, event, outcome);
      return outcome;
    } catch (error) {
      // The claim would otherwise suppress the gateway's retry: the row exists,
      // so the redelivery that could have healed this reads as a duplicate and
      // is acknowledged. Releasing it is what keeps the retry meaningful.
      await this.releaseClaim(gateway, event);
      throw error;
    }
  }

  /**
   * Insert the dedup row. Returns false when this event id is already present.
   *
   * Written with `processed` as a placeholder outcome and corrected afterwards
   * — the row exists to hold the *key*, and the key must be claimed before any
   * work begins or two deliveries race through the routing below.
   */
  private async claim(gateway: PaymentGatewayType, event: NormalizedWebhookEvent): Promise<boolean> {
    try {
      await PaymentWebhookEventModel.create({
        gateway,
        eventId: event.eventId,
        eventType: event.eventType,
        gatewayRef: event.gatewayRef,
        merchantRef: event.merchantRef,
        outcome: 'ignored',
        receivedAt: new Date(),
      });
      return true;
    } catch (error: any) {
      // 11000 = duplicate key. Anything else is a real database fault and must
      // surface, so the route answers 5xx and the gateway retries.
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  private async releaseClaim(
    gateway: PaymentGatewayType,
    event: NormalizedWebhookEvent
  ): Promise<void> {
    try {
      await PaymentWebhookEventModel.deleteOne({ gateway, eventId: event.eventId });
    } catch {
      /* best effort — the TTL sweeps it either way */
    }
  }

  private async recordOutcome(
    gateway: PaymentGatewayType,
    event: NormalizedWebhookEvent,
    outcome: WebhookOutcome
  ): Promise<void> {
    const mapped: WebhookEventOutcome =
      outcome.kind === 'processed'
        ? 'processed'
        : outcome.kind === 'unknown_transaction'
          ? 'unknown_transaction'
          : outcome.kind === 'amount_mismatch'
            ? 'amount_mismatch'
            : 'ignored';
    try {
      await PaymentWebhookEventModel.updateOne(
        { gateway, eventId: event.eventId },
        { $set: { outcome: mapped } }
      );
    } catch {
      /* the verdict is a record, not a control — never fail the callback over it */
    }
  }

  /**
   * Send the event to whichever subsystem owns the row it names.
   *
   * The kind hint decides which lookup runs FIRST, not which one is allowed:
   * an unprefixed reference (every row written before `merchant_ref` existed)
   * still finds its way home by falling through all three.
   */
  private async route(
    gateway: PaymentGatewayType,
    event: NormalizedWebhookEvent
  ): Promise<WebhookOutcome> {
    const kind = merchantRefKind(event.merchantRef);

    if (kind === 'pp') {
      const settled = await this.settlePlanPurchase(event);
      if (settled) return settled;
    }
    if (kind === 'ct') {
      const settled = await this.settleCreditTopup(event);
      if (settled) return settled;
    }

    const outcome = await this.orchestrator.applyWebhookEvent(gateway, event);
    if (outcome.kind !== 'unknown_transaction') return outcome;

    // No PaymentTransaction. Before concluding the event is somebody else's,
    // try the two billing collections — an unprefixed legacy reference lands
    // here, and so does a Stripe callback whose metadata carried no
    // merchantRef.
    return (
      (await this.settlePlanPurchase(event)) ??
      (await this.settleCreditTopup(event)) ?? { kind: 'unknown_transaction' }
    );
  }

  private async settlePlanPurchase(event: NormalizedWebhookEvent): Promise<WebhookOutcome | null> {
    const purchase = await planPurchaseService.findByReference(event.merchantRef, event.gatewayRef);
    if (!purchase) return null;

    if (event.status === 'SUCCEEDED') {
      // `completePurchase` claims `pending → paid` atomically, so a webhook
      // racing a verify poll applies the plan exactly once.
      await planPurchaseService.completePurchase(purchase._id.toString());
      return { kind: 'processed', detail: `plan purchase ${purchase._id} paid` };
    }
    if (event.status === 'FAILED' || event.status === 'CANCELLED') {
      await planPurchaseService.failPurchase(purchase._id.toString());
      return { kind: 'processed', detail: `plan purchase ${purchase._id} failed` };
    }
    return { kind: 'ignored', detail: `plan purchase ${purchase._id} still ${event.status}` };
  }

  private async settleCreditTopup(event: NormalizedWebhookEvent): Promise<WebhookOutcome | null> {
    const topup = await creditTopupService.findByReference(event.merchantRef, event.gatewayRef);
    if (!topup) return null;

    if (event.status === 'SUCCEEDED') {
      await creditTopupService.completeTopup(topup._id.toString());
      return { kind: 'processed', detail: `credit top-up ${topup._id} paid` };
    }
    if (event.status === 'FAILED' || event.status === 'CANCELLED') {
      await creditTopupService.failTopup(topup._id.toString());
      return { kind: 'processed', detail: `credit top-up ${topup._id} failed` };
    }
    return { kind: 'ignored', detail: `credit top-up ${topup._id} still ${event.status}` };
  }
}

export const paymentWebhookProcessor = new PaymentWebhookProcessor();
