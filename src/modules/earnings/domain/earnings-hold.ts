/**
 * The earnings hold: when an order's or booking's money starts maturing, when it may be
 * paused, and how a pause changes the release date. Pure — no I/O, no clock — so every
 * rule here is asserted by `test:earnings-hold` without a database.
 *
 * ── The hold starts at DELIVERY, not at completion (owner decision, 2026-10-05) ──
 * It used to start when the ORDER completed: the customer confirmed, or the auto-confirm
 * sweep did it for them days later. Money therefore waited for delivery + confirmation
 * window + hold, up to about two weeks. It now starts the moment the courier finishes the
 * LAST parcel of the order (`Order.delivered_at`), and every actor on the order still
 * matures on that one date. Completion survives as the order's own status and as a
 * backstop: an allocation it finds unstamped is started then.
 *
 * ── A pause stops the clock; it does not reset it ───────────────────────────────
 * "Paused until an administrator unpauses it, then it continues counting its held
 * duration" (owner, 2026-10-05). So on resume, the release date moves later by exactly
 * the time the money spent paused INSIDE its hold window — see `resumedHoldReleaseAt`.
 */

/** Why an order's or booking's earnings were paused. Closed set: each has a writer. */
export const EARNINGS_PAUSE_REASONS = [
  /** The seller cancelled an order the customer had already paid. A refund ticket is opened. */
  'seller_cancelled_paid_order',
  /** A paid booking was cancelled from the seller's status menu, which refunds nothing. */
  'booking_cancelled_unrefunded',
  /** The customer disputed the card payment with their bank. Resumes on its own if won. */
  'card_dispute',
  /** An administrator paused it by hand. */
  'admin',
] as const;
export type EarningsPauseReason = (typeof EARNINGS_PAUSE_REASONS)[number];

/** Reasons a system event may lift by itself. Every other pause waits for an administrator. */
export const SELF_RESUMING_PAUSE_REASONS: readonly EarningsPauseReason[] = ['card_dispute'];

/** The pause record kept on an order or a booking. `active: false` once resumed. */
export interface EarningsPauseRecord {
  active: boolean;
  reason: EarningsPauseReason | null;
  note: string | null;
  paused_at: Date | null;
  resumed_at: Date | null;
}

/** The two dates on an allocation that the hold arithmetic reads. */
export interface HoldWindow {
  /** When this row's hold started (delivery, or completion for bookings). Null: not started. */
  completed_at: Date | null;
  /** When it may be released. Null while the hold has not started. */
  hold_release_at: Date | null;
}

/**
 * The release date of a held row after a pause that began at `pausedAt` ends at `now`.
 *
 * Only the paused time that fell INSIDE the row's hold window counts, because only that
 * time was "lost" from the countdown:
 *  - hold not started yet (`completed_at` null) → nothing to move; it starts normally later;
 *  - hold started BEFORE the pause → moved by the whole pause (`now - pausedAt`);
 *  - hold started DURING the pause (a parcel delivered while paused) → moved by the part
 *    after it started (`now - completed_at`), so the full hold runs from the resume.
 *
 * Never earlier than the date it already had, and never negative time: a clock that ran
 * backwards would only ever release money early.
 */
export function resumedHoldReleaseAt(row: HoldWindow, pausedAt: Date, now: Date): Date | null {
  if (!row.completed_at || !row.hold_release_at) return row.hold_release_at;
  const clockStoppedAt = Math.max(pausedAt.getTime(), row.completed_at.getTime());
  const lostMs = Math.max(0, now.getTime() - clockStoppedAt);
  return new Date(row.hold_release_at.getTime() + lostMs);
}

/** `start + days`, the release date of a hold that starts at `start`. */
export function holdReleaseFrom(start: Date, holdDays: number): Date {
  return new Date(start.getTime() + holdDays * 24 * 60 * 60 * 1000);
}

/**
 * Shipment statuses at which the COURIER has finished with a parcel, by payment method.
 *
 * Prepaid: `agent_delivered` is the courier handing the parcel over — the delivery the
 * owner means. COD: `agent_delivered` only means "arrived, waiting for the customer's
 * code"; the parcel is delivered when the code is entered, which moves it to `delivered`.
 * `returned` ends a parcel's journey either way.
 */
export const COURIER_FINISHED_STATUSES = {
  prepaid: ['agent_delivered', 'delivered', 'returned'] as readonly string[],
  cod: ['delivered', 'returned'] as readonly string[],
};

/**
 * Has the courier finished with every parcel of this order?
 *
 * An order with no shipments is not finished (a physical order always has at least one
 * once paid; zero means "not dispatched yet", never "nothing to deliver").
 */
export function isCourierFinished(shipmentStatuses: readonly string[], isCod: boolean): boolean {
  if (shipmentStatuses.length === 0) return false;
  const done = isCod ? COURIER_FINISHED_STATUSES.cod : COURIER_FINISHED_STATUSES.prepaid;
  return shipmentStatuses.every((s) => done.includes(s));
}

/**
 * The date an order counts as delivered, for BOTH questions that depend on it:
 *  - when its money starts maturing (a split creating a row for an order that is already
 *    delivered must inherit it, or the row sits held forever);
 *  - when the customer's return window starts — the owner's decision, and what the published
 *    Returns policy promises ("within 14 days of receiving it").
 *
 * `delivered_at` first; an order completed before that field existed falls back to its
 * completion date. `null` means not delivered yet: the hold has not started, and the return
 * window has not started, so a refund before delivery (a cancelled paid order) is never
 * "too late".
 */
export function deliveredAtOf(order: {
  delivered_at?: Date | null;
  completion?: { confirmed_at?: Date | null } | null;
}): Date | null {
  return order.delivered_at ?? order.completion?.confirmed_at ?? null;
}
