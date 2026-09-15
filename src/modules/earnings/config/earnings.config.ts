/**
 * Earnings (commission, escrow & release) configuration.
 *
 * Central, env-overridable knobs for the earnings ledger. Mirrors the
 * module-config pattern used by `src/config/file-cleanup.config.ts`.
 *
 * Money values are integers in minor currency units (same convention as
 * `order.total_amount`).
 */

const DAY = 86_400_000;

/** Parse a non-negative integer env var, falling back to `fallback`. */
function intEnv(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export const EARNINGS_CONFIG = {
  /** Default currency for newly-created accounts/allocations. */
  DEFAULT_CURRENCY: (process.env.EARNINGS_CURRENCY || 'XAF').toUpperCase(),

  /**
   * Days held AFTER an order/booking is completed before funds move from
   * `pending_balance` to `available_balance`. Per spec: 7 days.
   */
  HOLD_DAYS: intEnv('EARNINGS_HOLD_DAYS', 7),

  /**
   * Days a `delivered`/`fulfilled` order may sit without a customer confirmation
   * before the system auto-confirms it (which then starts the HOLD_DAYS window).
   */
  AUTO_CONFIRM_DAYS: intEnv('EARNINGS_AUTO_CONFIRM_DAYS', 7),

  /**
   * The customer's dispute window on ONE shipment: days an `agent_delivered`
   * shipment may sit unconfirmed before the sweep confirms it on their behalf.
   *
   * This is the per-shipment analogue of AUTO_CONFIRM_DAYS, and the system is
   * unpayable without it — `agent_delivered → delivered` is otherwise triggered
   * only by the customer clicking confirm, so one silent customer freezes the
   * whole order's escrow for every actor, forever. AUTO_CONFIRM_DAYS cannot
   * cover it: it only looks at orders whose fulfilment already reached
   * `delivered`, which requires every shipment to have been confirmed already.
   *
   * COD shipments DO land in `agent_delivered` (an agent signals arrival before
   * asking for the code), but they are not confirmed the prepaid way: the sweep
   * routes them through `CashCollectionService.autoCollectWithoutCode`, which
   * records the cash and delivers in one transaction. See
   * `ShipmentService.autoConfirmStaleDeliveries` for why skipping the collection
   * would leave an order nobody is ever paid for.
   */
  SHIPMENT_AUTO_CONFIRM_DAYS: intEnv('EARNINGS_SHIPMENT_AUTO_CONFIRM_DAYS', 7),

  /**
   * Defensive fallback fee (minor units) used ONLY when a shipment's agency
   * has no `policies` configured yet — should not occur in practice, since
   * agency onboarding Step 4 (policy setup) is required and only
   * fully-onboarded agencies are selectable by vendors. The real per-shipment
   * fee is computed from the agency's own `policies.pricing`
   * (see EarningsSplitService.computeAgencyDeliveryFees). Defaults to 0 —
   * charge nothing rather than a fabricated number.
   */
  DELIVERY_FLAT_FEE: intEnv('EARNINGS_DELIVERY_FLAT_FEE', 0),

  /** Cron expression for the daily release / auto-confirm sweep. */
  CRON: process.env.EARNINGS_CRON || '0 1 * * *',

  /** Max allocations/orders processed per sweep stage (back-pressure). */
  BATCH_SIZE: intEnv('EARNINGS_BATCH_SIZE', 200),

  /**
   * Minimum `available_balance` a vendor/agency may request a payout for
   * (manual or auto-triggered). Below this, both `POST .../earnings/payout`
   * and the auto-threshold sweep refuse with EARNINGS_PAYOUT_BELOW_MINIMUM.
   */
  MIN_PAYOUT_AMOUNT: intEnv('EARNINGS_MIN_PAYOUT_AMOUNT', 10_000),

  /**
   * `available_balance` level at which the platform automatically opens a
   * payout request on the owner's behalf (same ticket/notification flow as a
   * manual request), so balances never grow unbounded into money the platform
   * owes. Checked daily by EarningsReleaseWorker. Applies to vendors, agencies
   * and agents alike — an agent earns a cut of the delivery fee on every run,
   * COD or online-paid.
   */
  AUTO_PAYOUT_THRESHOLD: intEnv('EARNINGS_AUTO_PAYOUT_THRESHOLD', 2_000_000),

  /**
   * The most an owner whose KYC is NOT verified may take out in one manual payout.
   * Anything above it stays in `available_balance` and waits for verification.
   *
   * ⚠ **`0` MEANS NO CAP, AND IT IS THE DEFAULT — the feature is inert until you set a
   * number.** That is deliberate for a money path: shipping a live default would start
   * refusing part of every unverified owner's payout on the deploy that carried it, with no
   * operator having chosen the number. An inert default makes turning it on a decision
   * somebody makes, on a date, with a figure they picked.
   *
   * ⚠ **It caps, it does not refuse.** The owner is still paid up to this amount; only the
   * excess waits. The alternative — refusing the whole request — punishes earning: the more
   * an unverified owner sells, the less of their own money they could touch.
   *
   * ⚠ **Setting it BELOW `MIN_PAYOUT_AMOUNT` silently blocks unverified payouts entirely**,
   * because the capped amount then fails the floor check. That is a real configuration
   * foot-gun, so the refusal names the cap as the cause rather than reporting a bare
   * "below minimum" the owner cannot act on. Keep it comfortably above the floor.
   *
   * ⚠ **The auto-threshold sweep is EXEMPT.** `AUTO_PAYOUT_THRESHOLD` exists so the platform
   * never owes an unbounded amount; applying the cap there would leave it owing *more* to
   * precisely the least-vetted accounts, and the nightly request would fail forever with
   * nothing opened to track the exposure. Those requests still reach a human, and the ticket
   * now states the KYC verdict.
   */
  UNVERIFIED_PAYOUT_CAP: intEnv('EARNINGS_UNVERIFIED_PAYOUT_CAP', 0),

  /**
   * The length of the rolling window the cap above is measured over, in days.
   *
   * ⚠ **The cap is an ALLOWANCE PER WINDOW, not a per-request ceiling, and the difference is
   * the whole point.** A per-request ceiling bounds one approval and nothing else: only one
   * payout may be *pending* at a time, but the moment an administrator marks it paid the
   * owner may open another. At a 20,000 cap an unverified owner with 200,000 available simply
   * requests ten times and takes the lot.
   *
   * ⚠ **ROLLING, not calendar.** A calendar month resets on the 1st, so the 31st plus the 1st
   * lets twice the cap leave inside 48 hours — precisely the burst a risk cap exists to stop.
   * A trailing window bounds any N-day stretch and has no boundary to wait for.
   *
   * ⚠ **Only `paid` requests count, windowed on `resolved_at`.** A *rejected* request returned
   * the money to `available_balance`, so counting it would charge the owner for an
   * administrator's decision. `resolved_at` rather than `created_at` because the question is
   * when money actually left — a request opened 31 days ago and paid yesterday is recent
   * spending, and a `created_at` window would miss it.
   */
  UNVERIFIED_PAYOUT_WINDOW_DAYS: intEnv('EARNINGS_UNVERIFIED_PAYOUT_WINDOW_DAYS', 30),

  /**
   * The platform's share of the UPLIFT on a negotiated line, as a percentage
   * (BARGAINING-AGENT-PLAN D-5). It funds the model spend that produced the
   * uplift.
   *
   * ⚠ It is a share of `(P − floor) × qty`, **never of the gross**. That is what
   * makes invariant 1 hold — `vendorGross ≥ floor × qty` for any percentage in
   * `[0, 100]` — so a vendor can never be paid below the number they set
   * themselves, and D-5 cannot newly trip `EARNINGS_INVALID_SPLIT`. A share of
   * the gross would break both in the first franc.
   *
   * ⚠ It applies **only to lines carrying a negotiation lock**. A storefront sale
   * at the ask used no AI and the whole uplift is the vendor's — there is no
   * uplift to speak of there anyway, since P is the ask and the floor is what
   * `variant.price` says.
   *
   * Lives here rather than in `negotiation.config.ts` because it is a term of the
   * money split: `EarningsSplitService` is its only reader, and the negotiation
   * module neither knows nor needs to know what the platform keeps.
   *
   * Clamped to `[0, 100]` at read time — an out-of-range percentage would let a
   * misconfiguration invert the invariant above, and `intEnv` alone would happily
   * return 400.
   */
  AI_MARGIN_PERCENT: Math.min(100, intEnv('NEGOTIATION_AI_MARGIN_PERCENT', 30)),
} as const;

/** A `Date` `days` in the future relative to `now`. */
export function daysFromNow(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * DAY);
}

/** A `Date` `days` in the past relative to `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY);
}
