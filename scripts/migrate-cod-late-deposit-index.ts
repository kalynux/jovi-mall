/**
 * Migration: re-scope the late-deposit uniqueness index from AGENT to CONTRACT.
 *
 * `late_deposit` discrepancies were unique per agent while open:
 *   { agent_id: 1, type: 1 }  partial on { status:'open', type:'late_deposit' }
 *
 * That stopped being correct once each contract gained its own remittance
 * cadence. An agent can be on time with agency A and a week late with agency B;
 * those are two creditors with two separate recourses, and one discrepancy row
 * can only name one `agency_id`. Under the old index the second agency was
 * never told it was owed. The new index adds `agency_id`:
 *   { agent_id: 1, agency_id: 1, type: 1 }  (same partial filter)
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 *
 * `autoIndex` is on, so Mongoose CREATES the new index at boot — but it never
 * DROPS the old one. The old index would keep enforcing one-open-flag-per-agent
 * globally, so the very behaviour this change exists to fix would still be
 * blocked, silently: the sweep's `openLateDeposit` would throw a duplicate-key
 * error for the second agency, get swallowed by the per-contract try/catch, and
 * the run would report success having flagged nothing.
 *
 * Run this BEFORE (or with) the deploy that ships the new index.
 *
 * Idempotent: a missing old index is not an error, it is the goal.
 *
 * Run:  npx ts-node scripts/migrate-cod-late-deposit-index.ts [--dry-run]
 *       (npm run migrate:cod-late-deposit-index)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/** What Mongo names an index built from { agent_id: 1, type: 1 }. */
const OLD_INDEX_KEY = { agent_id: 1, type: 1 };

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collection = mongoose.connection.collection(COLLECTIONS.COD_DISCREPANCY);
  const indexes = await collection.indexes();

  // Matched by KEY SHAPE, not by name: the name is auto-generated and a hand-
  // built index could carry any name at all.
  const stale = indexes.filter((idx) => sameKey(idx.key as Record<string, unknown>, OLD_INDEX_KEY));

  console.log(`\nIndexes on ${COLLECTIONS.COD_DISCREPANCY}: ${indexes.length}`);
  for (const idx of indexes) {
    const mark = stale.includes(idx) ? '  ← TO DROP' : '';
    console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}${mark}`);
  }

  if (stale.length === 0) {
    console.log('\nNothing to do — the agent-scoped index is already gone.');
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log(
      `\nDRY RUN — would drop ${stale.length} index(es): ${stale.map((i) => i.name).join(', ')}.` +
        '\nRe-run without --dry-run to apply.'
    );
    await mongoose.disconnect();
    return;
  }

  for (const idx of stale) {
    await collection.dropIndex(idx.name!);
    console.log(`  dropped ${idx.name}`);
  }

  console.log(
    '\nDone. The per-contract index is created automatically at boot by autoIndex;' +
      '\nrun `npm run verify:live-parity` afterwards to confirm it actually built.'
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
