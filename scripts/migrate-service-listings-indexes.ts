/**
 * Migration: build the indexes informational service listings depend on
 * (PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md § C-7).
 *
 * ── Why a named migration, when the catch-all would build these too ───────────
 * `migrate:declared-indexes` (the last row of `MIGRATIONS`) would create every index declared
 * on the seven new models. This script exists for the four that are NOT optimisations — each
 * is the only race guard on its path, and a missing one fails silently, as a double charge or
 * a duplicate row rather than as an error:
 *
 *   listing_reveals        { lead_id, field }          UNIQUE  — a double tap charges once
 *   listing_leads          { customer_id, listing_id, window_start } UNIQUE — one lead per window
 *   listing_reveal_blocks  { customer_id, listing_id } UNIQUE where lifted_at: null — one active block
 *   listing_contacts       { listing_id }              UNIQUE  — one contact set per listing
 *
 * plus the two the PUBLIC surface needs to exist at all:
 *
 *   listings  { slug } UNIQUE                  — `/api/public/listings/:slug` resolves one row
 *   listings  $text (title, company, description) — storefront search; `$text` FAILS without it
 *
 * and `provider_contact_consents { customer_id, vendor_id }` UNIQUE, which is what keeps one
 * opt-in per pair when the bot and the website answer at once.
 *
 * ⚠ The specs below MUST match the schemas' declarations exactly (name, key, options), or
 * this run and the catch-all disagree about what exists. `test:service-listings` compares
 * them.
 *
 * `autoIndex` is OFF in production (`lifecycle.ts`), so nothing builds these on boot there.
 * Idempotent: an existing index (same name or same key) is skipped; nothing is dropped and no
 * document is read or written — the pre-production "index migrations only" rule (D-5).
 *
 * Run:  npx ts-node scripts/migrate-service-listings-indexes.ts [--dry-run]
 *       (npm run migrate:service-listings-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

export interface PlannedIndex {
  collection: string;
  name: string;
  key: Record<string, IndexDirection | 'text'>;
  options?: Record<string, unknown>;
  why: string;
}

export const PLANNED: PlannedIndex[] = [
  {
    collection: COLLECTIONS.LISTING_REVEAL,
    name: 'listing_reveal_one_per_field',
    key: { lead_id: 1, field: 1 },
    options: { unique: true },
    why: 'the reveal\'s idempotency — without it a double tap charges the provider twice',
  },
  {
    collection: COLLECTIONS.LISTING_LEAD,
    name: 'listing_lead_one_per_window',
    key: { customer_id: 1, listing_id: 1, window_start: 1 },
    options: { unique: true },
    why: 'one lead per (customer, listing, window) — two would each charge a first-field price',
  },
  {
    collection: COLLECTIONS.LISTING_REVEAL_BLOCK,
    name: 'listing_reveal_block_one_active',
    key: { customer_id: 1, listing_id: 1 },
    options: { unique: true, partialFilterExpression: { lifted_at: null } },
    why: 'one ACTIVE block per (customer, listing); lifted rows stay as history',
  },
  {
    collection: COLLECTIONS.LISTING_CONTACT,
    name: 'listing_contact_one_per_listing',
    key: { listing_id: 1 },
    options: { unique: true },
    why: 'one contact set per listing — a second row would let approve publish the wrong one',
  },
  {
    collection: COLLECTIONS.LISTING,
    name: 'listing_slug_unique',
    key: { slug: 1 },
    options: { unique: true },
    why: 'the public URL resolves exactly one listing',
  },
  {
    collection: COLLECTIONS.LISTING,
    name: 'listing_public_text',
    key: { 'published.title': 'text', 'published.company_name': 'text', 'published.description': 'text' },
    options: {
      default_language: 'none',
      weights: { 'published.title': 5, 'published.company_name': 3, 'published.description': 1 },
    },
    why: 'storefront search — a $text query errors outright when no text index exists',
  },
  {
    collection: COLLECTIONS.PROVIDER_CONTACT_CONSENT,
    name: 'provider_consent_one_per_pair',
    key: { customer_id: 1, vendor_id: 1 },
    options: { unique: true },
    why: 'one opt-in record per (customer, provider), whichever channel answers first',
  },
];

/** A text index is REPORTED as `{_fts:'text',_ftsx:1}`, so it is matched by name only. */
function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const missing: PlannedIndex[] = [];

  for (const planned of PLANNED) {
    const collection = mongoose.connection.collection(planned.collection);
    // A collection that does not exist yet THROWS rather than reporting no indexes — the
    // normal state for every one of these on a database that has never seen a listing.
    let existing: Array<{ name?: string; key: Record<string, unknown> }>;
    try {
      existing = (await collection.indexes()) as never;
    } catch {
      existing = [];
    }

    const present = existing.some(
      (idx) => idx.name === planned.name || sameKey(idx.key as Record<string, unknown>, planned.key),
    );
    if (!present) missing.push(planned);
  }

  if (missing.length === 0) {
    console.log('\nNothing to do — every service-listings index is already present.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${missing.length} index(es) to build:`);
  for (const planned of missing) {
    console.log(`  ${planned.collection}.${planned.name}  ${JSON.stringify(planned.key)}   — ${planned.why}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was built. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  for (const planned of missing) {
    process.stdout.write(`  building ${planned.collection}.${planned.name} … `);
    await mongoose.connection
      .collection(planned.collection)
      .createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
    console.log('done');
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

// Guarded: `test:service-listings` imports PLANNED to compare it with the schemas, and a
// DB-free unit test must never apply a migration.
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
