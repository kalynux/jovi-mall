/**
 * Migration: every review goes public — publish the held ones, rename the rejected ones,
 * and swap the one-review-per-author index for its partial successor.
 *
 * Owner decision, 2026-10-05: a review publishes on submission, prose included, and an
 * administrator can unpublish, republish or delete it afterwards. Before that, a review
 * carrying prose was written `pending` and waited for a moderator — and no administrator
 * could ever reach the queue (wi-admin had no reviews surface), so every written review
 * sat invisible with its star. The owner chose to publish all of those at once rather than
 * leave them for an administrator to republish one by one.
 *
 * ── The three steps, in this order ──────────────────────────────────────────
 *
 *   1. Build `review_one_live_per_author_per_subject` (unique, partial on `deletedAt: null`),
 *      THEN drop `review_one_per_author_per_subject`. In that order so uniqueness never
 *      lapses: between the two, both constraints hold, and the old one is the stricter.
 *      The new index is what lets a review an administrator DELETES free its author to
 *      write again — the reason delete exists beside unpublish.
 *   2. `status: 'pending'` → `published`, `published_at` = now. Then recompute every
 *      aggregate those rows contribute to — exactly what `ReviewService.refreshTargets`
 *      does for a live publish, through the SAME repository method, so the migration
 *      cannot compute an average the service would not. ⚠ It does NOT nudge the agent
 *      trust recompute (that worker takes a Redis lock this script should not hold); the
 *      nightly `AgentTrustRecomputeWorker` sweep picks the new delivery ratings up, and the
 *      trust composite is a shadow today anyway (CLAUDE.md § Agent trust score).
 *   3. `status: 'rejected'` → `unpublished`, and an action stamped onto its moderation
 *      record (`'unpublished'`), which the new schema requires. No aggregate moves: a
 *      rejected review already counted for nothing and an unpublished one still does.
 *
 * Raw-driver writes for steps 2 and 3, deliberately: `pending` and `rejected` are no longer
 * in the model's enum, and a migration that has to argue with the schema it is migrating
 * away from should not go through it.
 *
 * Idempotent: a second run finds no `pending` or `rejected` row and the new index already
 * built, and changes nothing. `--dry-run` prints the counts and every aggregate it would
 * recompute, and writes NOTHING.
 *
 * Run:  npx ts-node scripts/migrate-reviews-publish-all.ts [--dry-run]
 *       (npm run migrate:reviews-publish-all)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import { targetsOf } from '../src/modules/reviews/domain/review-targets';
import { reviewAggregateRepository } from '../src/modules/reviews/repositories/review-aggregate.repository';
import { ReviewAuthorRole, ReviewSubjectType } from '../src/modules/reviews/models/review.model';
import { ReviewTargetType } from '../src/modules/reviews/models/review-aggregate.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const OLD_INDEX = 'review_one_per_author_per_subject';
const NEW_INDEX = 'review_one_live_per_author_per_subject';

interface HeldRow {
  _id: mongoose.Types.ObjectId;
  subject_type: ReviewSubjectType;
  author_role: ReviewAuthorRole;
  target_product_id?: mongoose.Types.ObjectId | null;
  target_agent_id?: mongoose.Types.ObjectId | null;
  target_agency_id?: mongoose.Types.ObjectId | null;
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const reviews = mongoose.connection.collection(COLLECTIONS.REVIEW);

  // ── 1. The index swap ──────────────────────────────────────────────────────
  let existing: Array<{ name?: string }> = [];
  try {
    existing = (await reviews.indexes()) as never;
  } catch {
    console.log(`\n${COLLECTIONS.REVIEW}: does not exist yet — the new index will create it`);
  }
  const hasNew = existing.some((i) => i.name === NEW_INDEX);
  const hasOld = existing.some((i) => i.name === OLD_INDEX);
  console.log(`\nIndex ${NEW_INDEX}: ${hasNew ? 'present' : 'MISSING — will build'}`);
  console.log(`Index ${OLD_INDEX}: ${hasOld ? 'present — will drop after the new one is built' : 'absent'}`);

  // ── 2 + 3. What the status moves will touch ───────────────────────────────
  const held = (await reviews
    .find({ status: 'pending', deletedAt: null }, {
      projection: { subject_type: 1, author_role: 1, target_product_id: 1, target_agent_id: 1, target_agency_id: 1 },
    })
    .toArray()) as unknown as HeldRow[];
  const rejectedCount = await reviews.countDocuments({ status: 'rejected' });
  const heldDeletedCount = await reviews.countDocuments({ status: 'pending', deletedAt: { $ne: null } });

  // Every aggregate a newly-published row contributes to, deduplicated.
  const keys = new Map<string, { targetType: ReviewTargetType; targetId: string; authorRole: ReviewAuthorRole }>();
  for (const row of held) {
    for (const t of targetsOf({
      subjectType: row.subject_type,
      authorRole: row.author_role,
      productId: row.target_product_id?.toString() ?? null,
      agentId: row.target_agent_id?.toString() ?? null,
      agencyId: row.target_agency_id?.toString() ?? null,
    })) {
      keys.set(`${t.type}:${t.id}:${row.author_role}`, { targetType: t.type, targetId: t.id, authorRole: row.author_role });
    }
  }

  console.log(`\nHeld (pending) reviews to publish: ${held.length}`);
  if (heldDeletedCount > 0) {
    console.log(`  + ${heldDeletedCount} pending AND deleted — status moved too, no aggregate (deleted rows count for nothing)`);
  }
  console.log(`Rejected reviews to mark unpublished: ${rejectedCount}`);
  console.log(`Aggregates to recompute: ${keys.size}`);
  for (const key of keys.values()) console.log(`  ${key.targetType} ${key.targetId} (${key.authorRole})`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  // ── 1. Apply the index swap: build first, drop second ─────────────────────
  if (!hasNew) {
    process.stdout.write(`\n  building ${NEW_INDEX} … `);
    await reviews.createIndex(
      { subject_type: 1, subject_id: 1, author_user_id: 1 },
      { name: NEW_INDEX, unique: true, partialFilterExpression: { deletedAt: null } },
    );
    console.log('done');
  }
  if (hasOld) {
    process.stdout.write(`  dropping ${OLD_INDEX} … `);
    await reviews.dropIndex(OLD_INDEX);
    console.log('done');
  }

  // ── 2. Publish the held reviews, then recompute what they moved ───────────
  const now = new Date();
  const published = await reviews.updateMany(
    { status: 'pending' },
    { $set: { status: 'published', published_at: now } },
  );
  console.log(`\n  published ${published.modifiedCount} review(s)`);

  for (const key of keys.values()) {
    await reviewAggregateRepository.recompute(key);
  }
  console.log(`  recomputed ${keys.size} aggregate(s)`);

  // ── 3. Rejected → unpublished ─────────────────────────────────────────────
  const withRecord = await reviews.updateMany(
    { status: 'rejected', moderation: { $ne: null } },
    { $set: { status: 'unpublished', 'moderation.action': 'unpublished' } },
  );
  const withoutRecord = await reviews.updateMany(
    { status: 'rejected' },
    { $set: { status: 'unpublished' } },
  );
  console.log(`  marked ${withRecord.modifiedCount + withoutRecord.modifiedCount} review(s) unpublished`);

  console.log(
    '\nDone. Agent trust scores pick up any newly published delivery ratings at the next nightly' +
      ' recompute. `npm run test:reviews` covers the rules this migration serves.',
  );
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
