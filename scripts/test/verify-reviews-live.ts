/**
 * verify:reviews — the review pipeline against REAL Mongo. **NEEDS Mongo.**
 *
 * `test:reviews` is DB-free and stays that way: the domain half of that module is
 * pure, and the wiring half is asserted by source scan. Three things neither
 * technique can reach, and all three are why this file exists:
 *
 *   1. **The unique index actually BINDS.** `autoIndex` is off in production and
 *      fails *silently* in development — the promise rejects into a listener nobody
 *      attached and the process comes up healthy. `review_one_live_per_author_per_subject`
 *      is the ONLY thing making "one review per author per subject" true (the
 *      service pre-check is a race), so an index that builds but does not bind is
 *      indistinguishable from one that works until it matters. Same argument
 *      `verify:connections` makes about its two unique indexes, and `verify:blog`
 *      about `slug_keys`. Since 2026-10-05 it is PARTIAL on `deletedAt: null`, and
 *      this is the only place proven to let a deleted review's author write again.
 *   2. **The aggregate recompute really runs**, and an unpublished or deleted
 *      review's star really disappears. A source scan can see the filter; only a
 *      real aggregation proves the arithmetic it produces.
 *   3. **`AgentTrustService.collectSignals` reads the aggregate back.** That is the
 *      hop the whole module exists for — a delivery rating reaching an agent's trust
 *      score — and it spans two modules and two collections.
 *
 * Writes then deletes its own fixtures, pass or fail. It uses freshly-minted
 * ObjectIds that reference nothing, so it touches no real agent, agency or shipment.
 *
 * Run: npm run verify:reviews
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { ReviewModel } from '../../src/modules/reviews/models/review.model';
import { ReviewAggregateModel } from '../../src/modules/reviews/models/review-aggregate.model';
import { reviewAggregateRepository } from '../../src/modules/reviews/repositories/review-aggregate.repository';
import { reviewRepository } from '../../src/modules/reviews/repositories/review.repository';
import { agentTrustService } from '../../src/modules/agents/domain/services/agent-trust.service';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

// Fresh ids that reference nothing real — this suite must never touch a live agent.
const AGENT = new Types.ObjectId();
const AGENCY = new Types.ObjectId();
const SHIPMENT = new Types.ObjectId();
const USER_A = new Types.ObjectId();
const USER_B = new Types.ObjectId();
const USER_C = new Types.ObjectId();

const fixture = (author: Types.ObjectId, rating: number, status: 'published' | 'unpublished') => ({
  subject_type: 'delivery' as const,
  subject_id: SHIPMENT,
  author_user_id: author,
  author_role: 'customer' as const,
  rating,
  title: null,
  body: null,
  status,
  published_at: new Date(),
  moderation: null,
  order_id: null,
  shipment_id: SHIPMENT,
  target_product_id: null,
  target_agent_id: AGENT,
  target_agency_id: AGENCY,
  target_vendor_id: null,
});

async function cleanup(): Promise<void> {
  await ReviewModel.deleteMany({ subject_id: SHIPMENT });
  await ReviewAggregateModel.deleteMany({ target_id: { $in: [AGENT, AGENCY] } });
}

const agentCustomerKey = { targetType: 'agent' as const, targetId: AGENT.toString(), authorRole: 'customer' as const };

async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall');
  console.log('\n── The unique index, against real Mongo ────────────────────────────────\n');

  try {
    await cleanup();

    // ── 1. The index binds ───────────────────────────────────────────────────
    const indexes = await mongoose.connection.collection('reviews').indexes();
    assert(
      'review_one_live_per_author_per_subject exists, unique, partial on deletedAt: null',
      indexes.some(
        (i) =>
          i.name === 'review_one_live_per_author_per_subject' &&
          i.unique === true &&
          JSON.stringify(i.partialFilterExpression) === JSON.stringify({ deletedAt: null }),
      ),
    );
    assert(
      'the superseded non-partial index is gone (it would still block a deleted review\'s author)',
      !indexes.some((i) => i.name === 'review_one_per_author_per_subject'),
    );

    await ReviewModel.create(fixture(USER_A, 5, 'published'));

    let duplicateCode: number | undefined;
    try {
      await ReviewModel.create(fixture(USER_A, 1, 'published'));
    } catch (error) {
      duplicateCode = (error as { code?: number }).code;
    }
    // The half a "does the index exist" check cannot make: that it REFUSES.
    assert('a second review by the same author on the same subject is REJECTED (E11000)', duplicateCode === 11000);
    assert('...and the duplicate did not land', (await ReviewModel.countDocuments({ subject_id: SHIPMENT })) === 1);

    await ReviewModel.create(fixture(USER_B, 3, 'published'));
    assert('a DIFFERENT author on the same subject is accepted', (await ReviewModel.countDocuments({ subject_id: SHIPMENT })) === 2);

    console.log('\n── The aggregate recompute ─────────────────────────────────────────────\n');

    let agg = await reviewAggregateRepository.recompute(agentCustomerKey);
    assert('both published reviews are counted', agg.count === 2);
    assert('the average is (5 + 3) / 2 = 4', agg.average === 4);
    assert('the histogram places each star', agg.distribution['5'] === 1 && agg.distribution['3'] === 1);

    // ── 2. An unpublished review counts for NOTHING, star included ───────────
    await ReviewModel.updateOne({ subject_id: SHIPMENT, author_user_id: USER_B }, { $set: { status: 'unpublished' } });
    agg = await reviewAggregateRepository.recompute(agentCustomerKey);
    assert('an UNPUBLISHED review drops out of the count', agg.count === 1);
    assert('...and its star leaves the average', agg.average === 5);
    assert('...and its bar leaves the histogram', agg.distribution['3'] === 0);

    // An unpublished review still holds its author's slot — that is what separates it from delete.
    let unpublishedDuplicate: number | undefined;
    try {
      await ReviewModel.create(fixture(USER_B, 4, 'published'));
    } catch (error) {
      unpublishedDuplicate = (error as { code?: number }).code;
    }
    assert('an UNPUBLISHED review still blocks its author from writing another (E11000)', unpublishedDuplicate === 11000);

    // ── 2b. A deleted review counts for nothing AND frees its author ─────────
    await ReviewModel.create(fixture(USER_C, 1, 'published'));
    await ReviewModel.updateOne({ subject_id: SHIPMENT, author_user_id: USER_C }, { $set: { deletedAt: new Date() } });
    agg = await reviewAggregateRepository.recompute(agentCustomerKey);
    assert('a DELETED review is excluded from the aggregate', agg.count === 1 && agg.average === 5);

    let rewriteError: unknown = null;
    try {
      await ReviewModel.create(fixture(USER_C, 4, 'published'));
    } catch (error) {
      rewriteError = error;
    }
    assert('a DELETED review\'s author may write a NEW one — the partial index admits it', rewriteError === null);
    assert(
      '...so that author now has one live row and one deleted row',
      (await ReviewModel.countDocuments({ subject_id: SHIPMENT, author_user_id: USER_C, deletedAt: null })) === 1 &&
        (await ReviewModel.countDocuments({ subject_id: SHIPMENT, author_user_id: USER_C, deletedAt: { $ne: null } })) === 1,
    );
    agg = await reviewAggregateRepository.recompute(agentCustomerKey);
    assert('...and the new review counts', agg.count === 2 && agg.average === 4.5);

    // ── 2c. The moderation compare-and-sets, through the real repository ────
    // USER_B's row is `unpublished`. Make it look like a review rejected under the old
    // held-for-moderation rule: never visible, so `published_at` is null.
    await ReviewModel.updateOne({ subject_id: SHIPMENT, author_user_id: USER_B }, { $set: { published_at: null } });
    const rowB = await ReviewModel.findOne({ subject_id: SHIPMENT, author_user_id: USER_B });
    const stamp = { userId: null, source: 'admin' as const, reason: '$body' };

    const wrongFrom = await reviewRepository.setStatusIf(rowB!._id.toString(), 'published', 'unpublished', 'unpublished', stamp);
    assert('unpublishing a review that is not published is a CAS miss (null)', wrongFrom === null);

    const republished = await reviewRepository.setStatusIf(rowB!._id.toString(), 'unpublished', 'published', 'republished', stamp);
    assert('republish moves it back to published', republished?.status === 'published');
    assert('republish STAMPS published_at on a row that was never visible', republished?.published_at instanceof Date);
    assert(
      'a reason typed as "$body" is stored as TEXT, not read as a field path',
      republished?.moderation?.reason === '$body' && republished.moderation.action === 'republished',
    );
    const firstSeen = republished!.published_at!.getTime();
    await reviewRepository.setStatusIf(rowB!._id.toString(), 'published', 'unpublished', 'unpublished', stamp);
    const again = await reviewRepository.setStatusIf(rowB!._id.toString(), 'unpublished', 'published', 'republished', stamp);
    assert('a second republish keeps the FIRST published_at', again?.published_at?.getTime() === firstSeen);

    const deleted = await reviewRepository.softDeleteIfLive(rowB!._id.toString(), stamp);
    assert('delete is soft — the row survives with deletedAt and a deleted action', deleted?.deletedAt instanceof Date && deleted.moderation?.action === 'deleted');
    assert('deleting twice is a miss (null), never a second delete', (await reviewRepository.softDeleteIfLive(rowB!._id.toString(), stamp)) === null);
    await ReviewModel.deleteOne({ _id: rowB!._id }); // keep the aggregate arithmetic below as it was

    // ── 3. Idempotence — the upsert must not mint a second row ───────────────
    await reviewAggregateRepository.recompute(agentCustomerKey);
    const rowCount = await ReviewAggregateModel.countDocuments({
      target_type: 'agent',
      target_id: AGENT,
      author_role: 'customer',
    });
    assert('recompute is idempotent — exactly one aggregate row survives', rowCount === 1);

    const aggIndexes = await mongoose.connection.collection('review_aggregates').indexes();
    assert(
      'review_aggregate_identity exists and is declared unique',
      aggIndexes.some((i) => i.name === 'review_aggregate_identity' && i.unique === true),
    );

    console.log('\n── The hop this module exists for: aggregate → trust signals ───────────\n');

    const signals = await agentTrustService.collectSignals(AGENT.toString());
    assert(
      'collectSignals reads the customer rating back out of the aggregate',
      signals.customer_rating_avg === 4.5 && signals.customer_rating_count === 2,
    );
    // The distinction the whole scale depends on: unknown is null, not zero.
    assert(
      'an unrated factor reports null, never 0',
      signals.agency_rating_avg === null && signals.vendor_rating_avg === null,
    );
    assert('...with a count of 0', signals.agency_rating_count === 0 && signals.vendor_rating_count === 0);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
