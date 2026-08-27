/**
 * Migration: build the Phase 1 payment indexes explicitly.
 *
 * Six indexes ship with the payments work, and three of them are correctness
 * controls rather than performance ones:
 *
 *   payment_webhook_events   unique (gateway, eventId)   ← replay protection
 *   payment_webhook_events   TTL on receivedAt, 45 days  ← unbounded growth
 *   payment_transactions     unique sparse merchantRef   ← callback routing
 *   payment_transactions     unique sparse payLink.token ← hosted card page (GAP-008)
 *   plan_purchases           unique sparse merchant_ref  ← callback routing
 *   credit_topups            unique sparse merchant_ref  ← callback routing
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 * `autoIndex` is on, so Mongoose builds all five at boot on its own — and a
 * failed build fails **silently**: the promise rejects into a listener nobody
 * attached and the process comes up healthy. For an ordinary read index that is
 * a slow page. Here it is worse, and specifically:
 *
 * - Without the unique `(gateway, eventId)` index, `PaymentWebhookProcessor`'s
 *   insert-first-wins claim never collides, so **dedup stops working entirely**
 *   and every gateway redelivery is processed again. Nothing else stands in the
 *   way except the `previousStatus !== 'SUCCEEDED'` guard on the fulfilment
 *   path, which is a second line of defence and was never meant to be the first.
 * - Without the sparse-unique `merchantRef` indexes the system still routes
 *   callbacks correctly (the lookups are equality matches, not uniqueness
 *   claims), but they degrade to collection scans on three collections that
 *   grow forever.
 *
 * Running this makes the build explicit, ordered and observable: it either
 * succeeds or prints exactly which index did not build and why.
 *
 * Idempotent: `createIndex` on an index that already exists with the same name
 * and the same spec is a no-op, so re-running is free. It never drops anything —
 * an index that exists under a conflicting SPEC is reported and left alone,
 * because dropping an index on a money collection is a decision a person makes.
 *
 * Run:  npx ts-node scripts/migrate-payment-indexes.ts [--dry-run]
 *       (npm run migrate:payment-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * `payment_webhook_events` is not in `COLLECTIONS` — the model names it inline
 * (`payment-webhook-event.model.ts`). Named here rather than added there so this
 * migration cannot be the thing that changes a collection constant, and the
 * literal is asserted against the model below.
 */
const WEBHOOK_EVENTS_COLLECTION = 'payment_webhook_events';

const TTL_DAYS = 45;

interface PlannedIndex {
  collection: string;
  name: string;
  key: Record<string, IndexDirection>;
  options: Record<string, unknown>;
  why: string;
}

const PLANNED: PlannedIndex[] = [
  {
    collection: WEBHOOK_EVENTS_COLLECTION,
    name: 'webhook_event_dedup',
    key: { gateway: 1, eventId: 1 },
    options: { unique: true },
    why: 'replay protection — the unique constraint IS the concurrency control',
  },
  {
    collection: WEBHOOK_EVENTS_COLLECTION,
    name: 'webhook_event_ttl',
    key: { receivedAt: 1 },
    options: { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 },
    why: `expire accepted callbacks after ${TTL_DAYS} days`,
  },
  {
    collection: COLLECTIONS.PAYMENT_TRANSACTION,
    name: 'payment_merchant_ref',
    key: { merchantRef: 1 },
    options: { unique: true, sparse: true },
    why: 'webhook lookup by OUR reference; sparse because pre-Phase-1 rows have none',
  },
  {
    collection: COLLECTIONS.PAYMENT_TRANSACTION,
    name: 'payment_pay_link_token',
    key: { 'payLink.token': 1 },
    options: { unique: true, sparse: true },
    why: 'the hosted card page (GAP-008) resolves a transaction by its link handle, unauthenticated; sparse because most rows carry no link',
  },
  {
    collection: COLLECTIONS.PLAN_PURCHASE,
    name: 'plan_purchase_merchant_ref',
    key: { merchant_ref: 1 },
    options: { unique: true, sparse: true },
    why: 'settles a mobile-money plan purchase from its callback',
  },
  {
    collection: COLLECTIONS.CREDIT_TOPUP,
    name: 'credit_topup_merchant_ref',
    key: { merchant_ref: 1 },
    options: { unique: true, sparse: true },
    why: 'settles a mobile-money credit top-up from its callback',
  },
];

interface ExistingIndex {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
}

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

/**
 * Does an existing index already satisfy the plan?
 *
 * Compared on the OPTIONS as well as the key: an index on `{merchantRef: 1}`
 * that is not unique is not this index, and reporting it as present would leave
 * the constraint unbuilt while the migration says it is done.
 */
function satisfies(existing: ExistingIndex, planned: PlannedIndex): boolean {
  if (!sameKey(existing.key, planned.key)) return false;
  const wantUnique = planned.options.unique === true;
  const wantSparse = planned.options.sparse === true;
  const wantTtl = planned.options.expireAfterSeconds as number | undefined;
  if (wantUnique !== (existing.unique === true)) return false;
  if (wantSparse !== (existing.sparse === true)) return false;
  if (wantTtl !== undefined && existing.expireAfterSeconds !== wantTtl) return false;
  return true;
}

/** Same key, different options — the case that must be reported, never silently rebuilt. */
function conflicts(existing: ExistingIndex, planned: PlannedIndex): boolean {
  return sameKey(existing.key, planned.key) && !satisfies(existing, planned);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collections = [...new Set(PLANNED.map((p) => p.collection))];
  let built = 0;
  let failed = 0;

  for (const name of collections) {
    const collection = mongoose.connection.collection(name);
    const planned = PLANNED.filter((p) => p.collection === name);

    // A collection that does not exist yet is not an error: the first write
    // creates it, and Mongoose builds these indexes at that point. Report it
    // rather than creating an empty collection as a side effect.
    const present = await mongoose.connection.db!
      .listCollections({ name }, { nameOnly: true })
      .toArray();
    if (present.length === 0) {
      console.log(`\n${name}: does not exist yet — nothing to build (it is created on first write)`);
      continue;
    }

    const existing = (await collection.indexes()) as ExistingIndex[];
    console.log(`\n${name}: ${existing.length} index(es) present`);
    for (const idx of existing) {
      console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}`);
    }

    for (const target of planned) {
      const conflict = existing.find((idx) => conflicts(idx, target));
      if (conflict) {
        console.error(
          `  ✋ ${target.name}: an index on ${JSON.stringify(target.key)} already exists as ` +
            `"${conflict.name}" with different options ` +
            `(unique=${conflict.unique === true}, sparse=${conflict.sparse === true}, ` +
            `expireAfterSeconds=${conflict.expireAfterSeconds ?? 'none'}). ` +
            'Left alone — dropping an index on a money collection is a decision for a person.'
        );
        failed += 1;
        continue;
      }

      if (existing.some((idx) => satisfies(idx, target))) {
        console.log(`  ✔ ${target.name}: already present`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  → ${target.name}: WOULD build ${JSON.stringify(target.key)} — ${target.why}`);
        continue;
      }

      process.stdout.write(`  building ${target.name} ${JSON.stringify(target.key)} … `);
      try {
        await collection.createIndex(target.key as never, { name: target.name, ...target.options });
        console.log('done');
        built += 1;
      } catch (error) {
        console.log('FAILED');
        // The interesting failure is E11000 on a unique build: real duplicate
        // values are already in the collection, and the fix is a data decision.
        console.error(`    ${error instanceof Error ? error.message : String(error)}`);
        failed += 1;
      }
    }
  }

  console.log(
    DRY_RUN
      ? '\nDRY RUN — nothing was built. Re-run without --dry-run to apply.'
      : `\nDone. ${built} index(es) built, ${failed} problem(s).`
  );

  await mongoose.disconnect();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
