import { ReviewAuthorRole, ReviewSubjectType } from '../models/review.model';
import { ReviewTargetType } from '../models/review-aggregate.model';

/**
 * The pure half of the review domain — no I/O, no clock, no database.
 *
 * Everything here decides *what a review means* rather than *what is stored*, which
 * is the half a test can pin. The same split `agent-trust.service.ts` follows, and
 * for the same reason: these three functions decide which aggregates move, whether a
 * review is visible, and — after Step 11 — an agent's COD cash limit.
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
 * Where a newly submitted review lands: `pending` or straight to `published`.
 *
 * **A review carrying free text is held for moderation; a bare star rating is not.**
 * That is the rule, and it is deliberate on both sides:
 *
 * - A number cannot be abusive, defamatory, or a link to somewhere else. There is
 *   nothing for a moderator to read and nothing they could decide that the
 *   eligibility gate has not already decided — the author bought the item, or
 *   received the parcel. Holding it buys nothing and costs the thing that matters:
 *   delivery ratings are overwhelmingly bare stars, and queueing them behind a human
 *   would leave the trust composite's customer factor seeded in practice while
 *   looking implemented.
 * - Prose is where the risk actually is, and it gets a human.
 *
 * The alternative — everything starts `pending` — is the reflexive design and it
 * makes the moderation queue the single point of failure for a signal that moves
 * real cash exposure. The alternative in the other direction — everything publishes,
 * moderate on report — has no queue at all, which the plan asks for explicitly.
 *
 * Note what this is NOT: it is not a trust decision about the author, and it does not
 * vary by role. A rejected review still counts for nothing, star included.
 */
export function initialStatusOf(input: { title?: string | null; body?: string | null }): 'pending' | 'published' {
  const hasText = Boolean(input.title?.trim()) || Boolean(input.body?.trim());
  return hasText ? 'pending' : 'published';
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
