/**
 * The COD coverage queue — which collected cash a confirmed deposit covers, in what order.
 * Pure: no database, no clock. `CodSettlementService.applyFifoInSession` runs it inside the
 * confirming transaction; `test:cod-settlement` runs it with nothing at all.
 *
 * ── The owner rule (REFUND-FLOW-PLAN R-6, 2026-10-05) ────────────────────────
 * A COD shipment is COVERED only when its cash reached the platform — an admin-confirmed
 * agency remittance, or an admin-confirmed `recipient: 'platform'` agent deposit. Collected
 * from the customer is not covered; an agent → agency hand-over is not covered. Deposits cover
 * shipments OLDEST DELIVERY FIRST, and at most one stays half-covered, carrying the remainder
 * forward to the next deposit.
 *
 * ── Why delivery date and not `collected_at` ─────────────────────────────────
 * The queue used to sort on `collected_at`, which is when the COLLECTION was claimed. For a
 * coded handoff that is the delivery; for `autoCollectWithoutCode` it is a whole dispute
 * window later. So a parcel delivered on day 1 whose customer never read out the code was
 * queued on day 8, behind every coded delivery of days 2–7, and the cash that physically
 * arrived first covered the younger shipments. Coverage gates earnings release and (R-4/R-5)
 * COD refunds, so that was money waiting on the wrong shipment. `delivered_at` is the
 * `agent_delivered` transition — see `deliveredAtOf` below.
 *
 * ── The `_id` tie-break ──────────────────────────────────────────────────────
 * Two deliveries stamped the same millisecond (a batch handover, a backfill falling back to
 * the same instant) had no defined order, so two runs over the same data could half-cover
 * different shipments. `_id` makes the queue a total order: same data, same outcome.
 *
 * ── Fee-only collections are in the queue like any other ─────────────────────
 * A `delivery_fee` collection (W-F) is cash in the same chain, owed by the same agency, and
 * its earnings rows are gated on the same settlement. Nothing here reads the kind, and
 * `test:cash-delivery-fee` scans the settlement service to keep it that way.
 */

/**
 * The Mongo sort the settlement query uses, kept beside the comparator that mirrors it so the
 * two cannot drift apart unseen. Ascending Mongo sort puts null BEFORE any date, which
 * `compareFifo` reproduces: a row the backfill has not reached is treated as the oldest,
 * which is what it almost always is (every such row predates the field).
 */
export const FIFO_SORT = { delivered_at: 1, _id: 1 } as const;

export interface FifoRow {
  /** The collection's `_id` as a 24-char hex string. Hex order IS ObjectId order. */
  id: string;
  deliveredAt: Date | null;
  expectedAmount: number;
  settledAmount: number;
}

export interface FifoStep {
  id: string;
  /** What this deposit put against this collection. */
  applied: number;
  /** The collection's `settled_amount` after this step. */
  settledAmount: number;
  /** `settledAmount >= expectedAmount` — the collection is now COVERED. */
  fullySettled: boolean;
}

export interface FifoPlan {
  /** Σ steps.applied — never more than the amount offered. */
  applied: number;
  steps: FifoStep[];
}

/** Oldest delivery first (null first, as Mongo sorts it), then `_id`. */
export function compareFifo(a: FifoRow, b: FifoRow): number {
  const ta = a.deliveredAt ? a.deliveredAt.getTime() : Number.NEGATIVE_INFINITY;
  const tb = b.deliveredAt ? b.deliveredAt.getTime() : Number.NEGATIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Spread `amount` over `rows`, oldest delivery first. Rows already covered are skipped. The
 * last row touched is the only one that can be left partly covered, and its remainder is
 * simply what the next deposit meets first — there is no separate carry-forward state.
 *
 * The rows are re-sorted here even though the query already sorted them: the plan must not
 * depend on the caller remembering to.
 */
export function planFifoSettlement(rows: readonly FifoRow[], amount: number): FifoPlan {
  const offered = Math.max(0, amount);
  let remaining = offered;
  const steps: FifoStep[] = [];

  for (const row of [...rows].sort(compareFifo)) {
    if (remaining <= 0) break;
    const outstanding = row.expectedAmount - row.settledAmount;
    if (outstanding <= 0) continue;

    const applied = Math.min(outstanding, remaining);
    remaining -= applied;
    const settledAmount = row.settledAmount + applied;
    steps.push({ id: row.id, applied, settledAmount, fullySettled: settledAmount >= row.expectedAmount });
  }

  return { applied: offered - remaining, steps };
}

/** The slice of a shipment's `status_history` entry this module reads. */
export interface StatusHistoryLike {
  status: string;
  changed_at?: Date | string | null;
}

/**
 * When the agent marked the parcel delivered, read from the shipment's `status_history`.
 *
 * The delivery is the LAST `delivered` entry (or, read before that write, the end of the
 * history), and the agent's mark is the entry immediately before it when that entry is
 * `agent_delivered`. Taking the one immediately before — rather than any `agent_delivered` —
 * matters because `agent_delivered → failed → in_transit → agent_delivered` is a legal cycle,
 * and the first mark was a failed attempt, not the delivery.
 *
 * No `agent_delivered` directly before the delivery means the agent submitted the code from
 * `picked_up`/`in_transit`: the code submission WAS the delivery, and `fallback`
 * (`collected_at`) is that moment.
 */
export function deliveredAtOf(
  history: readonly StatusHistoryLike[] | null | undefined,
  fallback: Date | null
): Date | null {
  const entries = history ?? [];
  let end = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].status === 'delivered') {
      end = i;
      break;
    }
  }
  const mark = end > 0 ? entries[end - 1] : undefined;
  if (mark && mark.status === 'agent_delivered' && mark.changed_at) {
    const at = new Date(mark.changed_at);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return fallback;
}
