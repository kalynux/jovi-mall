import { Types } from 'mongoose';
import { ReviewModel, ReviewAuthorRole } from '../models/review.model';
import {
  IReviewAggregate,
  IReviewRatingDistribution,
  ReviewAggregateModel,
  ReviewTargetType,
} from '../models/review-aggregate.model';
import { averageOf } from '../domain/review-targets';

/** A target's published rating, as every reader here consumes it. */
export interface ReviewAggregateView {
  count: number;
  average: number;
  distribution: IReviewRatingDistribution;
}

export const EMPTY_AGGREGATE: ReviewAggregateView = Object.freeze({
  count: 0,
  average: 0,
  distribution: Object.freeze({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }) as IReviewRatingDistribution,
});

/** The `(target_type, target_id, author_role)` triple that identifies an aggregate row. */
export interface AggregateKey {
  targetType: ReviewTargetType;
  targetId: string;
  authorRole: ReviewAuthorRole;
}

const emptyDistribution = (): IReviewRatingDistribution => ({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });

const toView = (row: Pick<IReviewAggregate, 'count' | 'average' | 'distribution'> | null): ReviewAggregateView =>
  row ? { count: row.count, average: row.average, distribution: row.distribution } : { ...EMPTY_AGGREGATE, distribution: emptyDistribution() };

/**
 * ReviewAggregateRepository — the **only** writer of `review_aggregates`.
 *
 * "One writer per field" is the rule the whole trust design rests on, and it is what
 * this class exists to make structural. `trust_signals.customer_rating_avg` is
 * written by the nightly trust worker alone, from `AgentTrustService.collectSignals`,
 * which reads THIS collection — so a delivery review reaches an agent's trust score
 * through exactly one path, and nothing here ever touches `delivery_agents`.
 */
export class ReviewAggregateRepository {
  /**
   * Rebuild one aggregate row from the published reviews behind it.
   *
   * A full recompute rather than an increment — see the model header for why. It is
   * idempotent, so a double call after a moderation race is harmless, and it makes
   * "a rejected review counts for nothing" a property of the query rather than of a
   * subtraction somebody has to remember.
   *
   * A target whose last published review is rejected recomputes to a row of zeros
   * rather than being deleted. Zero-with-a-row and no-row-at-all read identically
   * through `toView`, and keeping the row means `computed_at` still says when the
   * platform last looked — which is the difference between "nobody has rated them"
   * and "we have not checked".
   */
  async recompute(key: AggregateKey): Promise<ReviewAggregateView> {
    const targetField =
      key.targetType === 'product' ? 'target_product_id' : key.targetType === 'agent' ? 'target_agent_id' : 'target_agency_id';

    const rows = await ReviewModel.aggregate<{ _id: number; n: number }>([
      {
        $match: {
          [targetField]: new Types.ObjectId(key.targetId),
          author_role: key.authorRole,
          status: 'published',
          deletedAt: null,
        },
      },
      { $group: { _id: '$rating', n: { $sum: 1 } } },
    ]);

    const distribution = emptyDistribution();
    let count = 0;
    let sum = 0;

    for (const row of rows) {
      const star = String(row._id) as keyof IReviewRatingDistribution;
      if (star in distribution) distribution[star] = row.n;
      count += row.n;
      sum += row._id * row.n;
    }

    const average = averageOf(sum, count);

    await ReviewAggregateModel.updateOne(
      { target_type: key.targetType, target_id: new Types.ObjectId(key.targetId), author_role: key.authorRole },
      { $set: { count, sum, average, distribution, computed_at: new Date() } },
      { upsert: true },
    );

    return { count, average, distribution };
  }

  /** One target's rating from one author role. Empty when nothing is published. */
  async find(key: AggregateKey): Promise<ReviewAggregateView> {
    const row = await ReviewAggregateModel.findOne(
      { target_type: key.targetType, target_id: new Types.ObjectId(key.targetId), author_role: key.authorRole },
      { count: 1, average: 1, distribution: 1 },
    ).lean();
    return toView(row);
  }

  /**
   * A page of targets' ratings in ONE query, keyed by target id.
   *
   * The storefront's product grid renders a rating per row, so the alternative is a
   * query per card — the same N+1 the file resolver already batches away. Ids absent
   * from the result simply do not appear in the map, and every caller treats a miss
   * as "no reviews".
   */
  async findMany(
    targetType: ReviewTargetType,
    targetIds: string[],
    authorRole: ReviewAuthorRole,
  ): Promise<Map<string, ReviewAggregateView>> {
    const unique = [...new Set(targetIds.filter(Boolean))];
    if (unique.length === 0) return new Map();

    const rows = await ReviewAggregateModel.find(
      {
        target_type: targetType,
        target_id: { $in: unique.map((id) => new Types.ObjectId(id)) },
        author_role: authorRole,
      },
      { target_id: 1, count: 1, average: 1, distribution: 1 },
    ).lean();

    const byId = new Map<string, ReviewAggregateView>();
    for (const row of rows) {
      byId.set(row.target_id.toString(), {
        count: row.count,
        average: row.average,
        distribution: row.distribution,
      });
    }
    return byId;
  }

  /**
   * All three of one agent's rating rows at once — the shape
   * `AgentTrustService.collectSignals` needs, since the composite weights the three
   * author roles differently and reads them together.
   */
  async findAgentRatings(agentId: string): Promise<Record<ReviewAuthorRole, ReviewAggregateView>> {
    const rows = await ReviewAggregateModel.find(
      { target_type: 'agent', target_id: new Types.ObjectId(agentId) },
      { author_role: 1, count: 1, average: 1, distribution: 1 },
    ).lean();

    const byRole: Record<ReviewAuthorRole, ReviewAggregateView> = {
      customer: toView(null),
      vendor: toView(null),
      agency: toView(null),
    };
    for (const row of rows) {
      byRole[row.author_role] = { count: row.count, average: row.average, distribution: row.distribution };
    }
    return byRole;
  }
}

export const reviewAggregateRepository = new ReviewAggregateRepository();
