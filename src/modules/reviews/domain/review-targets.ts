import { ReviewAuthorRole, ReviewSubjectType } from '../models/review.model';
import { ReviewTargetType } from '../models/review-aggregate.model';

/**
 * The pure half of the review domain — no I/O, no clock, no database.
 *
 * Everything here decides *what a review means* rather than *what is stored*, which
 * is the half a test can pin. The same split `agent-trust.service.ts` follows, and
 * for the same reason: these functions decide which aggregates move, who may review
 * what, and — after Step 11 — an agent's COD cash limit.
 *
 * ⚠ `initialStatusOf` lived here and is GONE (2026-10-05). It held a review carrying
 * prose for a moderator and published a bare star. The owner reversed that: every
 * review publishes on submission, and an administrator can unpublish, republish or
 * delete it afterwards (`ReviewService`). There is no status decision left to make
 * at submission, so there is no function to make it.
 */

/** One aggregate row a review contributes to. */
export interface ReviewTarget {
  type: ReviewTargetType;
  id: string;
}

/** The identifiers a review carries, as far as targeting is concerned. */
export interface ReviewTargetInput {
  subjectType: ReviewSubjectType;
  authorRole: ReviewAuthorRole;
  productId?: string | null;
  agentId?: string | null;
  agencyId?: string | null;
}

/**
 * Which aggregates one review moves.
 *
 * ── The matrix, and why the delivery rows differ by author ────────────────────
 *
 *   product  + customer  →  the product
 *   delivery + customer  →  the agent AND the agency
 *   delivery + vendor    →  the agent AND the agency
 *   delivery + agency    →  the agent alone
 *
 * All three roles rate the *same subject* — one shipment — and the aggregate they
 * move is keyed by `(target, author_role)`, so the three land in three separate rows
 * and feed the three separate trust factors the composite weights differently
 * (customer 30, agency 10, vendor 10). That is what closes the 50 weight that has
 * blended to the seed since the score existed.
 *
 * An agency reviewing a delivery moves no *agency* aggregate: an agency rating
 * itself is not evidence of anything, and publishing it as their public score would
 * make the directory's rating self-reported.
 *
 * A product review moves no *vendor* aggregate either, and that is a narrower call:
 * `target_vendor_id` is recorded on the row so the history is attributable, but no
 * surface reads a vendor's rating today and an aggregate nobody reads is a second
 * thing to keep correct for nothing. Adding it later is a recompute, not a backfill.
 *
 * A missing id simply produces no target — never a throw. A delivery review is
 * refused up-front if its shipment has no agent (`REVIEW_SUBJECT_NOT_REVIEWABLE`),
 * so reaching here with one is a should-never-happen, and the honest behaviour for a
 * should-never-happen in a derivation is to move nothing rather than to fail a write
 * that has already been accepted.
 */
export function targetsOf(input: ReviewTargetInput): ReviewTarget[] {
  const targets: ReviewTarget[] = [];

  if (input.subjectType === 'product') {
    if (input.productId) targets.push({ type: 'product', id: input.productId });
    return targets;
  }

  // subjectType === 'delivery'
  if (input.agentId) targets.push({ type: 'agent', id: input.agentId });
  if (input.authorRole !== 'agency' && input.agencyId) {
    targets.push({ type: 'agency', id: input.agencyId });
  }
  return targets;
}

/**
 * Whether an author role may review a subject type at all.
 *
 * A vendor or an agency has no purchase to verify, so neither may review a product;
 * the product review is the buyer's. Every role may review a delivery — they are the
 * three parties to one, and each is rating something different about it (the
 * recipient's experience, the seller's handover, the employer's supervision).
 */
export function roleMayReview(subjectType: ReviewSubjectType, authorRole: ReviewAuthorRole): boolean {
  if (subjectType === 'product') return authorRole === 'customer';
  return true;
}

/**
 * `sum / count`, to two decimals. `0` when there is nothing to average.
 *
 * Two decimals rather than one because this feeds `ratingFactor(avg, count)` in the
 * trust composite as well as a star widget, and rounding a 30-weight input to 0.1
 * discards precision the score can express. Zero-with-zero-count is the "no evidence"
 * shape every reader here already knows how to interpret: the storefront omits the
 * rating entirely and `ratingFactor` resolves to the seed.
 */
export function averageOf(sum: number, count: number): number {
  if (count <= 0) return 0;
  return Math.round((sum / count) * 100) / 100;
}
