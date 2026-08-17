/**
 * Migration: backfill AgentAgencyContract.terms_proposed_by / .terms_version
 *
 * The contract's terms became NEGOTIABLE: either party may propose them, and
 * `terms_proposed_by` — not the immutable `origin` — now decides who may
 * approve. Legacy rows have neither field, so this establishes them.
 *
 * ── The conditional, which is the whole point of this script ────────────────
 *
 * The obvious backfill is `terms_proposed_by = origin === 'join_request' ?
 * 'agent' : 'agency'` for everything. That is wrong for PENDING rows, and
 * quietly so.
 *
 * A pending contract written before this change carries whatever terms the
 * agency had configured — which, for most of them, is `contractDefaults`:
 * `{ model: 'percentage', agent_share_percent: null }`. `applyFeeSplit` reads
 * that null as a cut of ZERO. Stamping a proposer onto such a row would declare
 * "these terms were proposed by the agency" about terms that pay the agent
 * nothing and that no agency ever chose. The new approval guard
 * (`assertTermsApprovable`) would then reject it anyway, for a coherence reason
 * whose message names a field nobody touched.
 *
 * So: stamp the proposer ONLY when the stored fee split is already coherent.
 * Everything else stays `null`, which is a real state with a real meaning —
 * "no terms proposed yet" — and lands those contracts in exactly the same place
 * as a bare agent join-request. The agency proposes, the agent answers, and one
 * client control serves both. That is the honest state, not a workaround.
 *
 * Terminal and live rows get the proposer from `origin` unconditionally: for
 * them the field is audit only. Nothing reads it as authority outside `pending`
 * (live contracts negotiate through ContractTermsProposal instead), so an
 * incoherent split there is a pre-existing data issue this script must not
 * pretend to fix.
 *
 * `terms_version` is 1 wherever a proposer was stamped, else 0 — "0 means terms
 * were never stated" has to hold for the DTO to be truthful.
 *
 * Idempotent: only touches rows actually missing `terms_proposed_by`, so a
 * partial run can simply be repeated.
 *
 * Run:  npx ts-node scripts/migrate-contract-terms-negotiation.ts [--dry-run]
 *       (npm run migrate:contract-terms)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/** Mirrors AgentContractService.assertFeeSplitCoherent, on a raw document. */
function feeSplitIsCoherent(split: Record<string, unknown> | undefined | null): boolean {
  if (!split) return false;
  if (split.model === 'flat') return split.agent_flat_fee !== null && split.agent_flat_fee !== undefined;
  // 'percentage' is the schema default, so an absent model is a percentage.
  return split.agent_share_percent !== null && split.agent_share_percent !== undefined;
}

function proposerFromOrigin(origin: unknown): 'agent' | 'agency' {
  return origin === 'join_request' ? 'agent' : 'agency';
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collection = mongoose.connection.collection(COLLECTIONS.AGENT_AGENCY_CONTRACT);

  // Keyed on the field being absent — exactly the population a schema default
  // cannot reach, since Mongoose applies defaults on hydration, not to storage.
  const filter = { terms_proposed_by: { $exists: false } };
  const docs = await collection.find(filter).toArray();
  console.log(`\nContracts needing a backfill: ${docs.length}`);

  if (docs.length === 0) {
    await mongoose.disconnect();
    console.log('Nothing to do.');
    return;
  }

  type Plan = { id: mongoose.Types.ObjectId; proposer: 'agent' | 'agency' | null; version: number };
  const plans: Plan[] = docs.map((doc) => {
    const pending = doc.status === 'pending';
    const coherent = feeSplitIsCoherent(doc.fee_split as Record<string, unknown> | undefined);

    // Pending + incoherent ⇒ nobody proposed anything worth consenting to.
    const proposer = pending && !coherent ? null : proposerFromOrigin(doc.origin);
    return { id: doc._id as mongoose.Types.ObjectId, proposer, version: proposer ? 1 : 0 };
  });

  const pendingUnset = plans.filter((p) => p.proposer === null).length;
  const stamped = plans.length - pendingUnset;

  console.log(`  → proposer stamped from origin: ${stamped}`);
  console.log(`  → left null (pending, no coherent fee split): ${pendingUnset}`);

  if (pendingUnset > 0) {
    console.log(
      `\n  NOTE: those ${pendingUnset} pending contract(s) cannot be approved until an agency\n` +
        '  proposes terms on them. Their agencies will see "Propose terms" instead of\n' +
        '  "Approve" — which is correct, because their stored fee split pays the agent 0.'
    );
  }

  if (DRY_RUN) {
    console.log('\nSample of what would be written:');
    for (const doc of docs.slice(0, 5)) {
      const plan = plans.find((p) => p.id.equals(doc._id as mongoose.Types.ObjectId))!;
      console.log(
        `  ${doc._id.toString()}  status=${doc.status} origin=${doc.origin} ` +
          `→ terms_proposed_by=${plan.proposer ?? 'null'}, terms_version=${plan.version}`
      );
    }
    await mongoose.disconnect();
    console.log(`\nDRY RUN — ${docs.length} document(s) would be updated. Re-run without --dry-run to apply.`);
    return;
  }

  // Grouped into three bulk updates rather than one op per document: the plan
  // only ever produces three distinct field pairs.
  const ops = [
    { proposer: 'agent' as const, version: 1 },
    { proposer: 'agency' as const, version: 1 },
    { proposer: null, version: 0 },
  ]
    .map(({ proposer, version }) => ({
      ids: plans.filter((p) => p.proposer === proposer).map((p) => p.id),
      set: { terms_proposed_by: proposer, terms_version: version },
    }))
    .filter((op) => op.ids.length > 0);

  let updated = 0;
  for (const op of ops) {
    const result = await collection.updateMany({ _id: { $in: op.ids } }, { $set: op.set });
    updated += result.modifiedCount;
    console.log(`  updated ${result.modifiedCount} → ${JSON.stringify(op.set)}`);
  }

  console.log(`\nDone. ${updated} contract(s) updated.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
