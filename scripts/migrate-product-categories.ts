/**
 * Migration: convert every product's free-text `category` into the shared category list.
 *
 * Owner decision C-5 (2026-10-04, PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md): products
 * already in production keep a category. Each old string is run through the SAME matcher the
 * product editor uses (`modules/categories/domain/category-match.ts`), so "wellness",
 * "Wellness" and "Wellness " become one category, not three — the conversion is the first
 * real exercise of the duplicate guard, not a copy of the mess it exists to prevent.
 *
 * ── Per distinct old value, most-used first ─────────────────────────────────
 *
 * Values are processed in descending product count, so the spelling most products already
 * use is the one that becomes the category's display name, and rarer variants land on it.
 *
 *   exact    an existing (or earlier-in-this-run) category is the same spelling → reused.
 *   similar  a probable typo of one → reused as well. The editor would ASK here; a script has
 *            nobody to ask, and the alternative is a duplicate created by a migration — which
 *            an administrator would then have to merge by hand. Every such collapse is PRINTED,
 *            so the dry run is where a wrong one is caught (and an admin rename/merge fixes it).
 *   new      created, `created_source: 'migration'`.
 *
 * A value that cannot be a category name (over 60 characters, or no letter at all) is
 * shortened at a word boundary; one with no usable characters lands on "Other". Both are
 * printed.
 *
 * ── What is written ──────────────────────────────────────────────────────────
 *
 * `categoryIds` gets the resolved id (added, never replacing — a product already edited
 * through the new API keeps what it chose, and the old value joins it only if absent), and
 * the old `category` field is `$unset`. Soft-deleted products are converted too: a restore
 * must not bring back a product with no category. The two superseded indexes on the old
 * field (`category_1`, `product_storefront_category`) are DROPPED at the end, once nothing
 * holds the field they index.
 *
 * Idempotent: a second run finds no string `category` and changes nothing. `--dry-run`
 * prints the whole mapping and writes NOTHING — no category, no product, no index drop.
 *
 * Run:  npx ts-node scripts/migrate-product-categories.ts [--dry-run]
 *       (npm run migrate:product-categories)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import {
    CategoryCandidate,
    CATEGORY_NAME_MAX_LENGTH,
    cleanCategoryName,
    matchCategory,
    matchKey,
} from '../src/modules/categories/domain/category-match';
import { categoryResolutionService } from '../src/modules/categories/services/category-resolution.service';
import { productCategoryRepository } from '../src/modules/categories/repositories/product-category.repository';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const FALLBACK_NAME = 'Other';
const SUPERSEDED_INDEXES = ['category_1', 'product_storefront_category'];

/** A usable category name from any old value — shortened, or the fallback. */
export function nameFromLegacy(raw: string): { name: string; note: string | null } {
    const direct = cleanCategoryName(raw);
    if (direct) return { name: direct, note: null };
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length > CATEGORY_NAME_MAX_LENGTH) {
        const cut = collapsed.slice(0, CATEGORY_NAME_MAX_LENGTH + 1);
        const atWord = cut.lastIndexOf(' ') > 20 ? cut.slice(0, cut.lastIndexOf(' ')) : cut.slice(0, CATEGORY_NAME_MAX_LENGTH);
        const shortened = cleanCategoryName(atWord);
        if (shortened) return { name: shortened, note: `shortened from ${collapsed.length} characters` };
    }
    return { name: FALLBACK_NAME, note: 'no usable characters — filed under the fallback' };
}

interface PlanRow {
    raw: string;
    products: number;
    name: string;
    outcome: 'existing' | 'similar' | 'created';
    target: string;
    note: string | null;
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

    const products = mongoose.connection.collection(COLLECTIONS.PRODUCT);

    const groups = await products
        .aggregate<{ _id: string; count: number }>([
            { $match: { category: { $type: 'string' } } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
        ])
        .toArray();

    if (groups.length === 0) {
        console.log('\nNo product carries a string `category` — nothing to convert.');
    }

    // The plan is computed against an in-memory list in BOTH modes, so the dry run shows
    // exactly what the real run would do: live categories, plus each one this run creates.
    const live = await productCategoryRepository.listLive();
    const catalog: CategoryCandidate[] = live.map((r) => ({
        id: r._id.toString(),
        name: r.name,
        slug: r.slug,
        matchKey: r.match_key,
        aliasKeys: r.alias_keys ?? [],
    }));

    const plan: PlanRow[] = [];
    for (const group of groups) {
        const { name, note } = nameFromLegacy(group._id);
        const verdict = matchCategory(name, catalog);
        if (verdict.kind === 'exact') {
            plan.push({ raw: group._id, products: group.count, name, outcome: 'existing', target: verdict.category.name, note });
        } else if (verdict.kind === 'similar') {
            plan.push({ raw: group._id, products: group.count, name, outcome: 'similar', target: verdict.suggestions[0].name, note });
        } else {
            catalog.push({ id: `planned:${catalog.length}`, name, slug: '', matchKey: matchKey(name), aliasKeys: [] });
            plan.push({ raw: group._id, products: group.count, name, outcome: 'created', target: name, note });
        }
    }

    if (plan.length > 0) {
        console.log(`\n${plan.length} distinct old value(s) across ${plan.reduce((s, p) => s + p.products, 0)} product(s):\n`);
        for (const p of plan) {
            const arrow = p.outcome === 'created' ? 'NEW     ' : p.outcome === 'existing' ? 'same as ' : 'TYPO of ';
            console.log(`  ${JSON.stringify(p.raw).padEnd(40)} ×${String(p.products).padStart(4)}  → ${arrow}"${p.target}"${p.note ? `   (${p.note})` : ''}`);
        }
        const collapsed = plan.filter((p) => p.outcome === 'similar');
        if (collapsed.length > 0) {
            console.log(`\n⚠ ${collapsed.length} value(s) were judged TYPOS of an existing category and will be merged into it.`);
            console.log('  Check them above. A wrong one is fixed afterwards with an admin rename, not by re-running this.');
        }
    }

    const existingIndexes = await products.indexes();
    const toDrop = existingIndexes.filter((i) => SUPERSEDED_INDEXES.includes(String(i.name)));
    if (toDrop.length > 0) {
        console.log(`\nSuperseded index(es) to drop: ${toDrop.map((i) => i.name).join(', ')}`);
    }

    if (DRY_RUN) {
        console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
        await mongoose.disconnect();
        return;
    }

    let converted = 0;
    for (const p of plan) {
        // Resolve for real through the service, in the same order the plan used, so creation
        // goes through the unique-index race guard rather than a bare insert.
        const resolved = await categoryResolutionService.resolveUnattended(p.name, { source: 'migration', vendorId: null });
        if (!resolved) {
            // Unreachable: `nameFromLegacy` always returns a cleanable name.
            console.error(`  ✖ could not resolve "${p.raw}" — left unconverted`);
            continue;
        }
        const res = await products.updateMany(
            { category: p.raw },
            [
                {
                    $set: {
                        categoryIds: {
                            $cond: [
                                { $in: [resolved.id, { $ifNull: ['$categoryIds', []] }] },
                                { $ifNull: ['$categoryIds', []] },
                                { $concatArrays: [{ $ifNull: ['$categoryIds', []] }, [resolved.id]] },
                            ],
                        },
                    },
                },
                { $unset: 'category' },
            ],
        );
        converted += res.modifiedCount;
    }
    console.log(`\nConverted ${converted} product(s).`);

    const stillString = await products.countDocuments({ category: { $type: 'string' } });
    if (stillString > 0) {
        console.error(`✖ ${stillString} product(s) still carry a string category — indexes NOT dropped. Investigate, then re-run.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    for (const idx of toDrop) {
        await products.dropIndex(String(idx.name));
        console.log(`  dropped ${idx.name}`);
    }

    console.log('\nDone. `npm run migrate:storefront-indexes` builds the multikey replacement.');
    await mongoose.disconnect();
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
