/**
 * Migration: let the saved list hold service listings — swap the wishlist's product-uniqueness
 * index for a partial one, and build the listing one beside it (LISTING-REVIEWS-SAVES-REFERRALS-PLAN
 * § 3.2, owner RS-1, 2026-11-08).
 *
 * ── Why the old index has to go ─────────────────────────────────────────────
 * `{ customer_id, product_id }` UNIQUE covered every row. A saved LISTING has no `product_id`, and
 * a plain unique index reads a missing field as `null` — so a customer's second saved listing
 * would collide with their first and the save would answer a 409 from the database. Each kind is
 * now unique on its own id, among the rows that have one:
 *
 *   wishlist_one_product_per_customer  { customer_id, product_id }  UNIQUE, partial: product_id is an ObjectId
 *   wishlist_one_listing_per_customer  { customer_id, listing_id }  UNIQUE, partial: listing_id is an ObjectId
 *
 * The old index exists under one of two names, depending on what built it:
 * `wishlist_customer_product_unique` (`migrate:customer-catalog-indexes`) or Mongoose's default
 * `customer_id_1_product_id_1` (`migrate:declared-indexes`, or `autoIndex` in development). This
 * drops whichever NON-partial unique index sits on that key, by inspection, never by a guessed name.
 *
 * ── Build first, drop second ─────────────────────────────────────────────────
 * So uniqueness never lapses: between the two, both constraints hold and the old one is the
 * stricter (the shape `migrate:reviews-publish-all` uses). If the server refuses a second index on
 * the same key (code 85/86), the old one is dropped first and the new one built straight after —
 * a window of milliseconds in which a double tap could write a duplicate, which `--dry-run` says.
 *
 * No data is written. Rows saved before 2026-11-08 carry no `kind` and are read as products
 * (`kindOfWishlistRow`), so there is no backfill (pre-production D-5 needs none either).
 *
 * Runs among the data migrations, before the index builds: `migrate:customer-catalog-indexes`
 * then finds its key present (it matches by key as well as name) and builds nothing, so a fresh
 * database never receives the old non-partial index after this one.
 *
 * Idempotent: a second run finds both new indexes and no old one, and writes nothing.
 *
 * Run:  npx ts-node scripts/migrate-wishlist-listing-kind.ts [--dry-run]
 *       (npm run migrate:wishlist-listing-kind)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const PRODUCT_INDEX = 'wishlist_one_product_per_customer';
const LISTING_INDEX = 'wishlist_one_listing_per_customer';

interface LiveIndex {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: unknown;
}

const isProductKey = (key: Record<string, unknown>): boolean => {
  const k = Object.keys(key);
  return k.length === 2 && k[0] === 'customer_id' && k[1] === 'product_id' && key.customer_id === 1 && key.product_id === 1;
};

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const items = mongoose.connection.collection(COLLECTIONS.WISHLIST_ITEM);
  let existing: LiveIndex[] = [];
  try {
    existing = (await items.indexes()) as never;
  } catch {
    console.log(`\n${COLLECTIONS.WISHLIST_ITEM}: does not exist yet — the new indexes will create it`);
  }

  const hasProduct = existing.some((i) => i.name === PRODUCT_INDEX);
  const hasListing = existing.some((i) => i.name === LISTING_INDEX);
  const old = existing.filter((i) => i.name !== PRODUCT_INDEX && isProductKey(i.key) && !i.partialFilterExpression);

  console.log(`\nIndex ${PRODUCT_INDEX}: ${hasProduct ? 'present' : 'MISSING — will build'}`);
  console.log(`Index ${LISTING_INDEX}: ${hasListing ? 'present' : 'MISSING — will build'}`);
  console.log(
    old.length
      ? `Old non-partial product index: ${old.map((i) => i.name).join(', ')} — will drop after the new one is built`
      : 'Old non-partial product index: absent',
  );
  const listingRows = await items.countDocuments({ kind: 'listing' }).catch(() => 0);
  console.log(`Saved listings already present: ${listingRows}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
    console.log('(If the server refuses two indexes on one key, the old is dropped first: a window of milliseconds.)');
    await mongoose.disconnect();
    return;
  }

  const productSpec = { customer_id: 1, product_id: 1 } as const;
  const productOptions = {
    name: PRODUCT_INDEX,
    unique: true,
    partialFilterExpression: { product_id: { $type: 'objectId' } },
  };

  if (!hasProduct) {
    process.stdout.write(`\n  building ${PRODUCT_INDEX} … `);
    try {
      await items.createIndex(productSpec, productOptions);
      console.log('done');
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 85 && code !== 86) throw error;
      console.log(`refused (code ${code}: one index per key) — dropping the old one first`);
      for (const o of old) {
        process.stdout.write(`  dropping ${o.name} … `);
        await items.dropIndex(o.name as string);
        console.log('done');
      }
      old.length = 0;
      process.stdout.write(`  building ${PRODUCT_INDEX} … `);
      await items.createIndex(productSpec, productOptions);
      console.log('done');
    }
  }
  for (const o of old) {
    process.stdout.write(`  dropping ${o.name} … `);
    await items.dropIndex(o.name as string);
    console.log('done');
  }
  if (!hasListing) {
    process.stdout.write(`  building ${LISTING_INDEX} … `);
    await items.createIndex(
      { customer_id: 1, listing_id: 1 },
      { name: LISTING_INDEX, unique: true, partialFilterExpression: { listing_id: { $type: 'objectId' } } },
    );
    console.log('done');
  }

  console.log('\nDone. A customer can now save several service listings beside their products.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\nMigration failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
