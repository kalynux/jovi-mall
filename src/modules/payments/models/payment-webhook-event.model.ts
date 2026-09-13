import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PaymentGatewayType } from './payment-transaction.model';

/**
 * Every gateway callback we accepted, keyed so a redelivery cannot be
 * processed twice.
 *
 * ── WHAT THIS REPLACES, AND WHY IT WAS NOT ENOUGH ────────────────────────────
 * Replay protection used to be `PaymentTransaction.gatewayPayloadHash`: a
 * SHA-256 of `JSON.stringify(payload)`, compared against the value stored last
 * time. Three things were wrong with it, and each is a real dropped or
 * duplicated payment:
 *
 * 1. **It is a single slot.** It remembers only the most recent payload, so
 *    `SUCCEEDED -> FAILED -> SUCCEEDED` reprocesses the third delivery. The
 *    fulfilment path is guarded by `previousStatus !== 'SUCCEEDED'` so an
 *    earnings split is not doubled — but that guard is doing work this field
 *    claimed to do.
 * 2. **The field is shared.** `initiatePayment` and `verifyPayment` write it
 *    too, so an unrelated poll can evict the hash that would have caught a
 *    replay.
 * 3. **Hashing the whole body is the wrong key.** Any provider that includes a
 *    timestamp, a delivery attempt counter or a nonce produces a different
 *    hash for the same event, and the replay looks new.
 *
 * The key here is the provider's own event id where one exists (Stripe, and
 * NotchPay when it sends one) and otherwise a digest of the fields that
 * *define* the event — see `deriveEventId`. Stable across a redelivery,
 * distinct across a real transition.
 *
 * ── INSERT-FIRST-WINS ────────────────────────────────────────────────────────
 * The unique index IS the concurrency control. Two simultaneous deliveries of
 * one event both attempt the insert; exactly one succeeds and the other gets a
 * duplicate-key error, which the handler reads as "already handled" rather
 * than as a failure. No read-then-write window, and no transaction needed for
 * it.
 *
 * ── WHY IT EXPIRES ───────────────────────────────────────────────────────────
 * A TTL rather than unbounded growth: a gateway that redelivers an event six
 * weeks later is not a case worth carrying a permanently growing collection
 * for, and the reconciliation sweep bounds itself to 72 hours anyway. 45 days
 * is comfortably past every published retry schedule.
 */

export type WebhookEventOutcome =
  /** Accepted and applied to a transaction or a billing row. */
  | 'processed'
  /** Authentic, but naming nothing we hold — possibly another system's. */
  | 'unknown_transaction'
  /** Authentic, and refused: the reported money disagreed with our snapshot. */
  | 'amount_mismatch'
  /** Authentic, and carrying no status we act on. */
  | 'ignored';

export interface IPaymentWebhookEvent extends Document {
  gateway: PaymentGatewayType;
  /** The provider's event id, or a digest of the fields defining the event. */
  eventId: string;
  eventType: string;
  gatewayRef: string;
  merchantRef: string | null;
  /** The PaymentTransaction this settled, when it settled one. */
  transactionId: mongoose.Types.ObjectId | null;
  outcome: WebhookEventOutcome;
  receivedAt: Date;
}

const PaymentWebhookEventSchema = new Schema<IPaymentWebhookEvent>(
  {
    gateway: {
      type: String,
      enum: ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'],
      required: true,
    },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    gatewayRef: { type: String, required: true, index: true },
    merchantRef: { type: String, default: null, index: true },
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'PaymentTransaction',
      default: null,
      index: true,
    },
    outcome: {
      type: String,
      enum: ['processed', 'unknown_transaction', 'amount_mismatch', 'ignored'],
      required: true,
    },
    receivedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

/**
 * The dedup constraint. Scoped by gateway because two providers may
 * independently mint the same id string, and a collision there would silently
 * drop one of them.
 */
PaymentWebhookEventSchema.index({ gateway: 1, eventId: 1 }, { unique: true });

/**
 * ⚠ `autoIndex` is on and a failed index build fails SILENTLY at boot. Without
 * the dedup index above, the collection still accepts writes and dedup stops
 * working entirely — every redelivery reprocesses. `npm run migrate:payment-indexes`
 * builds both explicitly and reports what it did; run it with the deploy that
 * ships this collection rather than trusting the boot-time build.
 */
PaymentWebhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 45 * 24 * 60 * 60 });

// Both names come from the registry rather than being repeated as literals here. They were
// literals until 2026-09-13, which is why this collection was absent from COLLECTIONS and
// therefore invisible to `inspectDatabase()` — including its `{gateway, eventId}` unique, the
// index webhook dedup depends on entirely. The values are byte-identical; nothing moves.
export const PaymentWebhookEventModel = mongoose.model<IPaymentWebhookEvent>(
  MODELS.PAYMENT_WEBHOOK_EVENT,
  PaymentWebhookEventSchema,
  COLLECTIONS.PAYMENT_WEBHOOK_EVENT
);
