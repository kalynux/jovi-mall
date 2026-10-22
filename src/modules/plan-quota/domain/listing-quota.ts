/**
 * The listing axis of the plan quota (SERVICE-LISTINGS-PLAN O-16, § C-8a) — pure.
 *
 * A PROVIDER's plan grants `max_active_listings` slots, and a downgrade is enforced exactly as
 * products are: the oldest listings keep their slots, the rest are suspended
 * `plan_quota_exceeded`, and an upgrade brings them back oldest-first. The cut-off itself is
 * `planCountCutoff` — the SAME function as products, so the two axes cannot disagree about
 * what "oldest first" means. This file only says which listings compete for a slot and how a
 * quota suspension is undone.
 *
 * ── What occupies a slot (§ C-8a) ─────────────────────────────────────────────────
 * `live`, `pending_review`, and `suspended` for any reason OTHER than `plan_quota_exceeded`.
 * A quota-suspended listing frees its slot — that exclusion is what makes the sweep converge
 * (the products rule, `countActiveByVendor`). `draft`, `rejected` and `archived` hold none.
 *
 * ── Pinned, never touched ─────────────────────────────────────────────────────────
 * A listing suspended `insufficient_credits` or `platform_oversight` keeps its slot and is
 * never suspended or restored by the quota: room in a plan says nothing about why somebody
 * else took a listing offline. The disjointness rule, exactly as products.
 */
import type { ListingStatus, ListingSuspensionReason } from '../../listings/domain/listing.types';
import type { QuotaCandidate } from './quota-cutoff';

/** The quota's own suspension reason — the only one this module ever writes or lifts. */
export const LISTING_QUOTA_REASON: ListingSuspensionReason = 'plan_quota_exceeded';

/** The statuses a listing can hold a slot in. The sweep reads only these. */
export const LISTING_SLOT_STATUSES: readonly ListingStatus[] = ['live', 'pending_review', 'suspended'];

/** The statuses the quota may SUSPEND from (and therefore restore to). */
export const LISTING_QUOTA_SUSPENDABLE: readonly ListingStatus[] = ['live', 'pending_review'];

/** One listing as the sweep sees it: ordered oldest-first by the caller (`created_at`, `_id`). */
export interface ListingSlot {
  id: string;
  status: ListingStatus;
  suspensionReason: ListingSuspensionReason | null;
}

/** § C-8a, as a predicate. */
export function occupiesListingSlot(slot: Pick<ListingSlot, 'status' | 'suspensionReason'>): boolean {
  if (slot.status === 'live' || slot.status === 'pending_review') return true;
  return slot.status === 'suspended' && slot.suspensionReason !== LISTING_QUOTA_REASON;
}

/**
 * The cut-off candidate for one listing. `blocked` = currently held back BY THE QUOTA;
 * `pinned` = suspended for another reason (consumes a slot, never touched).
 */
export function toListingQuotaCandidate(slot: ListingSlot): QuotaCandidate {
  const quotaSuspended = slot.status === 'suspended' && slot.suspensionReason === LISTING_QUOTA_REASON;
  return {
    id: slot.id,
    blocked: quotaSuspended,
    pinned: slot.status === 'suspended' && !quotaSuspended,
  };
}

/** What a quota restore writes for one listing. */
export type ListingRestoreTarget =
  | { status: ListingStatus; suspension: null }
  | { status: 'suspended'; suspension: { reason: 'insufficient_credits'; previous_status: 'live' } };

/**
 * Where a quota-suspended listing goes back to: its exact `previous_status` — EXCEPT a listing
 * that was `live` while the provider's balance is now below the first-reveal cost. That one is
 * restored straight into `suspended` / `insufficient_credits` (previous `live`), the rule § C-8a
 * gives an approval in the same position: a live listing nobody can reveal would refuse every
 * customer, and the credit suspension is what brings it back on the next top-up.
 *
 * A `pending_review` listing goes back to the review queue unconditionally: the balance decides
 * nothing until it is approved, and the approve path applies the same rule then.
 */
export function listingRestoreTarget(
  previousStatus: ListingStatus,
  balance: number,
  firstRevealCost: number,
): ListingRestoreTarget {
  if (previousStatus === 'live' && balance < firstRevealCost) {
    return { status: 'suspended', suspension: { reason: 'insufficient_credits', previous_status: 'live' } };
  }
  return { status: previousStatus, suspension: null };
}
