/**
 * A vendor's proposal of a different price on a `manual` appointment — the rules, with no I/O.
 *
 * Plan and owner decisions: `PRODUCTION-READINESS/BOOKING-PRICE-PROPOSAL-PLAN.md`.
 *
 * ── What the fields mean ─────────────────────────────────────────────────────
 * - `priceSnapshot` is the AGREED price. Every charge, earnings split and statement reads it, so
 *   they follow an accepted proposal without knowing proposals exist.
 * - `originalPrice` is the FLOOR: the price the customer booked at. Absent on a booking whose price
 *   has never changed, where the floor is simply `priceSnapshot` (`priceFloorOf`).
 * - `priceTopup` is what is still owed when a paid booking's agreed price went up.
 *
 * Pure, `now` injectable, so `test:price-proposal` can pin every boundary. It imports only a type
 * and the status enum, because `booking-rows.ts` reads it and must stay importable by a bare suite.
 */
import { BookingStatus } from '../types/booking.types';

export const PRICE_PROPOSAL_STATUSES = ['open', 'accepted', 'declined', 'withdrawn', 'lapsed'] as const;
export type PriceProposalStatus = (typeof PRICE_PROPOSAL_STATUSES)[number];

export interface IPriceProposal {
    status: PriceProposalStatus;
    amount: number;
    previousAmount: number;
    proposedAt: Date;
    expiresAt: Date;
    answeredAt: Date | null;
}

export const PRICE_TOPUP_STATUSES = ['due', 'paid', 'superseded'] as const;
export type PriceTopupStatus = (typeof PRICE_TOPUP_STATUSES)[number];

/**
 * What a paid booking still owes after its agreed price went up.
 *
 * `seq` numbers the differences on one booking, and it is part of the payment's idempotency key: a
 * second difference of the same amount must not read as "already paid".
 */
export interface IPriceTopup {
    status: PriceTopupStatus;
    amount: number;
    /** After this the booking is cancelled and what was paid is refunded (owner decision P-2). */
    dueAt: Date;
    seq: number;
    paidAt: Date | null;
    method: 'online' | 'cash' | null;
}

export const PRICE_CHANGE_KINDS = ['approval', 'reschedule'] as const;
export type PriceChangeKind = (typeof PRICE_CHANGE_KINDS)[number];

/** One line per agreed change, so "what did we agree, and when" has an answer. */
export interface IPriceChange {
    from: number;
    to: number;
    at: Date;
    kind: PriceChangeKind;
}

export interface PriceFacts {
    status: BookingStatus | string;
    startAt: Date;
    priceSnapshot: number;
    originalPrice?: number | null;
    requiresPayment: boolean;
    paymentStatus: string;
    priceProposal?: IPriceProposal | null;
    priceTopup?: IPriceTopup | null;
}

/** The lowest price a proposal may name: what the customer booked at. */
export function priceFloorOf(booking: Pick<PriceFacts, 'originalPrice' | 'priceSnapshot'>): number {
    return booking.originalPrice ?? booking.priceSnapshot;
}

/** What is owed now because the agreed price went up. Zero unless a difference is `due`. */
export function outstandingTopup(booking: { priceTopup?: IPriceTopup | null }): number {
    return booking.priceTopup?.status === 'due' ? booking.priceTopup.amount : 0;
}

/**
 * What the customer has actually paid towards the agreed price — the question `priceSnapshot` alone
 * can no longer answer. A booking in a refund or dispute state has paid nothing this rule can count
 * on, and every path here refuses those states first.
 */
export function amountPaidOf(booking: Pick<PriceFacts, 'paymentStatus' | 'priceSnapshot' | 'priceTopup'>): number {
    if (booking.paymentStatus !== 'paid') return 0;
    return Math.max(0, booking.priceSnapshot - outstandingTopup(booking));
}

export type PriceChangeEffect =
    | { kind: 'none' }
    | { kind: 'topup'; amount: number }
    | { kind: 'refund'; amount: number };

/** What moving the agreed price to `newPrice` means for money already paid. */
export function priceChangeEffect(
    booking: Pick<PriceFacts, 'paymentStatus' | 'priceSnapshot' | 'priceTopup'>,
    newPrice: number,
): PriceChangeEffect {
    if (booking.paymentStatus !== 'paid') return { kind: 'none' };
    const difference = newPrice - amountPaidOf(booking);
    if (difference > 0) return { kind: 'topup', amount: difference };
    if (difference < 0) return { kind: 'refund', amount: -difference };
    return { kind: 'none' };
}

/** The payment states a price may move in. A charge in flight, a refund or a dispute must end first. */
const SETTLED_PAYMENT_STATES: readonly string[] = ['unpaid', 'failed', 'paid'];

export function priceMayMoveNow(paymentStatus: string): boolean {
    return SETTLED_PAYMENT_STATES.includes(paymentStatus);
}

export type PriceProposalRefusal =
    | 'not_manual'
    | 'free'
    | 'not_pending'
    | 'started'
    | 'proposal_open'
    | 'payment_state';

/** An `open` proposal past its deadline has lapsed, whether or not anything has written that down. */
export function effectivePriceProposalStatus(
    proposal: Pick<IPriceProposal, 'status' | 'expiresAt'>,
    now: Date = new Date(),
): PriceProposalStatus {
    return proposal.status === 'open' && now.getTime() >= proposal.expiresAt.getTime() ? 'lapsed' : proposal.status;
}

export function hasLivePriceProposal(
    booking: Pick<PriceFacts, 'status' | 'priceProposal'>,
    now: Date = new Date(),
): boolean {
    const proposal = booking.priceProposal;
    return !!proposal && booking.status === BookingStatus.PENDING && effectivePriceProposalStatus(proposal, now) === 'open';
}

/**
 * Why a price cannot be proposed on this booking right now, or null when it can.
 * The amount is judged separately (`priceBelowFloor`), since it needs a different answer.
 */
export function priceProposalRefusal(
    booking: PriceFacts,
    mode: string | null | undefined,
    now: Date = new Date(),
): PriceProposalRefusal | null {
    if (mode !== 'manual') return 'not_manual';
    // Owner decision P-7: a customer who booked something free is never asked to pay for it.
    if (!booking.requiresPayment || booking.priceSnapshot <= 0) return 'free';
    if (booking.status !== BookingStatus.PENDING) return 'not_pending';
    if (booking.startAt.getTime() <= now.getTime()) return 'started';
    if (hasLivePriceProposal(booking, now)) return 'proposal_open';
    if (!priceMayMoveNow(booking.paymentStatus)) return 'payment_state';
    return null;
}

/**
 * Whether a price is under the floor. On an approval it must be strictly above: the floor itself is
 * not a proposal, it is what the vendor gets by simply confirming. On a reschedule the floor itself
 * is allowed, since an agreed 7,000 may legitimately come back down to the 5,000 booked.
 */
export function priceBelowFloor(
    booking: Pick<PriceFacts, 'originalPrice' | 'priceSnapshot'>,
    amount: number,
    kind: PriceChangeKind,
): boolean {
    const floor = priceFloorOf(booking);
    return kind === 'approval' ? amount <= floor : amount < floor;
}

/**
 * The final price of a manual appointment at completion (owner decision P-4): the agreed price, plus
 * what the extra time cost. Catalog prices are compared with each other and never with the agreed
 * price, because the agreed price is not a catalog price. It can never come out below the agreed one.
 */
export function manualFinalPrice(agreedPrice: number, catalogPriceOfTimeUsed: number, catalogPriceOfTimeBooked: number): number {
    return agreedPrice + Math.max(0, catalogPriceOfTimeUsed - catalogPriceOfTimeBooked);
}

export interface PricingView {
    originalPrice: number;
    currentPrice: number;
    amountPaid: number;
    proposal: (Omit<IPriceProposal, 'status'> & { status: PriceProposalStatus }) | null;
    topup: { amount: number; dueAt: Date } | null;
}

/** What a booking read says about its price. One function, so the two sides cannot disagree. */
export function pricingView(booking: PriceFacts, now: Date = new Date()): PricingView {
    const proposal = booking.priceProposal;
    return {
        originalPrice: priceFloorOf(booking),
        currentPrice: booking.priceSnapshot,
        amountPaid: amountPaidOf(booking),
        proposal: proposal
            ? {
                status: effectivePriceProposalStatus(proposal, now),
                amount: proposal.amount,
                previousAmount: proposal.previousAmount,
                proposedAt: proposal.proposedAt,
                expiresAt: proposal.expiresAt,
                answeredAt: proposal.answeredAt ?? null,
            }
            : null,
        // A cancelled booking owes nothing, whatever was due when it was cancelled.
        topup: booking.priceTopup?.status === 'due' && booking.status !== BookingStatus.CANCELLED
            ? { amount: booking.priceTopup.amount, dueAt: booking.priceTopup.dueAt }
            : null,
    };
}

/** The vendor's read: the same block, and whether a proposal may be made now. */
export function vendorPricingView(
    booking: PriceFacts,
    mode: string | null | undefined,
    now: Date = new Date(),
): PricingView & { canPropose: boolean } {
    return { ...pricingView(booking, now), canPropose: priceProposalRefusal(booking, mode, now) === null };
}

/**
 * What the sweep cancels. Pure, for `test:price-proposal`; `UnpaidBookingCancelWorker` runs it.
 *
 * - An unpaid booking whose grace ran out, counted from its CONFIRMATION (`paymentDueFrom`). Counted
 *   from creation, as it used to be, a booking the vendor took over a day to accept was cancelled on
 *   the next sweep, minutes after they accepted it. A booking with no `paymentDueFrom` was confirmed
 *   when it was created, so `createdAt` is the same moment.
 * - A paid booking whose agreed price went up and whose difference was not paid in time (owner
 *   decision P-2).
 */
export function unpaidSweepFilter(now: Date, cutoff: Date): Record<string, unknown> {
  return {
    // Confirmed only — see the class docstring on why `pending` is excluded.
    status: BookingStatus.CONFIRMED,
    deletedAt: null,
    $or: [
      {
        requiresPayment: true,
        // 'pending' means a gateway call is in flight; leave it to resolve.
        paymentStatus: { $in: ['unpaid', 'failed'] },
        $or: [
          { paymentDueFrom: { $lte: cutoff } },
          { paymentDueFrom: null, createdAt: { $lte: cutoff } },
        ],
      },
      { 'priceTopup.status': 'due', 'priceTopup.dueAt': { $lte: now } },
    ],
  };
}
