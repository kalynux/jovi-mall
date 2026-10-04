/**
 * Test: product categories — one shared list, 1–5 per product, and the duplicate guard.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the matcher is pure, and `CategoryResolutionService` takes its repository and
 * its cache through the constructor, so the whole write path — including the unique-index
 * race — runs against a fake.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 *
 * Owner decisions C-1…C-6 (PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md). The one this
 * suite exists for is C-3: **variants merge silently, look-alikes are ASKED about, and
 * nothing else is ever merged.** Both failure directions are real and both are pinned:
 *
 *   - too lax  → "Shoes", "shoes", "Shoe" become three chips on the storefront;
 *   - too eager → "Cap" silently becomes "Cup", and a vendor's product lands on a shelf they
 *                 never chose, with no prompt to tell them.
 *
 * The singular rule is asserted for CONSISTENCY (both forms reach one key), never for
 * producing a real word — `movie` and `movies` both become `movy`, and that is correct.
 *
 * Run: npm run test:product-categories
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';
import {
    CategoryCandidate,
    categoryTokens,
    cleanCategoryName,
    editDistance,
    matchCategory,
    matchKey,
    MAX_CATEGORIES_PER_PRODUCT,
    searchCategories,
    singularToken,
    slugifyCategory,
    typoAllowance,
} from '../../src/modules/categories/domain/category-match';
import { CategoryCatalogCache } from '../../src/modules/categories/services/category-catalog.cache';
import { CategoryResolutionService } from '../../src/modules/categories/services/category-resolution.service';
import { categoryRefsFromBody } from '../../src/modules/categories/services/category-input';
import { ProductCategoriesSchema, CategoryRefSchema } from '../../src/modules/categories/validators/category.validator';
import { CreateProductSchema, UpdateProductSchema } from '../../src/modules/catalog/validators/product.validator';
import {
    CreateSimpleProductSchema,
    UpdateSimpleProductSchema,
} from '../../src/modules/catalog/validators/simple-product.validator';
import { AppError, DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { categoryFor } from '../../src/core/error-category';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;
const pending: Array<{ name: string; fn: () => boolean | Promise<boolean> }> = [];

function assert(name: string, fn: () => boolean | Promise<boolean>): void {
    pending.push({ name, fn });
}

function section(title: string): void {
    pending.push({ name: `§ ${title}`, fn: () => true });
}

async function errorOf(fn: () => Promise<unknown>): Promise<AppError | null> {
    try {
        await fn();
        return null;
    } catch (err) {
        if (err instanceof AppError) return err;
        throw err;
    }
}

const SRC = join(__dirname, '../../src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8');
/** Strip comments so a scan reads code, not the explanation of what was removed. */
const code = (rel: string): string =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ─────────────────────────────────────────────────────────────────────────────
//  The fake repository
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
    _id: Types.ObjectId;
    name: string;
    slug: string;
    match_key: string;
    alias_keys: string[];
    created_source: 'vendor' | 'admin' | 'migration';
    created_by_vendor_id: Types.ObjectId | null;
    merged_into: Types.ObjectId | null;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

class FakeCategoryRepo {
    rows: Row[] = [];
    creates = 0;
    /** When set, the next create throws E11000 on match_key after planting this winner. */
    raceWinner: Row | null = null;

    seed(name: string, extra: Partial<Row> = {}): Row {
        const row: Row = {
            _id: new Types.ObjectId(),
            name,
            slug: slugifyCategory(name),
            match_key: matchKey(name),
            alias_keys: [],
            created_source: 'admin',
            created_by_vendor_id: null,
            merged_into: null,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...extra,
        };
        this.rows.push(row);
        return row;
    }

    async listLive() { return this.rows.filter((r) => r.deletedAt === null); }
    async findLiveById(id: string) { return this.rows.find((r) => r._id.toString() === id && r.deletedAt === null) ?? null; }
    async findAnyById(id: string) { return this.rows.find((r) => r._id.toString() === id) ?? null; }
    async findLiveByMatchKey(key: string) { return this.rows.find((r) => r.match_key === key && r.deletedAt === null) ?? null; }
    async slugTaken(slug: string) { return this.rows.some((r) => r.slug === slug && r.deletedAt === null); }
    async create(input: { name: string; slug: string; match_key: string; created_source: Row['created_source']; created_by_vendor_id: string | null }) {
        if (this.raceWinner) {
            this.rows.push(this.raceWinner);
            this.raceWinner = null;
            throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern: { match_key: 1 } });
        }
        if (this.rows.some((r) => r.match_key === input.match_key && r.deletedAt === null)) {
            throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern: { match_key: 1 } });
        }
        this.creates++;
        return this.seed(input.name, {
            slug: input.slug,
            created_source: input.created_source,
            created_by_vendor_id: input.created_by_vendor_id ? new Types.ObjectId(input.created_by_vendor_id) : null,
        });
    }
}

function world(names: string[] = []) {
    const repo = new FakeCategoryRepo();
    for (const n of names) repo.seed(n);
    const cache = new CategoryCatalogCache(repo as never);
    const service = new CategoryResolutionService(repo as never, cache);
    return { repo, cache, service };
}

const VENDOR = { source: 'vendor' as const, vendorId: new Types.ObjectId().toString() };

const candidates = (...names: string[]): CategoryCandidate[] =>
    names.map((name, i) => ({ id: `id${i}`, name, slug: slugifyCategory(name), matchKey: matchKey(name), aliasKeys: [] }));

// ─────────────────────────────────────────────────────────────────────────────
//  1. Display clean-up
// ─────────────────────────────────────────────────────────────────────────────

section('1. cleanCategoryName');

assert('trims and collapses inner whitespace, keeps the author\'s case', () =>
    cleanCategoryName('  TV   &  Audio ') === 'TV & Audio');
assert('refuses empty, one character, and over 60', () =>
    cleanCategoryName('   ') === null && cleanCategoryName('a') === null && cleanCategoryName('x'.repeat(61)) === null);
assert('accepts exactly 60', () => cleanCategoryName('x'.repeat(60)) === 'x'.repeat(60));
assert('refuses a name with no letter or digit', () => cleanCategoryName('!!! ---') === null);
assert('NFC-normalises a decomposed accent so it stores as the typed one', () =>
    cleanCategoryName('Café') === 'Café');

// ─────────────────────────────────────────────────────────────────────────────
//  2. The key — the same shelf spelled differently
// ─────────────────────────────────────────────────────────────────────────────

section('2. matchKey: variants reach ONE key');

const sameKey = (a: string, b: string) => matchKey(a) === matchKey(b);
const pairs: Array<[string, string, string]> = [
    ['Shoes', 'shoe', 'EN plural'],
    ['SHOES', ' shoes ', 'case and spacing'],
    ['T-shirt', 'T shirt', 'hyphen vs space'],
    ['T-shirts', 'Tshirt', 'compound + plural'],
    ['Chaussures', 'chaussure', 'FR plural -s'],
    ['Chapeaux', 'chapeau', 'FR -eaux'],
    ['Bijoux', 'bijou', 'FR -oux'],
    ['Jeux vidéo', 'jeu video', 'FR -eux + accent'],
    ['Journaux', 'journal', 'FR -aux → -al'],
    ['Accessories', 'accessory', 'EN -ies'],
    ['Movies', 'movie', '-ies / -ie pair'],
    ['Séries', 'series', '-ie pair across accents'],
    ['Boxes', 'box', 'EN -xes'],
    ['Watches', 'watch', 'EN -ches'],
    ['Glasses', 'glass', 'EN -sses'],
    ["Men's Shoes", 'Mens shoe', 'possessive'],
    ['Bags & Shoes', 'Bags and Shoes', '& vs and'],
    ['Sacs et chaussures', 'Sac & chaussure', 'FR connector'],
    ['Électronique', 'electronique', 'accent'],
];
for (const [a, b, why] of pairs) {
    assert(`"${a}" ≡ "${b}" (${why})`, () => sameKey(a, b));
}

assert('words that END in s without being plurals keep it (dress, bus, tennis)', () =>
    singularToken('dress') === 'dress' && singularToken('bus') === 'bus' && singularToken('tennis') === 'tennis');
assert('short tokens are left alone (gas, pie)', () => singularToken('gas') === 'gas' && singularToken('pie') === 'pie');
assert('different shelves stay different keys (Shoes / Shirts, Cap / Cup)', () =>
    !sameKey('Shoes', 'Shirts') && !sameKey('Cap', 'Cup'));
assert('connectors are dropped as tokens', () => categoryTokens('Bags and Shoes').join(' ') === 'bag shoe');
assert('slug is ASCII, hyphenated, accent-free, & spelled out', () =>
    slugifyCategory('Maison & Électronique') === 'maison-and-electronique');
assert('a name with no ASCII letters still gets a slug', () => slugifyCategory('家具') === 'category');

// ─────────────────────────────────────────────────────────────────────────────
//  3. The verdict
// ─────────────────────────────────────────────────────────────────────────────

section('3. matchCategory: exact / similar / new');

const shelf = candidates('Shoes', 'Electronics', 'Men Shoes', 'Cap', 'Accessoires');

assert('an exact variant is EXACT via the name', () => {
    const v = matchCategory('shoe', shelf);
    return v.kind === 'exact' && v.category.name === 'Shoes' && v.via === 'name';
});
assert('a one-letter slip is SIMILAR, never exact ("Shose" → Shoes)', () => {
    const v = matchCategory('Shose', shelf);
    return v.kind === 'similar' && v.suggestions[0].name === 'Shoes';
});
assert('a transposition on a long name is SIMILAR ("Electornics")', () => {
    const v = matchCategory('Electornics', shelf);
    return v.kind === 'similar' && v.suggestions[0].name === 'Electronics';
});
assert('a dropped letter is SIMILAR ("Accesoires")', () => {
    const v = matchCategory('Accesoires', shelf);
    return v.kind === 'similar' && v.suggestions[0].name === 'Accessoires';
});
assert('the same words in another order are SIMILAR ("Shoes Men")', () => {
    const v = matchCategory('Shoes Men', shelf);
    return v.kind === 'similar' && v.suggestions.some((s) => s.name === 'Men Shoes');
});
assert('⛔ under 4 characters nothing is suggested — "Cup" is NEW, not Cap', () =>
    matchCategory('Cup', shelf).kind === 'new');
assert('an unrelated name is NEW', () => matchCategory('Garden Tools', shelf).kind === 'new');
assert('an alias is EXACT via alias (a merge is remembered)', () => {
    const merged = [{ ...candidates('Shoes')[0], aliasKeys: [matchKey('Chaussures')] }];
    const v = matchCategory('chaussure', merged);
    return v.kind === 'exact' && v.via === 'alias' && v.category.name === 'Shoes';
});
assert('an own-name hit outranks an alias hit', () => {
    const list: CategoryCandidate[] = [
        { ...candidates('Bags')[0], id: 'a', aliasKeys: [matchKey('Totes')] },
        { ...candidates('Totes')[0], id: 'b' },
    ];
    const v = matchCategory('Tote', list);
    return v.kind === 'exact' && v.category.id === 'b';
});
assert('at most 3 suggestions', () => {
    const many = candidates('Shoex', 'Shoey', 'Shoez', 'Shoew', 'Shoev');
    const v = matchCategory('Shoeq', many);
    return v.kind === 'similar' && v.suggestions.length === 3;
});
assert('typoAllowance: 0 under 4, 1 for 4–7, 2 from 8', () =>
    typoAllowance('cap', 'cup') === 0 && typoAllowance('shoe', 'shoz') === 1 && typoAllowance('electronic', 'electronix') === 2);
assert('editDistance counts a transposition as ONE edit', () => editDistance('shose', 'shoes') === 1);
assert('editDistance exits early past its bound', () => editDistance('abcdefgh', 'zzzzzzzz', 2) > 2);
assert('autocomplete ranks exact, then prefix, then contains, then typo', () => {
    const list = candidates('Shoes', 'Shoe Polish', 'Snow Shoes', 'Shose Rack');
    const hits = searchCategories('shoe', list, 10).map((h) => `${h.category.name}:${h.match}`);
    return hits[0] === 'Shoes:exact' && hits.includes('Shoe Polish:prefix') && hits.includes('Snow Shoes:contains');
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. The write path
// ─────────────────────────────────────────────────────────────────────────────

section('4. resolveForWrite');

assert('an exact variant REUSES the existing category and creates nothing', async () => {
    const { repo, service } = world(['Shoes']);
    const ids = await service.resolveForWrite([{ name: 'shoe' }], VENDOR);
    return ids.length === 1 && ids[0].equals(repo.rows[0]._id) && repo.creates === 0;
});
assert('a genuinely new name is CREATED, stamped with the vendor', async () => {
    const { repo, service } = world(['Shoes']);
    const ids = await service.resolveForWrite([{ name: 'Garden Tools' }], VENDOR);
    const row = repo.rows.find((r) => r._id.equals(ids[0]))!;
    return repo.creates === 1 && row.name === 'Garden Tools' && row.created_source === 'vendor'
        && row.created_by_vendor_id?.toString() === VENDOR.vendorId;
});
assert('a look-alike is REFUSED with 422 CATEGORY_SIMILAR_EXISTS and nothing is created', async () => {
    const { repo, service } = world(['Shoes', 'Electronics']);
    const e = await errorOf(() => service.resolveForWrite([{ name: 'Garden' }, { name: 'Shose' }, { name: 'Electornics' }], VENDOR));
    const conflicts = (e?.details as { conflicts?: Array<{ name: string; suggestions: Array<{ name: string }> }> })?.conflicts ?? [];
    return e?.code === ERROR_CODES.CATEGORY_SIMILAR_EXISTS && e.statusCode === 422
        && conflicts.length === 2 // EVERY conflict at once, so the editor asks once
        && conflicts[0].suggestions[0].name === 'Shoes'
        && repo.creates === 0; // not even the genuinely new "Garden"
});
assert('confirmNew: true creates the look-alike anyway', async () => {
    const { repo, service } = world(['Shoes']);
    await service.resolveForWrite([{ name: 'Shose', confirmNew: true }], VENDOR);
    return repo.creates === 1 && repo.rows.some((r) => r.name === 'Shose');
});
assert('two variants of ONE new name in one request make ONE category', async () => {
    const { repo, service } = world();
    const ids = await service.resolveForWrite([{ name: 'Garden Tool' }, { name: 'garden tools' }], VENDOR);
    return repo.creates === 1 && ids.length === 1;
});
assert('the vendor\'s ORDER is kept (first = primary) and duplicates are dropped', async () => {
    const { repo, service } = world(['Shoes', 'Bags']);
    const [shoes, bags] = repo.rows;
    const ids = await service.resolveForWrite([{ id: bags._id.toString() }, { name: 'shoe' }, { id: bags._id.toString() }], VENDOR);
    return ids.length === 2 && ids[0].equals(bags._id) && ids[1].equals(shoes._id);
});
assert('an unknown { id } is 404 CATEGORY_NOT_FOUND', async () => {
    const { service } = world(['Shoes']);
    const e = await errorOf(() => service.resolveForWrite([{ id: new Types.ObjectId().toString() }], VENDOR));
    return e?.code === ERROR_CODES.CATEGORY_NOT_FOUND && e.statusCode === 404;
});
assert('a merged-away (soft-deleted) { id } is 404 — the editor must re-pick', async () => {
    const { repo, service } = world(['Shoes']);
    repo.rows[0].deletedAt = new Date();
    const e = await errorOf(() => service.resolveForWrite([{ id: repo.rows[0]._id.toString() }], VENDOR));
    return e?.code === ERROR_CODES.CATEGORY_NOT_FOUND;
});
assert('an unusable name is 400 CATEGORY_NAME_INVALID', async () => {
    const { service } = world();
    const e = await errorOf(() => service.resolveForWrite([{ name: '!!' }], VENDOR));
    return e?.code === ERROR_CODES.CATEGORY_NAME_INVALID && e.statusCode === 400;
});
assert('⛔ losing a creation RACE reuses the winner — never a duplicate, never an error', async () => {
    const { repo, service } = world();
    repo.raceWinner = {
        _id: new Types.ObjectId(), name: 'Garden Tools', slug: 'garden-tools', match_key: matchKey('Garden Tools'),
        alias_keys: [], created_source: 'vendor', created_by_vendor_id: null, merged_into: null,
        deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const winnerId = repo.raceWinner._id;
    const ids = await service.resolveForWrite([{ name: 'garden tool' }], VENDOR);
    return ids[0].equals(winnerId) && repo.rows.filter((r) => r.match_key === matchKey('Garden Tools')).length === 1;
});
assert('a slug already taken by a different category gets a suffix', async () => {
    const { repo, service } = world();
    repo.seed('Garden Tools ZZ', { slug: 'garden-tools', match_key: 'somethingelse' });
    const ids = await service.resolveForWrite([{ name: 'Garden Tools' }], VENDOR);
    return repo.rows.find((r) => r._id.equals(ids[0]))!.slug === 'garden-tools-2';
});
assert('a brand-new category is visible to the next lookup at once (local invalidate)', async () => {
    const { service } = world();
    await service.resolveForWrite([{ name: 'Garden Tools' }], VENDOR);
    const v = await service.check(['garden tool']);
    return v[0].status === 'existing';
});

section('4b. check (the "before saving" probe) writes nothing');

assert('check answers existing / similar / new / invalid and creates nothing', async () => {
    const { repo, service } = world(['Shoes']);
    const v = await service.check(['shoes', 'Shose', 'Garden', '!!']);
    return v.map((x) => x.status).join() === 'existing,similar,new,invalid' && repo.creates === 0;
});

section('4c. resolveUnattended (the data conversion)');

assert('a look-alike is folded into the existing category — a script has nobody to ask', async () => {
    const { repo, service } = world(['Wellness']);
    const r = await service.resolveUnattended('Welness', { source: 'migration', vendorId: null });
    return r?.outcome === 'similar' && r.id.equals(repo.rows[0]._id) && repo.creates === 0;
});
assert('a new value is created with source migration', async () => {
    const { repo, service } = world();
    const r = await service.resolveUnattended('wellness', { source: 'migration', vendorId: null });
    return r?.outcome === 'created' && repo.rows[0].created_source === 'migration';
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Filters from URLs and chats
// ─────────────────────────────────────────────────────────────────────────────

section('5. resolveFilter');

assert('resolves by id, by slug and by an exact name variant', async () => {
    const { repo, service } = world(['Maison & Électronique']);
    const row = repo.rows[0];
    const byId = await service.resolveFilter(row._id.toString());
    const bySlug = await service.resolveFilter('maison-and-electronique');
    const byName = await service.resolveFilter('maison et electronique');
    return byId?.id === row._id.toString() && bySlug?.id === row._id.toString() && byName?.id === row._id.toString();
});
assert('⛔ a TYPO does not resolve — a filter must not show a shelf nobody asked for', async () => {
    const { service } = world(['Electronics']);
    return (await service.resolveFilter('Electornics')) === null;
});
assert('a merged-away id is followed to its survivor (old links keep working)', async () => {
    const { repo, service } = world(['Shoes', 'Chaussures']);
    const [shoes, chaussures] = repo.rows;
    chaussures.deletedAt = new Date();
    chaussures.merged_into = shoes._id;
    const r = await service.resolveFilter(chaussures._id.toString());
    return r?.id === shoes._id.toString();
});
assert('unknown is null, not an error', async () => {
    const { service } = world(['Shoes']);
    return (await service.resolveFilter('nothing-like-this')) === null;
});

section('5b. name resolution for product reads');

assert('refsFor keeps the product\'s order and drops an id the list does not know', async () => {
    const { repo, cache } = world(['Shoes', 'Bags']);
    const [shoes, bags] = repo.rows;
    const refs = await cache.refsFor([bags._id, new Types.ObjectId(), shoes._id]);
    return refs.map((r) => r.name).join() === 'Bags,Shoes';
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. The request contract
// ─────────────────────────────────────────────────────────────────────────────

section('6. Validators');

const base = { type: 'physical', title: 'Ankara dress', description: 'Handmade' };
const simple = { title: 'Simple Shoes', description: 'Comfy.', price: 15000 };

assert('1–5 entries; 0 and 6 are refused', () =>
    !ProductCategoriesSchema.safeParse([]).success
    && ProductCategoriesSchema.safeParse([{ name: 'a' }]).success
    && !ProductCategoriesSchema.safeParse(Array.from({ length: MAX_CATEGORIES_PER_PRODUCT + 1 }, () => ({ name: 'x' }))).success);
assert('an entry is { id } or { name, confirmNew? } — strict, nothing else', () =>
    CategoryRefSchema.safeParse({ id: '507f1f77bcf86cd799439011' }).success
    && CategoryRefSchema.safeParse({ name: 'Shoes', confirmNew: true }).success
    && !CategoryRefSchema.safeParse({ id: 'not-an-id' }).success
    && !CategoryRefSchema.safeParse({ name: 'Shoes', slug: 'shoes' }).success);
assert('layered create REQUIRES a category (either field)', () =>
    !CreateProductSchema.safeParse(base).success
    && CreateProductSchema.safeParse({ ...base, categories: [{ name: 'Fashion' }] }).success
    && CreateProductSchema.safeParse({ ...base, category: 'Fashion' }).success);
assert('simple create REQUIRES a category and its .strict() accepts `categories`', () =>
    !CreateSimpleProductSchema.safeParse(simple).success
    && CreateSimpleProductSchema.safeParse({ ...simple, categories: [{ name: 'Footwear' }] }).success
    && CreateSimpleProductSchema.safeParse({ ...simple, category: 'footwear' }).success);
assert('both updates accept `categories` and leave it optional', () =>
    UpdateProductSchema.safeParse({ categories: [{ name: 'Fashion' }] }).success
    && UpdateSimpleProductSchema.safeParse({ categories: [{ name: 'Fashion' }] }).success
    && UpdateSimpleProductSchema.safeParse({ title: 'New title' }).success);
assert('categoryRefsFromBody: the legacy single string becomes one { name }', () => {
    const refs = categoryRefsFromBody({ category: 'Fashion' });
    return refs?.length === 1 && (refs[0] as { name: string }).name === 'Fashion';
});
assert('categoryRefsFromBody: neither field means "leave alone" (undefined)', () =>
    categoryRefsFromBody({}) === undefined);
assert('categoryRefsFromBody: BOTH fields are refused, never guessed', () => {
    try {
        categoryRefsFromBody({ categories: [{ name: 'a' }], category: 'b' });
        return false;
    } catch (e) {
        return e instanceof AppError && e.code === ERROR_CODES.CATEGORY_NAME_INVALID;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. Errors
// ─────────────────────────────────────────────────────────────────────────────

section('7. Error codes');

const codes: Array<[keyof typeof ERROR_CODES, number, string]> = [
    ['CATEGORY_SIMILAR_EXISTS', 422, 'business_rule'],
    ['CATEGORY_NAME_INVALID', 400, 'validation'],
    ['CATEGORY_NOT_FOUND', 404, 'not_found'],
    ['CATEGORY_NAME_TAKEN', 409, 'conflict'],
    ['CATEGORY_IN_USE', 409, 'conflict'],
    ['CATEGORY_MERGE_INVALID', 422, 'business_rule'],
];
for (const [c, status, category] of codes) {
    assert(`${c}: registered, has its own message, derives ${category} from ${status}`, () =>
        ERROR_CODES[c] === c && typeof DEFAULT_ERROR_MESSAGES[ERROR_CODES[c]] === 'string'
        && categoryFor(ERROR_CODES[c], status) === category);
}

// ─────────────────────────────────────────────────────────────────────────────
//  8. Source scans — the wiring nothing behavioural can see
// ─────────────────────────────────────────────────────────────────────────────

section('8. Source scans');

assert('the product model stores categoryIds and NO free-text category path', () => {
    const src = code('modules/catalog/models/product.model.ts');
    return /categoryIds:\s*\{\s*type:\s*\[/.test(src) && !/^\s+category:\s*\{\s*type:\s*String/m.test(src);
});
assert('the storefront index is multikey on categoryIds', () =>
    /index\(\{\s*status:\s*1,\s*deletedAt:\s*1,\s*categoryIds:\s*1\s*\}/.test(code('modules/catalog/models/product.model.ts')));
assert('match_key is a PARTIAL UNIQUE index — the duplicate guard behind the pre-check', () => {
    const src = code('modules/categories/models/product-category.model.ts');
    return /index\(\s*\{\s*match_key:\s*1\s*\}\s*,\s*\{\s*unique:\s*true[^}]*partialFilterExpression/.test(src);
});
assert('the repository creates with the ARRAY form (the only one that honours a session)', () =>
    /ProductCategoryModel\.create\(\s*\[/.test(code('modules/categories/repositories/product-category.repository.ts')));
for (const [file, label] of [
    ['modules/catalog/domain/services/ProductDraftService.ts', 'layered create'],
    ['modules/catalog/domain/services/ProductUpdateService.ts', 'layered + simple update'],
    ['modules/catalog/domain/services/simple/SimpleProductCreateService.ts', 'simple create'],
] as const) {
    assert(`${label} resolves through resolveForWrite — never writes a name it did not match`, () =>
        code(file).includes('resolveForWrite('));
}
assert('all four write schemas carry the shared categories fragment', () => {
    const layered = code('modules/catalog/validators/product.validator.ts');
    const simpleSrc = code('modules/catalog/validators/simple-product.validator.ts');
    return (layered.match(/categories:\s*ProductCategoriesSchema/g) ?? []).length === 2
        && (simpleSrc.match(/categories:\s*ProductCategoriesSchema/g) ?? []).length === 2;
});
assert('the public DTO mapper copies a category ref field by field (no spread)', () =>
    /categories:\s*input\.categories\.map\(\(c\)\s*=>\s*\(\{\s*id:\s*c\.id,\s*name:\s*c\.name,\s*slug:\s*c\.slug\s*\}\)\)/
        .test(code('modules/catalog/dto/public-product.dto.ts')));
assert('nothing in src/ still reads a product\'s free-text `.category`', () => {
    const files = [
        'modules/catalog/services/public-catalog.service.ts',
        'modules/catalog/services/related-products.service.ts',
        'modules/catalog/domain/services/VectorisationService.ts',
        'modules/negotiation/services/negotiation-tools.service.ts',
        'modules/vendors/read-models/admin-product-detail.resolver.ts',
    ];
    return files.every((f) => !/(product|row|p|doc|subject)\.category\b(?!Ids)/.test(code(f)));
});
assert('the admin router is internal-only (mounted under /categories on internal-admin)', () =>
    /router\.use\('\/categories',\s*buildAdminCategoryRouter\(\[requireAdminCaller\]\)\)/
        .test(code('api/routes/internal-admin.routes.ts')));
assert('the vendor router has no create route — categories are created on a product write', () => {
    const src = code('modules/categories/routes/vendor-category.routes.ts');
    return src.includes("router.get('/'") && src.includes("router.post('/check'") && !/router\.(post|put)\('\/'\s*,/.test(src);
});
assert('the conversion is registered in the migration ledger', () =>
    readFileSync(join(__dirname, '../migrate.ts'), 'utf-8').includes("name: 'migrate:product-categories'"));

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
    for (const { name, fn } of pending) {
        if (name.startsWith('§ ')) {
            originalConsole.log(`\n── ${name.slice(2)} ${'─'.repeat(Math.max(0, 68 - name.length))}`);
            continue;
        }
        let ok: boolean;
        try {
            ok = await fn();
        } catch (err) {
            originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
            failed++;
            continue;
        }
        if (ok) {
            originalConsole.log(`  ✅ ${name}`);
            passed++;
        } else {
            originalConsole.error(`  ❌ FAIL: ${name}`);
            failed++;
        }
    }
    originalConsole.log(`\n${failed === 0 ? '✔' : '✖'} test:product-categories — ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
})();
