import { PaymentGateway } from '../gateways/gateway.interface';
import { NormalizedWebhookEvent } from '../domain/webhook-verification';
import { WebhookOutcome } from '../domain/webhook-response';
import { merchantRefKind } from '../domain/merchant-reference';
import { PaymentWebhookEventModel, WebhookEventOutcome } from '../models/payment-webhook-event.model';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { PaymentOrchestratorService } from './payment-orchestrator.service';
import { planPurchaseService } from '../../billing/services/plan-purchase.service';
import { creditTopupService } from '../../billing/services/credit-topup.service';
import { payoutRequestService } from '../../earnings/services/payout-request.service';
import { storedPayoutGateway } from '../../earnings/domain/payout-gateway';
import { refundRequestService } from './refund-request.service';

/**
 * What happens to a callback after its signature passes.
 *
 * Three responsibilities, in this order, and the order is the design — preceded, for an adapter
 * whose signature does not cover the body, by **confirming the event against the provider's own
 * record** (`confirmWebhookEvent`, ADR-A08 P2.0). The confirmed event, not the parsed body, is
 * what gets claimed and routed.
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
 *
 * ⛔ **DIRECTION IS CHECKED BEFORE ANY OF THAT, and it is not a hint.** Since the platform
 * also sends money, a callback is either about money arriving or money leaving, and the two
 * must never be routed into each other. The hazard is specifically the fall-through in
 * `route()`: it exists so an unprefixed legacy reference still finds its way home, and
 * without a direction check it would equally hand a `transfer.*` event to the order
 * orchestrator — which could then settle an order off the back of money the platform paid
 * OUT. So a payout event may only ever reach the payout branch, a collection event may never
 * reach it, and neither falls through to the other.
 */
export class PaymentWebhookProcessor {
  constructor(private readonly orchestrator = new PaymentOrchestratorService()) {}

  async process(
    gateway: PaymentGatewayType,
    adapter: PaymentGateway,
    payload: Record<string, unknown>
  ): Promise<WebhookOutcome> {
    const parsed = adapter.parseWebhookEvent(payload);
    if (!parsed) {
      return { kind: 'ignored', detail: 'no actionable reference in payload' };
    }

    // Confirm against the provider's own record BEFORE the claim (ADR-A08 P2.0), for an adapter
    // whose signature does not cover the body. An unconfirmed event claims nothing, so the
    // genuine callback that may follow is not suppressed as a duplicate. A throw propagates:
    // the route answers 5xx, the provider retries, and the reconciliation sweep backstops.
    let event: NormalizedWebhookEvent = parsed;
    if (typeof adapter.confirmWebhookEvent === 'function') {
      const confirmed = await adapter.confirmWebhookEvent(parsed);
      if (!confirmed) {
        return { kind: 'ignored', detail: "the gateway's own record did not confirm this callback" };
      }
      // The provider's record is what counts, but it must be about the SAME money: a
      // confirmation naming another reference or the other direction is a contradiction.
      if (confirmed.merchantRef !== parsed.merchantRef || confirmed.direction !== parsed.direction) {
        return { kind: 'ignored', detail: 'the confirmation names different money than the callback' };
      }
      event = confirmed;
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

    /**
     * Money OUT. Terminates here in every case — there is deliberately no fall-through to
     * the collection branches below, even when the payout cannot be found. An unresolvable
     * payout callback is `unknown_transaction`, which the gateway is told about with a 200
     * and which shows up on the webhook-event record; it is never an invitation to go
     * looking for an order with the same reference.
     */
    if (event.direction === 'payout') {
      // The PREFIX decides which money-out record owns it (REFUND-FLOW-PLAN § 3.3) — `rf` is a
      // refund sent as a transfer, everything else stays on the payout path exactly as before.
      // No fall-through between the two: an `rf` reference that matches no refund is unknown.
      if (kind === 'rf') return this.settleRefund(event, gateway);
      return this.settlePayout(event, gateway);
    }

    /**
     * Money IN, and a `po` / `rf` reference on this path is a contradiction: our own money-out
     * reference echoed back by an event that does not describe a transfer. Most likely a
     * provider quirk or a replayed body; possibly someone probing. Either way the safe read
     * is that we do not know what it is, and nothing below should try to guess.
     */
    if (kind === 'rf') {
      return {
        kind: 'ignored',
        detail: 'a refund reference arrived on a collection event — refusing to route it',
      };
    }
    if (kind === 'po') {
      return {
        kind: 'ignored',
        detail: 'a payout reference arrived on a collection event — refusing to route it',
      };
    }

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

  /**
   * Apply a transfer verdict to the payout it names.
   *
   * ⚠ **Resolved by OUR reference only — never by the gateway's.** For a collection the
   * orchestrator falls back to `gatewayRef` because older rows predate `merchant_ref`. No
   * payout predates it: the reference is minted in the same atomic claim that moves the row
   * to `processing`, so a payout that has been sent always has one. Accepting a gateway id
   * as an alternative key would add a second way to address a money-out record for no
   * benefit.
   *
   * `PENDING` is explicitly not terminal — NotchPay reports `sent` and `processing` on the
   * way to a verdict, and acting on either would settle a payout that is still moving.
   *
   * ⚠ **The callback must arrive on the route of the gateway the payout was SENT through**
   * (ADR-A08). The reference alone does not say which gateway may speak for it, and after an
   * administrator switches the payout aggregator two gateways can be live at once. A verified
   * callback from one naming a payout sent through the other is refused as `ignored` rather
   * than allowed to settle or fail it. A payout with no stored gateway was sent before the
   * field existed, which means through NotchPay. The settings are never read here: after a
   * switch, a payout still settles through the gateway that sent it.
   *
   * `routeGateway` is optional so the check can only ever narrow; the dedup claim above is keyed
   * on the route gateway and is unchanged.
   */
  private async settlePayout(
    event: NormalizedWebhookEvent,
    routeGateway?: PaymentGatewayType
  ): Promise<WebhookOutcome> {
    if (!event.merchantRef) {
      return { kind: 'unknown_transaction' };
    }

    const payout = await payoutRequestService.getByTransferReference(event.merchantRef);
    if (!payout) {
      return { kind: 'unknown_transaction' };
    }

    if (routeGateway && storedPayoutGateway(payout) !== routeGateway) {
      return {
        kind: 'ignored',
        detail: `payout ${payout.id} was not sent through ${routeGateway}; refusing its callback`,
      };
    }

    if (event.status === 'PENDING') {
      return { kind: 'ignored', detail: `payout ${payout.id} transfer still ${event.eventType}` };
    }

    const applied = await payoutRequestService.applyTransferOutcome(payout.id, {
      settled: event.status === 'SUCCEEDED',
      gatewayRef: event.gatewayRef || null,
      reason: event.status === 'SUCCEEDED' ? null : `gateway reported ${event.eventType}`,
    });

    // Null means the payout was not `processing` when the write landed — already settled by
    // a previous delivery. Idempotent by construction.
    if (!applied) {
      return { kind: 'ignored', detail: `payout ${payout.id} was already resolved` };
    }

    return { kind: 'processed', detail: `payout ${applied.id} ${applied.status}` };
  }

  /**
   * Apply a transfer verdict to the REFUND whose leg our `jm_rf_` reference names (R3).
   *
   * The same three rules as `settlePayout`: resolved by OUR reference only; `PENDING` is not a
   * verdict; and the callback must arrive on the route of the gateway the refund was SENT
   * through (`transfer_gateway`, fixed at the claim) — after an administrator switches the
   * payout aggregator two gateways can be live at once, and one may not speak for the other's
   * transfer. A refund always has its gateway stamped (unlike legacy payouts), so a missing
   * one is refused rather than defaulted.
   */
  private async settleRefund(
    event: NormalizedWebhookEvent,
    routeGateway: PaymentGatewayType
  ): Promise<WebhookOutcome> {
    if (!event.merchantRef) return { kind: 'unknown_transaction' };

    const refund = await refundRequestService.getByTransferReference(event.merchantRef);
    if (!refund) return { kind: 'unknown_transaction' };

    if (refund.transfer_gateway !== routeGateway) {
      return {
        kind: 'ignored',
        detail: `refund ${refund.id} was not sent through ${routeGateway}; refusing its callback`,
      };
    }

    if (event.status === 'PENDING') {
      return { kind: 'ignored', detail: `refund ${refund.id} transfer still ${event.eventType}` };
    }

    const applied = await refundRequestService.applyTransferOutcome(event.merchantRef, {
      settled: event.status === 'SUCCEEDED',
      gatewayRef: event.gatewayRef || null,
      reason: event.status === 'SUCCEEDED' ? null : `gateway reported ${event.eventType}`,
    });
    if (!applied) {
      return { kind: 'ignored', detail: `refund ${refund.id} transfer was already resolved` };
    }
    return { kind: 'processed', detail: `refund ${applied.id} ${applied.status}` };
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
