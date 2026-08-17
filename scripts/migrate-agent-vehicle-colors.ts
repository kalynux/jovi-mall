/**
 * Migration: normalize DeliveryAgent.vehicle_info.color to the colour vocabulary.
 *
 * `color` was `z.string().min(1).max(50)` — validated for length and nothing
 * else — so what reached an agency dispatcher was whatever the agent typed:
 * `Red`, `red`, `rouge`, `dark blu`, `Silver/grey`. The app now writes one of a
 * fixed set of lowercase tokens, and `mergeVehicleInfo` normalizes on write.
 * This brings the rows already in the collection to the same convention.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────
 *
 * It does not force values into the vocabulary. `normalizeVehicleColor` maps
 * capitalisation and known aliases (`Gray` → `grey`) and returns everything
 * else verbatim, because `color` is a documented convention rather than an
 * enum — the app keeps an "another colour" escape hatch for a two-tone or
 * unusual vehicle, and rewriting those would destroy what the agent reported.
 *
 * What it DOES do is report them. The unmapped list at the end is the evidence
 * for whether the palette is missing a colour: if 200 agents wrote some variant
 * of "maroon", the palette should gain `maroon` (and this script a `maroon`
 * alias) rather than pushing all of them through the escape hatch.
 *
 * Idempotent: a row is written only when normalisation actually changes the
 * stored string, so a second run reports 0 updated and the same unmapped list.
 *
 * Run:  npx ts-node scripts/migrate-agent-vehicle-colors.ts [--dry-run]
 *       (npm run migrate:agent-vehicle-colors)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import { normalizeVehicleColor, isVehicleColorToken } from '../src/modules/agents/domain/vehicle-info';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collection = mongoose.connection.collection(COLLECTIONS.DELIVERY_AGENT);

  const docs = await collection
    .find({ 'vehicle_info.color': { $type: 'string' } }, { projection: { 'vehicle_info.color': 1 } })
    .toArray();

  console.log(`\nAgents with a stored vehicle colour: ${docs.length}`);
  if (docs.length === 0) {
    await mongoose.disconnect();
    console.log('Nothing to do.');
    return;
  }

  let rewritten = 0;
  let alreadyNormal = 0;
  /** normalized value → { count, samples of what was originally stored } */
  const unmapped = new Map<string, { count: number; rawSamples: Set<string> }>();

  for (const doc of docs) {
    const raw: string = doc.vehicle_info.color;
    const normalized = normalizeVehicleColor(raw);

    if (!isVehicleColorToken(normalized)) {
      const entry = unmapped.get(normalized) ?? { count: 0, rawSamples: new Set<string>() };
      entry.count += 1;
      if (entry.rawSamples.size < 5) entry.rawSamples.add(raw);
      unmapped.set(normalized, entry);
    }

    if (normalized === raw) {
      alreadyNormal += 1;
      continue;
    }

    console.log(`  ${doc._id}: ${JSON.stringify(raw)} → ${JSON.stringify(normalized)}`);
    if (!DRY_RUN) {
      await collection.updateOne({ _id: doc._id }, { $set: { 'vehicle_info.color': normalized } });
    }
    rewritten += 1;
  }

  console.log(`\n${DRY_RUN ? 'Would rewrite' : 'Rewrote'}: ${rewritten}   already normalized: ${alreadyNormal}`);

  if (unmapped.size === 0) {
    console.log('\nEvery stored colour is in the vocabulary.');
  } else {
    const rows = [...unmapped.entries()].sort((a, b) => b[1].count - a[1].count);
    const total = rows.reduce((sum, [, e]) => sum + e.count, 0);
    console.log(`\nOutside the vocabulary — LEFT AS-IS (${total} agents, ${rows.length} distinct values):`);
    console.log('  These are the candidates for a new palette entry or a new alias.\n');
    for (const [value, entry] of rows) {
      console.log(`  ${String(entry.count).padStart(5)}  ${JSON.stringify(value)}   e.g. ${[...entry.rawSamples].map((s) => JSON.stringify(s)).join(', ')}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
