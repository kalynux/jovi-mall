/**
 * Test: the public storefront's visibility rules and its projections.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: everything under test is either a Zod schema or a pure function, which is why
 * they were kept out of the services in the first place.
 *
 * The section that matters most is **4. Leak assertions**. `/api/public/*` is the one mount
 * with no auth guard anywhere above or below it, so the DTO projections are the whole
 * access-control story for the storefront. Those tests build a product, a variant and a
 * store from documents carrying every secret their real counterparts carry — vendor ids,
 * payout details, KYC, suspension notes, pickup addresses — and assert that none of it
 * survives into the serialised response. A projection that silently starts spreading its
 * input fails there rather than in production.
 *
 * Section **2b** is the second reason it exists, and it is newer: after D-1 of the bargaining
 * plan a bargainable variant is shelved at its ask rather than at `variant.price`, and FIVE
 * derivations move together or the storefront contradicts itself. Two of them are pure
 * functions and are asserted directly; the other three live in an aggregation pipeline, so
 * § 2b asserts the pipeline's own expression against the pure one on a shared fixture table,
 * and § 8 source-scans that the pipeline actually reads what it computed. `verify:storefront`
 * runs the real pipeline against real Mongo — a DB-free suite cannot.
 *
 * Run: npm run test:public-catalog
 */
import fs from 'fs';
import path from 'path';
import {
    publishableProductFilter,
    isPublishableProduct,
    isVendorPublishable,
    PUBLISHABLE_PRODUCT_STATUSES,
    VENDOR_PUBLISHABLE_MATCH,
} from '../../src/modules/catalog/domain/services/public-catalog.filter';
import {
    buildVariantDisplayName,
    isSellableVariant,
    variantInStock,
    priceRangeOf,
    servicePriceUnit,
    servicePriceFrom,
    toPublicVariantDto,
    toPublicProductDetailDto,
    toPublicReturnPolicyDto,
    toPublicCancellationPolicyDto,
    PublicProductDetailStoreDto,
} from '../../src/modules/catalog/dto/public-product.dto';
import {
    bargainEffectiveExpr,
    displayCompareAtPriceExpr,
    displayPriceExpr,
    publicCompareAtPrice,
    publicDisplayPrice,
} from '../../src/modules/catalog/read-models/public-display-price';
import { toPublicStoreDto } from '../../src/modules/store/dto/public-store.dto';
import {
    PublicProductListQuerySchema,
    PublicSkuParamSchema,
    PublicStoreListQuerySchema,
    ProductSlugSchema,
    StoreSlugSchema,
    ObjectIdSchema,
} from '../../src/modules/catalog/validators/public-catalog.validator';
import {
    pickSkuMatch,
    skuCandidates,
} from '../../src/modules/catalog/domain/services/sku-resolution';
import {
    toCustomerShipmentStatus,
    toCustomerStatusHistory,
} from '../../src/modules/orders/dto/customer-shipment.dto';
import { Product } from '../../src/modules/catalog/repositories/mappers/product.mapper';
import { Variant } from '../../src/modules/catalog/repositories/mappers/variant.mapper';
import { ShipmentStatus } from '../../src/modules/shipments/shipment.model';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success;
const rejects = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    !schema.safeParse(value).success;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const variant = (over: Partial<Variant> = {}): Variant => ({
    id: '507f1f77bcf86cd799439077',
    productId: '507f1f77bcf86cd799439066',
    sku: 'TSHIRT-RED-L',
    name: undefined,
    status: 'active',
    optionSignature: 'size:large|color:red',
    price: 24000,
    compareAtPrice: 30000,
    stock: 5,
    isInfiniteStock: false,
    lowStockThreshold: null,
    allowOversell: false,
    optionValueIds: ['507f1f77bcf86cd799439val'.slice(0, 24)],
    fileIds: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    deletedAt: null,
    ...over,
});

/**
 * The pricing parent every public price mapper now takes.
 *
 * `vectorisationEnabled: true` matches the `product()` fixture below, so the existing
 * assertions — none of whose variants carry a window — are unaffected: with no `bargain`,
 * the flag decides nothing and the displayed price is `variant.price` either way.
 */
const pricingParent = { vectorisationEnabled: true };

/** The same, with the AI index opted out — which makes a stored window inert. */
const pricingParentOptedOut = { vectorisationEnabled: false };

/**
 * A bargainable variant whose FLOOR is a number that appears nowhere else in this file.
 *
 * That is what makes the leak assertions in § 4 mean something: `24001` is searched for in
 * the serialised output, and it can only get there by a mapper publishing `variant.price` or
 * `bargain.minPrice` on a bargainable variant — the two things D-1 says the storefront must
 * never show.
 */
const BARGAIN_FLOOR = 24001;
const BARGAIN_ASK = 45000;
const bargainableVariant = (over: Partial<Variant> = {}): Variant =>
    variant({
        price: BARGAIN_FLOOR,
        compareAtPrice: undefined,
        bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK },
        ...over,
    });

/**
 * A product carrying everything a REAL one carries — including the fields that must never
 * be published. Used by the leak assertions below.
 */
const product = (over: Partial<Product> = {}): Product => ({
    id: '507f1f77bcf86cd799439066',
    vendorId: '507f1f77bcf86cd799439aaa',
    type: 'physical',
    status: 'active',
    mode: 'advanced',
    title: 'Ankara Wax Print Maxi Dress',
    description: 'Comfortable cotton',
    // The vendor-facing structured description. Present here on purpose: the
    // storefront renders `description` and this field is deliberately absent
    // from every public DTO, so the leak assertions below have to see a
    // document carrying it. The marker string is what they search for.
    descriptionRich: {
        version: 1,
        blocks: [
            {
                type: 'paragraph',
                text: [{ type: 'text', text: 'rich_doc_marker_should_not_publish', bold: true }],
            },
        ],
    },
    slug: 'ankara-wax-print-maxi-dress',
    category: 'Fashion',
    tags: ['wax', 'handmade'],
    seo: { title: 'Ankara dress', description: 'Handmade' },
    hasVariants: true,
    defaultVariantId: '507f1f77bcf86cd799439077',
    fileIds: ['507f1f77bcf86cd799439030'],
    delivery: {
        agencyId: '507f1f77bcf86cd799439bbb',
        freeDelivery: false,
        pickupLocation: {
            source: 'vendor_address',
            // A vendor's HOME address id. Publishing it is the leak this file guards.
            vendorAddressId: '507f1f77bcf86cd799439ccc',
            agencyAddressId: null,
        },
    },
    suspension: null,
    vectorisationEnabled: true,
    vectorisationStatus: 'completed',
    vectorisedDataId: 'vec_secret_123',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    deletedAt: null,
    purgeAt: null,
    ...over,
});

const storeBlock: PublicProductDetailStoreDto = {
    slug: 'maison-bella',
    name: 'Maison Bella',
    logo: null,
    isOpen: true,
    verified: true,
    city: 'Douala',
    country: 'CM',
    supportWhatsapp: '+237670000000',
    policies: { returnPolicy: null, cancellationPolicy: null },
};

const detail = (p: Product = product(), variants: Variant[] = [variant()]) =>
    toPublicProductDetailDto({
        product: p,
        variants,
        options: [{ id: '507f1f77bcf86cd799439opt'.slice(0, 24), name: 'Size', position: 1 }],
        optionValues: [
            { id: '507f1f77bcf86cd799439val'.slice(0, 24), optionId: '507f1f77bcf86cd799439opt'.slice(0, 24), value: 'L' },
        ],
        productImages: [],
        variantImages: new Map(),
        currency: 'XAF',
        contentLanguage: 'fr',
        // The default fixture is an unreviewed product, because that is the state
        // every product starts in and the one whose projection matters most: `null`
        // is what keeps `aggregateRating` out of the storefront's JSON-LD. The
        // non-null case is asserted on its own below.
        rating: null,
        store: storeBlock,
    });

// ─── 1. The publishable predicate ────────────────────────────────────────────

console.log('\n── Visibility ──');

assert('the product filter is exactly active + not-deleted + not-suspended', () => {
    const f = publishableProductFilter();
    return (
        f.status === 'active' &&
        f.deletedAt === null &&
        f.suspension === null &&
        Object.keys(f).length === 3
    );
});

assert('the filter is a FRESH object each call (callers spread into $match)', () =>
    publishableProductFilter() !== publishableProductFilter());

assert('exactly ONE of the five product statuses is publishable', () =>
    PUBLISHABLE_PRODUCT_STATUSES.length === 1 && PUBLISHABLE_PRODUCT_STATUSES[0] === 'active');

assert('an active, undeleted, unsuspended product is publishable', () =>
    isPublishableProduct(product()));

for (const status of ['draft', 'archived', 'pending_review', 'suspended'] as const) {
    assert(`a ${status} product is REFUSED`, () =>
        !isPublishableProduct(product({ status })));
}

assert('a soft-deleted product is REFUSED even when status is active', () =>
    !isPublishableProduct(product({ deletedAt: new Date() })));

assert('a product carrying a suspension block is REFUSED', () =>
    !isPublishableProduct(
        product({
            suspension: {
                reason: 'agency_storage_suspended',
                previousStatus: 'active',
                suspendedAt: new Date(),
                suspendedByAgencyId: null,
                note: 'storage rent unpaid',
            },
        }),
    ));

// ── The vendor rule: `!== 'inactive'`, NOT `=== 'active'` ────────────────────
// This is the deviation from BACKEND-SHOP-REQUIREMENTS §2.4, and it is deliberate:
// `pending_verification` is the schema default at registration, and the activation gate
// (ProductStatusValidationService) refuses only `inactive` — so the positive form would
// hide the store of every vendor who never verified their email WHILE their products
// stayed in the browse grid.
assert('an active vendor is publishable', () => isVendorPublishable('active'));
assert('a PENDING_VERIFICATION vendor is publishable — matches the activation gate', () =>
    isVendorPublishable('pending_verification'));
assert('an INACTIVE (suspended) vendor is refused', () => !isVendorPublishable('inactive'));
assert('an unknown vendor status fails OPEN, like the activation gate', () =>
    isVendorPublishable('something_new'));
assert('the pipeline match uses $ne inactive, not $eq active', () =>
    JSON.stringify(VENDOR_PUBLISHABLE_MATCH) === JSON.stringify({ 'vendor.status': { $ne: 'inactive' } }));

// ─── 2. Price, stock and service derivations ─────────────────────────────────

console.log('\n── Derivations ──');

assert('an active variant is sellable', () => isSellableVariant(variant()));
assert('an archived variant is NOT sellable', () => !isSellableVariant(variant({ status: 'archived' })));
assert('a soft-deleted variant is NOT sellable', () => !isSellableVariant(variant({ deletedAt: new Date() })));

assert('stock > 0 is in stock', () => variantInStock(variant({ stock: 3 })));
assert('stock 0 is out of stock', () => !variantInStock(variant({ stock: 0 })));
assert('infinite stock is always in stock', () =>
    variantInStock(variant({ stock: 0, isInfiniteStock: true })));
assert('allowOversell is always in stock — the vendor will source it', () =>
    variantInStock(variant({ stock: 0, allowOversell: true })));

assert('a single price yields NO priceRange (the key is omitted, not degenerate)', () =>
    priceRangeOf([variant({ price: 100 })], pricingParent) === undefined);
assert('identical prices across variants yield NO priceRange', () =>
    priceRangeOf([variant({ id: 'a', price: 100 }), variant({ id: 'b', price: 100 })], pricingParent) === undefined);
assert('differing prices yield min/max', () => {
    const r = priceRangeOf([variant({ id: 'a', price: 100 }), variant({ id: 'b', price: 250 })], pricingParent);
    return r?.min === 100 && r?.max === 250;
});
assert('an archived variant does NOT widen the price range', () => {
    const r = priceRangeOf([
        variant({ id: 'a', price: 100 }),
        variant({ id: 'b', price: 999, status: 'archived' }),
    ], pricingParent);
    return r === undefined;
});

assert('a sub-hour duration reads "per 45 min"', () => servicePriceUnit(45) === 'per 45 min');
assert('an exact hour reads "per 1 h"', () => servicePriceUnit(60) === 'per 1 h');
assert('90 minutes reads "per 1 h 30 min"', () => servicePriceUnit(90) === 'per 1 h 30 min');
assert('priceFrom is the rate itself — peak hours only ever ADD', () =>
    servicePriceFrom(variant({ price: 24000 }), pricingParent) === 24000);

// ─── 2b. The bargainable display price (D-1) ─────────────────────────────────

console.log('\n── Bargainable display price ──');

assert('a variant with NO window displays its own price', () =>
    publicDisplayPrice(true, { price: 24000 }) === 24000);

assert('⚠ a BARGAINABLE variant displays the ASK, never the floor', () =>
    publicDisplayPrice(true, { price: BARGAIN_FLOOR, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } })
    === BARGAIN_ASK);

assert('a window on an OPTED-OUT product is inert — the floor is displayed', () =>
    // `isBargainEffective` keeps a configured window and reports it inert rather than
    // deleting it, so this is a real state a vendor can be in, not a should-never-happen.
    publicDisplayPrice(false, { price: BARGAIN_FLOOR, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } })
    === BARGAIN_FLOOR);

assert('a DEGENERATE window (ask == floor) is a no-op — the vendor configured no headroom', () =>
    publicDisplayPrice(true, { price: 24000, bargain: { minPrice: 24000, maxPrice: 24000 } }) === 24000);

assert('a non-bargainable variant\'s compareAtPrice passes through UNCHANGED', () =>
    publicCompareAtPrice(true, { price: 24000, compareAtPrice: 30000 }) === 30000
    // Including an already-inverted one. The narrowing below is scoped to the flip; it does
    // not silently change what the storefront publishes for products this feature never touches.
    && publicCompareAtPrice(true, { price: 24000, compareAtPrice: 20000 }) === 20000
    && publicCompareAtPrice(true, { price: 24000 }) === null);

assert('a bargainable variant KEEPS a compareAtPrice strictly above its ask', () =>
    publicCompareAtPrice(true, {
        price: BARGAIN_FLOOR, compareAtPrice: 50000, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK },
    }) === 50000);

assert('⚠ a bargainable variant DROPS a compareAtPrice at or below its ask', () =>
    // Otherwise the flip renders "was 30 000, now 45 000" — a strikethrough beneath the live
    // price. `compareAtPrice` is a "was" price and is unrelated to the window, so the pair is
    // a perfectly legitimate vendor configuration; it just cannot both be published.
    publicCompareAtPrice(true, {
        price: BARGAIN_FLOOR, compareAtPrice: 30000, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK },
    }) === null
    && publicCompareAtPrice(true, {
        price: BARGAIN_FLOOR, compareAtPrice: BARGAIN_ASK, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK },
    }) === null);

assert('priceRangeOf spans DISPLAYED prices, so the band contains the grid\'s own price', () => {
    // Floors 100 and 24 001; displayed 100 and 45 000. A band computed from floors would read
    // {100, 24001} beneath a card quoting 45 000 — the range would not contain its own price.
    const r = priceRangeOf([variant({ id: 'a', price: 100 }), bargainableVariant({ id: 'b' })], pricingParent);
    return r?.min === 100 && r?.max === BARGAIN_ASK;
});

assert('priceRangeOf on an opted-out product falls back to the floors', () => {
    const r = priceRangeOf([variant({ id: 'a', price: 100 }), bargainableVariant({ id: 'b' })], pricingParentOptedOut);
    return r?.min === 100 && r?.max === BARGAIN_FLOOR;
});

// ── The two dialects, on one fixture table ───────────────────────────────────
// The pure functions serve the product detail; the `$` expressions serve the browse grid,
// its price band and the SKU resolution. They are the SAME rule and they are written in the
// same file for that reason — this is what asserts they have not drifted.
//
// ⚠ The evaluator below is deliberately tiny and covers ONLY the operators
// `public-display-price.ts` emits. It is not a Mongo emulator, and it is not the proof that
// the pipeline works — `verify:storefront` runs the real pipeline against real Mongo. What it
// proves is agreement, which no live suite can check without a bargainable fixture on both
// sides of the boundary.

const DISPLAY_PATHS = {
    vectorisationEnabled: '$vectorisationEnabled',
    bargainMaxPrice: '$$v.bargain.maxPrice',
    price: '$$v.price',
    compareAtPrice: '$$v.compareAtPrice',
};

/** BSON comparison order for the three types these expressions ever compare. */
const bsonRank = (v: unknown): number =>
    v === null || v === undefined ? 1 : typeof v === 'number' ? 2 : typeof v === 'boolean' ? 8 : 5;

function bsonCompare(a: unknown, b: unknown): number {
    const [ra, rb] = [bsonRank(a), bsonRank(b)];
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
    return 0;
}

function resolvePath(expr: string, root: unknown, vars: Record<string, unknown>): unknown {
    const isVar = expr.startsWith('$$');
    const parts = expr.slice(isVar ? 2 : 1).split('.');
    let cur: unknown = isVar ? vars[parts[0]] : root;
    for (const key of parts.slice(isVar ? 1 : 0)) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
}

function evalExpr(expr: unknown, root: unknown, vars: Record<string, unknown>): unknown {
    if (typeof expr === 'string') return expr.startsWith('$') ? resolvePath(expr, root, vars) : expr;
    if (expr === null || typeof expr !== 'object') return expr;
    const obj = expr as Record<string, unknown>;
    const op = Object.keys(obj)[0];
    const args = obj[op] as unknown[];
    const ev = (x: unknown): unknown => evalExpr(x, root, vars);
    switch (op) {
        case '$cond': return ev(args[0]) === true ? ev(args[1]) : ev(args[2]);
        case '$and': return args.every((a) => ev(a) === true);
        case '$eq': return bsonCompare(ev(args[0]), ev(args[1])) === 0;
        case '$ne': return bsonCompare(ev(args[0]), ev(args[1])) !== 0;
        case '$gt': return bsonCompare(ev(args[0]), ev(args[1])) > 0;
        case '$ifNull': {
            const v = ev(args[0]);
            return v === undefined || v === null ? ev(args[1]) : v;
        }
        default: throw new Error(`the evaluator does not implement ${op} — add it deliberately`);
    }
}

interface DisplayCase {
    label: string;
    vectorisationEnabled: boolean;
    variant: { price: number; compareAtPrice?: number; bargain?: { minPrice: number; maxPrice: number } };
}

const DISPLAY_CASES: DisplayCase[] = [
    { label: 'no window', vectorisationEnabled: true, variant: { price: 24000, compareAtPrice: 30000 } },
    { label: 'no window, no compareAt', vectorisationEnabled: true, variant: { price: 24000 } },
    {
        label: 'bargainable, compareAt above the ask', vectorisationEnabled: true,
        variant: { price: BARGAIN_FLOOR, compareAtPrice: 50000, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } },
    },
    {
        label: 'bargainable, compareAt below the ask', vectorisationEnabled: true,
        variant: { price: BARGAIN_FLOOR, compareAtPrice: 30000, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } },
    },
    {
        label: 'bargainable, compareAt EQUAL to the ask', vectorisationEnabled: true,
        variant: { price: BARGAIN_FLOOR, compareAtPrice: BARGAIN_ASK, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } },
    },
    {
        label: 'bargainable, no compareAt', vectorisationEnabled: true,
        variant: { price: BARGAIN_FLOOR, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } },
    },
    {
        label: 'window present but product OPTED OUT', vectorisationEnabled: false,
        variant: { price: BARGAIN_FLOOR, compareAtPrice: 30000, bargain: { minPrice: BARGAIN_FLOOR, maxPrice: BARGAIN_ASK } },
    },
    {
        label: 'degenerate window', vectorisationEnabled: true,
        variant: { price: 24000, compareAtPrice: 30000, bargain: { minPrice: 24000, maxPrice: 24000 } },
    },
];

for (const c of DISPLAY_CASES) {
    const root = { vectorisationEnabled: c.vectorisationEnabled };
    const vars = { v: c.variant };

    assert(`both dialects agree on the PRICE — ${c.label}`, () =>
        evalExpr(displayPriceExpr(DISPLAY_PATHS), root, vars)
        === publicDisplayPrice(c.vectorisationEnabled, c.variant));

    assert(`both dialects agree on compareAtPrice — ${c.label}`, () =>
        evalExpr(displayCompareAtPriceExpr(DISPLAY_PATHS), root, vars)
        === publicCompareAtPrice(c.vectorisationEnabled, c.variant));
}

assert('the pipeline predicate treats a MISSING window exactly as `bargain != null` does', () =>
    // A missing field path and an explicit null compare equal to null in the aggregation
    // language, which is what lets one `$ne` cover "never configured" and "cleared".
    evalExpr(bargainEffectiveExpr(DISPLAY_PATHS), { vectorisationEnabled: true }, { v: { price: 1 } }) === false
    && evalExpr(bargainEffectiveExpr(DISPLAY_PATHS), { vectorisationEnabled: true }, { v: { price: 1, bargain: null } }) === false
    && evalExpr(bargainEffectiveExpr(DISPLAY_PATHS), { vectorisationEnabled: true }, { v: { price: 1, bargain: { maxPrice: 9 } } }) === true);

assert('a MISSING vectorisationEnabled is not `true` — products predating the column stay inert', () =>
    evalExpr(bargainEffectiveExpr(DISPLAY_PATHS), {}, { v: { price: 1, bargain: { maxPrice: 9 } } }) === false);

// ─── 3. The projections ──────────────────────────────────────────────────────

console.log('\n── Projections ──');

assert('compareAtPrice is explicit null when absent, not omitted', () => {
    const dto = toPublicVariantDto(variant({ compareAtPrice: undefined }), 'XAF', new Map(), new Map(), [], pricingParent);
    return 'compareAtPrice' in dto && dto.compareAtPrice === null;
});

assert('sku IS published — already unique and already shown on cart/order lines', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), [], pricingParent);
    return dto.sku === 'TSHIRT-RED-L';
});

assert('optionValueIds is published as the selection key', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), [], pricingParent);
    return Array.isArray(dto.optionValueIds) && dto.optionValueIds.length === 1;
});

assert('optionSignature is NEVER published — it goes stale on a value rename', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), [], pricingParent);
    return !('optionSignature' in dto) && !JSON.stringify(dto).includes('size:large');
});

assert('variant images are OMITTED when the variant has none', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), [], pricingParent);
    return !('images' in dto);
});

assert('a service variant carries priceUnit AND priceFrom beside the raw rate', () => {
    const dto = toPublicVariantDto(
        variant({
            serviceConfig: {
                durationMinutes: 60,
                bufferBeforeMinutes: 0,
                bufferAfterMinutes: 15,
                bookingMode: 'calendar',
            },
        }),
        'XAF', new Map(), new Map(), [], pricingParent,
    );
    // "per 1 h" rather than BACKEND-SHOP-REQUIREMENTS §2.7d's "per 60 min" example: the
    // former is the better human string, and `durationMinutes` ships beside it so a
    // five-locale storefront can format its own label rather than print this English one.
    return dto.service?.priceUnit === 'per 1 h' && dto.service?.priceFrom === 24000 && dto.price === 24000;
});

assert('a digital variant publishes terms of sale but never the asset', () => {
    const dto = toPublicVariantDto(
        variant({ digitalConfig: { assetId: 'SECRET_ASSET_ID', maxDownloads: 3, expiresAfterDays: 30 } }),
        'XAF', new Map(), new Map(), [], pricingParent,
    );
    return (
        dto.digital?.maxDownloads === 3 &&
        dto.digital?.expiresAfterDays === 30 &&
        !JSON.stringify(dto).includes('SECRET_ASSET_ID')
    );
});

assert('⚠ the variant DTO quotes the ASK on a bargainable variant, and never the floor', () => {
    const dto = toPublicVariantDto(bargainableVariant(), 'XAF', new Map(), new Map(), [], pricingParent);
    return dto.price === BARGAIN_ASK && !JSON.stringify(dto).includes(String(BARGAIN_FLOOR));
});

assert('the variant DTO quotes the floor when the product is opted OUT of the AI index', () => {
    const dto = toPublicVariantDto(bargainableVariant(), 'XAF', new Map(), new Map(), [], pricingParentOptedOut);
    return dto.price === BARGAIN_FLOOR;
});

assert('a bargainable variant\'s compareAtPrice is dropped when the flip would invert it', () => {
    const dto = toPublicVariantDto(
        bargainableVariant({ compareAtPrice: 30000 }), 'XAF', new Map(), new Map(), [], pricingParent,
    );
    return dto.price === BARGAIN_ASK && dto.compareAtPrice === null;
});

assert('⚠ the product detail prices EACH variant on its own merits', () => {
    // One product, one flag, two variants — a per-product flip would move both. The rule is
    // per-variant because the window is: `bargainable` is `product.vectorisationEnabled &&
    // variant.bargain != null`, and a vendor may configure one variant and not its sibling.
    const dto = detail(product(), [variant({ id: 'plain', price: 100 }), bargainableVariant({ id: 'haggle' })]);
    const plain = dto.variants.find((v) => v.id === 'plain');
    const haggle = dto.variants.find((v) => v.id === 'haggle');
    return plain?.price === 100 && haggle?.price === BARGAIN_ASK;
});

assert('a simple-mode product returns options: [] and one variant', () => {
    const dto = toPublicProductDetailDto({
        product: product({ mode: 'simple', hasVariants: false }),
        variants: [variant()],
        options: [],
        optionValues: [],
        productImages: [],
        variantImages: new Map(),
        currency: 'XAF',
        contentLanguage: 'fr',
        // The default fixture is an unreviewed product, because that is the state
        // every product starts in and the one whose projection matters most: `null`
        // is what keeps `aggregateRating` out of the storefront's JSON-LD. The
        // non-null case is asserted on its own below.
        rating: null,
        store: storeBlock,
    });
    return dto.options.length === 0 && dto.variants.length === 1;
});

assert('archived variants are dropped from the detail', () => {
    const dto = detail(product(), [variant({ id: 'a' }), variant({ id: 'b', status: 'archived' })]);
    return dto.variants.length === 1 && dto.variants[0].id === 'a';
});

assert('defaultVariantId is nulled when it points at an unsellable variant', () => {
    const dto = detail(product({ defaultVariantId: 'gone' }), [variant()]);
    return dto.defaultVariantId === null;
});

assert('options are sorted by position, not insertion order', () => {
    const dto = toPublicProductDetailDto({
        product: product(),
        variants: [variant()],
        options: [
            { id: 'o2', name: 'Colour', position: 2 },
            { id: 'o1', name: 'Size', position: 1 },
        ],
        optionValues: [],
        productImages: [],
        variantImages: new Map(),
        currency: 'XAF',
        contentLanguage: 'fr',
        // The default fixture is an unreviewed product, because that is the state
        // every product starts in and the one whose projection matters most: `null`
        // is what keeps `aggregateRating` out of the storefront's JSON-LD. The
        // non-null case is asserted on its own below.
        rating: null,
        store: storeBlock,
    });
    return dto.options[0].name === 'Size' && dto.options[1].name === 'Colour';
});

assert('a null vendor policy projects to null, never to an invented default', () =>
    toPublicReturnPolicyDto(null) === null && toPublicCancellationPolicyDto(null) === null);

assert('a return policy is projected WITHOUT the admin-only `inspector`', () => {
    const dto = toPublicReturnPolicyDto({
        return_eligible: true,
        return_window_days: 14,
        refund_type: 'full',
        refund_percentage: null,
        return_shipping_payer: 'vendor',
        refund_processing_days: 5,
        return_condition_notes: 'unworn',
    });
    return dto?.windowDays === 14 && !('inspector' in (dto as object));
});

// ─── 4. Leak assertions — the reason this file exists ────────────────────────

console.log('\n── Leaks ──');

const detailJson = JSON.stringify(detail());

const FORBIDDEN_ON_A_PRODUCT: Array<[string, string]> = [
    ['vendorId', '507f1f77bcf86cd799439aaa'],
    ['pickup vendor address id', '507f1f77bcf86cd799439ccc'],
    ['vectorisedDataId', 'vec_secret_123'],
    // Vendor-facing only. The storefront renders `description`, its plain-text
    // projection; the structured document exists for the chat formatters and for
    // the edit form to hydrate from. Publishing it would put a second, richer
    // copy of the same prose on an unauthenticated route for no consumer.
    ['descriptionRich', 'rich_doc_marker_should_not_publish'],
];

for (const [label, needle] of FORBIDDEN_ON_A_PRODUCT) {
    assert(`the product detail does NOT leak ${label}`, () => !detailJson.includes(needle));
}

assert('the product detail exposes no `suspension` key at all', () => !detailJson.includes('suspension'));
assert('the product detail exposes no `pickup` key at all', () =>
    !detailJson.includes('pickupLocation') && !detailJson.includes('pickup_location'));
assert('the product detail exposes no vectorisation state', () =>
    !detailJson.includes('vectorisation'));
assert('the product detail exposes no soft-delete bookkeeping', () =>
    !detailJson.includes('deletedAt') && !detailJson.includes('purgeAt'));

// ── The vendor's floor (D-1) ─────────────────────────────────────────────────
// `bargain.minPrice` IS `variant.price` and IS the number the vendor will not go below. On
// the storefront it is the other side's negotiating position, so it is not merely internal
// bookkeeping like the ids above — publishing it hands the shopper the vendor's reserve.

const bargainDetailJson = JSON.stringify(
    detail(product(), [bargainableVariant({ compareAtPrice: 30000 })]),
);

assert('⚠ the product detail does NOT leak bargain.minPrice — it is the vendor\'s floor', () =>
    !bargainDetailJson.includes('minPrice'));

assert('⚠ the product detail does NOT leak the floor VALUE under any other key', () =>
    // The key name alone is not enough: the floor also travels as `variant.price`, and a
    // mapper that forgot to flip would publish the same number under an innocent name.
    !bargainDetailJson.includes(String(BARGAIN_FLOOR)));

assert('the product detail exposes no `bargain` key at all', () =>
    !bargainDetailJson.includes('bargain') && !bargainDetailJson.includes('maxPrice'));

assert('the ask IS published — it is the price the shopper is being quoted', () =>
    bargainDetailJson.includes(String(BARGAIN_ASK)));

assert('an INERT window leaks no floor either — the number is published, the reserve is not', () => {
    // The opted-out case publishes the floor legitimately, AS the price. What must still not
    // appear is the window: a shopper who can read `maxPrice` learns there is headroom, and a
    // shopper who can read `minPrice` learns the reserve whatever the flag says.
    const json = JSON.stringify(
        toPublicProductDetailDto({
            product: product({ vectorisationEnabled: false }),
            variants: [bargainableVariant()],
            options: [],
            optionValues: [],
            productImages: [],
            variantImages: new Map(),
            currency: 'XAF',
            contentLanguage: 'fr',
            rating: null,
            store: storeBlock,
        }),
    );
    return !json.includes('minPrice') && !json.includes('maxPrice') && !json.includes(String(BARGAIN_ASK));
});

assert('a suspension NOTE cannot reach the wire even if a suspended product were projected', () => {
    const json = JSON.stringify(
        detail(
            product({
                suspension: {
                    reason: 'agency_storage_suspended',
                    previousStatus: 'active',
                    suspendedAt: new Date(),
                    suspendedByAgencyId: '507f1f77bcf86cd799439bbb',
                    note: 'storage rent unpaid',
                },
            }),
        ),
    );
    return !json.includes('storage rent unpaid');
});

const storeJson = JSON.stringify(
    toPublicStoreDto({
        store: {
            slug: 'maison-bella',
            name: 'Maison Bella',
            description: 'Contemporary African fashion',
            is_open: true,
            support_email: 'hi@maisonbella.cm',
            support_phone: '+237670000000',
            support_whatsapp: '+237670000000',
            created_at: new Date('2026-02-01T00:00:00.000Z'),
        } as never,
        vendor: {
            status: 'active',
            country: 'CM',
            verified: true,
            city: 'Douala',
            preferredLanguage: 'fr',
        },
        logo: null,
        banner: null,
        productCount: 48,
    }),
);

assert('the store DTO publishes city and country', () =>
    storeJson.includes('Douala') && storeJson.includes('CM'));
assert('the store DTO does NOT publish vendorId', () => !storeJson.includes('vendorId'));
assert('the store DTO does NOT publish the optimistic-lock version', () =>
    !storeJson.includes('"version"'));
assert('the store DTO does NOT publish the vendor status it gated on', () =>
    !storeJson.includes('"status"'));
assert('memberSince is an ISO string, not a Date', () =>
    storeJson.includes('2026-02-01T00:00:00.000Z'));

// ─── 5. Query validators ─────────────────────────────────────────────────────

console.log('\n── Query contract ──');

assert('sort defaults to newest', () => {
    const parsed = PublicProductListQuerySchema.parse({});
    return parsed.sort === 'newest' && parsed.page === 1 && parsed.limit === 20;
});

assert('sort=popularity is REFUSED — nothing tracks sales', () =>
    rejects(PublicProductListQuerySchema, { sort: 'popularity' }));

assert('all four real sorts are accepted', () =>
    ['newest', 'price_asc', 'price_desc', 'relevance'].every((sort) =>
        accepts(PublicProductListQuerySchema, { sort })));

assert('limit is capped at 100 — an unbounded page is a DoS primitive', () =>
    rejects(PublicProductListQuerySchema, { limit: 1000 }));

assert('limit 0 is refused', () => rejects(PublicProductListQuerySchema, { limit: 0 }));

assert('minPrice > maxPrice is REFUSED rather than silently returning nothing', () =>
    rejects(PublicProductListQuerySchema, { minPrice: 500, maxPrice: 100 }));

assert('a fractional price bound is refused — XAF has no minor unit', () =>
    rejects(PublicProductListQuerySchema, { minPrice: 10.5 }));

assert('type accepts a comma-separated list', () => {
    const parsed = PublicProductListQuerySchema.parse({ type: 'physical,digital' });
    return parsed.type?.length === 2;
});

assert('type accepts a repeated param', () => {
    const parsed = PublicProductListQuerySchema.parse({ type: ['physical', 'service'] });
    return parsed.type?.length === 2;
});

assert('an unknown type is refused', () => rejects(PublicProductListQuerySchema, { type: 'furniture' }));

assert('inStock=false means "do not filter", not "show me sold-out things"', () =>
    PublicProductListQuerySchema.parse({ inStock: 'false' }).inStock === undefined);
assert('inStock=true narrows', () =>
    PublicProductListQuerySchema.parse({ inStock: 'true' }).inStock === true);

assert('a search term longer than 200 chars is refused', () =>
    rejects(PublicProductListQuerySchema, { q: 'x'.repeat(201) }));

assert('store slugs are ASCII-only (they are globally unique keys)', () =>
    accepts(StoreSlugSchema, 'maison-bella') && rejects(StoreSlugSchema, 'maison bella'));

assert('product slugs allow non-ASCII lowercase — five locales author them', () =>
    accepts(ProductSlugSchema, 'robe-en-coton') && accepts(ProductSlugSchema, 'قميص-قطني'));

assert('a slug with capitals or a slash is refused', () =>
    rejects(ProductSlugSchema, 'Robe-Coton') && rejects(ProductSlugSchema, 'robe/coton'));

assert('an ObjectId param must be 24 hex', () =>
    accepts(ObjectIdSchema, '507f1f77bcf86cd799439066') && rejects(ObjectIdSchema, 'not-an-id'));

assert('the store list caps its limit too', () =>
    rejects(PublicStoreListQuerySchema, { limit: 500 }));

// ─── 6. Customer shipment vocabulary ─────────────────────────────────────────

console.log('\n── Customer shipment view ──');

const INTERNAL_ONLY: ShipmentStatus[] = ['pending', 'assigned', 'pending_agency_reassignment', 'rejected'];
for (const status of INTERNAL_ONLY) {
    assert(`internal status "${status}" is collapsed to preparing`, () =>
        toCustomerShipmentStatus(status) === 'preparing');
}

assert('handing_over reads as "shipped" — which agent carries it is not the customer\'s business', () =>
    toCustomerShipmentStatus('handing_over') === 'shipped');
assert('picked_up and in_transit both read as shipped', () =>
    toCustomerShipmentStatus('picked_up') === 'shipped' &&
    toCustomerShipmentStatus('in_transit') === 'shipped');
assert('agent_delivered reads as out_for_delivery', () =>
    toCustomerShipmentStatus('agent_delivered') === 'out_for_delivery');
assert('delivered reads as delivered', () => toCustomerShipmentStatus('delivered') === 'delivered');
assert('failed and returned both read as delivery_failed', () =>
    toCustomerShipmentStatus('failed') === 'delivery_failed' &&
    toCustomerShipmentStatus('returned') === 'delivery_failed');

assert('the status map is TOTAL — every ShipmentStatus has a customer word', () => {
    const all: ShipmentStatus[] = [
        'pending', 'assigned', 'handing_over', 'picked_up', 'in_transit',
        'agent_delivered', 'delivered', 'failed', 'returned', 'rejected',
        'pending_agency_reassignment',
    ];
    return all.every((s) => typeof toCustomerShipmentStatus(s) === 'string');
});

assert('consecutive entries collapsing to one word are folded to the FIRST', () => {
    const history = toCustomerStatusHistory([
        { status: 'picked_up', changed_at: new Date('2026-07-30T10:00:00.000Z') },
        { status: 'in_transit', changed_at: new Date('2026-07-30T14:00:00.000Z') },
        { status: 'agent_delivered', changed_at: new Date('2026-07-30T18:00:00.000Z') },
    ]);
    return (
        history.length === 2 &&
        history[0].status === 'shipped' &&
        history[0].at === '2026-07-30T10:00:00.000Z' &&
        history[1].status === 'out_for_delivery'
    );
});

assert('a failed → retried → delivered journey keeps BOTH failure and success', () => {
    const history = toCustomerStatusHistory([
        { status: 'in_transit', changed_at: new Date('2026-07-30T10:00:00.000Z') },
        { status: 'failed', changed_at: new Date('2026-07-30T12:00:00.000Z') },
        { status: 'in_transit', changed_at: new Date('2026-07-31T09:00:00.000Z') },
        { status: 'delivered', changed_at: new Date('2026-07-31T11:00:00.000Z') },
    ]);
    return history.map((h) => h.status).join(',') === 'shipped,delivery_failed,shipped,delivered';
});

// ─── 7. SKU resolution (GAP-003) ─────────────────────────────────────────────

console.log('\n── SKU resolution ──');

assert('a SKU param is trimmed and bounded at 64 — the catalogue\'s own cap', () =>
    PublicSkuParamSchema.parse({ sku: '  DRESS-WAX-M ' }).sku === 'DRESS-WAX-M'
    && rejects(PublicSkuParamSchema, { sku: '' })
    && rejects(PublicSkuParamSchema, { sku: 'x'.repeat(65) }));

assert('⚠ a SKU is NOT pattern-matched — the model has no regex and vendors type what they like', () =>
    accepts(PublicSkuParamSchema, { sku: 'DRESS/WAX 12.5_v2' })
    && accepts(PublicSkuParamSchema, { sku: 'قميص-1' }));

assert('the candidates are as-typed first, then upper, then lower', () =>
    JSON.stringify(skuCandidates('Dress-Wax-M')) === JSON.stringify(['Dress-Wax-M', 'DRESS-WAX-M', 'dress-wax-m']));

assert('an already-uppercase code produces TWO candidates, not three', () =>
    skuCandidates('DRESS-WAX-M').length === 2);

assert('a blank code produces none — never an unbounded query', () =>
    skuCandidates('   ').length === 0);

assert('⚠ the code the customer TYPED wins when two spellings both exist', () => {
    // `abc` and `ABC` are two different SKUs to a case-sensitive unique index, so a
    // catalogue can hold both. Answering with the other one is the failure this rule exists
    // to prevent.
    const rows = [{ sku: 'ABC-1' }, { sku: 'abc-1' }];
    return pickSkuMatch(rows, 'abc-1')?.sku === 'abc-1'
        && pickSkuMatch(rows, 'ABC-1')?.sku === 'ABC-1';
});

assert('a lone case-variant still resolves — that is why more than one spelling is tried', () =>
    pickSkuMatch([{ sku: 'DRESS-WAX-M' }], 'dress-wax-m')?.sku === 'DRESS-WAX-M');

assert('no rows is null, never a throw — the service decides the 404', () =>
    pickSkuMatch([], 'anything') === null);

assert('the typed value is trimmed before it is compared', () =>
    pickSkuMatch([{ sku: 'A' }, { sku: 'a' }], '  a  ')?.sku === 'a');

assert('a vendor-set variant name wins over its option selection', () =>
    buildVariantDisplayName('Deluxe', [{ optionName: 'Size', value: 'M' }], 'SKU-1') === 'Deluxe');

assert('with no name, the selection is spelled out', () =>
    buildVariantDisplayName(null, [
        { optionName: 'Size', value: 'M' },
        { optionName: 'Colour', value: 'Red' },
    ], 'SKU-1') === 'Size: M, Colour: Red');

assert('with neither, the SKU is the name — a simple-mode variant has nothing else', () =>
    buildVariantDisplayName(null, [], 'SKU-1') === 'SKU-1');

assert('⚠ the product detail and the SKU resolution name a variant IDENTICALLY', () => {
    // One rule, two surfaces. Two copies of the expression would drift the day somebody
    // changes the separator, and a variant would be called different things on two screens.
    const optionsById = new Map([['o1', { id: 'o1', name: 'Size' }]]);
    const valuesById = new Map([['v1', { id: 'v1', optionId: 'o1', value: 'M' }]]);
    const dto = toPublicVariantDto(
        variant({ name: undefined, optionValueIds: ['v1'], sku: 'DRESS-WAX-M' }),
        'XAF',
        optionsById,
        valuesById,
        [],
        pricingParent,
    );
    return dto.name === buildVariantDisplayName(null, [{ optionName: 'Size', value: 'M' }], 'DRESS-WAX-M');
});

// ─── 8. Source scans: all five derivations move together ─────────────────────
//
// Three of the five live in an aggregation pipeline — the browse row's `price`, the
// `priceMin`/`priceMax` band, and the `minPrice`/`maxPrice` filter — and a fourth, the
// `price_asc`/`price_desc` sort, is correct only because of where its stage sits relative to
// the projection. None of that is reachable from a DB-free suite, and the failure it guards
// is not a crash: a filter left on `_defaultVariant.price` returns products whose own card
// contradicts the band the shopper asked for, and every other test still passes.

console.log('\n── The flip moves together (source) ──');

const SRC = path.join(__dirname, '..', '..', 'src');
const readSrc = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

/**
 * Comments are stripped first, and that is deliberate rather than convenient: the tombstones
 * explaining WHY a path was flipped are the most useful thing in this diff, and a scan that
 * forced their removal would have made the codebase worse to keep itself green.
 */
const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const REPO = 'modules/catalog/repositories/mongo/public-catalog.repository.mongo.ts';
const DTO = 'modules/catalog/dto/public-product.dto.ts';
const repoSrc = stripComments(readSrc(REPO));
const dtoSrc = stripComments(readSrc(DTO));

assert('the pipeline builds its price from the SHARED rule, not a hand-rolled $cond', () =>
    repoSrc.includes("from '../../read-models/public-display-price'")
    && repoSrc.includes('displayPriceExpr(')
    && repoSrc.includes('displayCompareAtPriceExpr('));

assert('⚠ the browse row projects displayPrice — `_defaultVariant.price` survives NOWHERE', () =>
    repoSrc.includes("price: '$_defaultVariant.displayPrice'")
    && !repoSrc.includes('_defaultVariant.price'));

assert('⚠ the FILTER BAND matches displayPrice — this is the "under 40 000" defect', () =>
    repoSrc.includes("{ $match: { '_defaultVariant.displayPrice': priceMatch } }")
    && !repoSrc.includes("'_defaultVariant.price': priceMatch"));

assert('⚠ priceMin/priceMax are taken over displayPrice, never over the floors', () =>
    repoSrc.includes("$min: '$sellableVariants.displayPrice'")
    && repoSrc.includes("$max: '$sellableVariants.displayPrice'")
    && !repoSrc.includes('sellableVariants.price'));

assert('⚠ the SORT stage is pushed AFTER the projection — which is what flips it too', () => {
    // `price_asc`/`price_desc` sort on the field name `price`, and after
    // `listProjectionStage` that field IS the displayed price. Move the `$sort` above the
    // `$project` and it silently starts ordering the grid by the vendors' floors while
    // showing their asks — a wrong order, never an error.
    const project = repoSrc.indexOf('stages.push(this.listProjectionStage());');
    const sort = repoSrc.indexOf('stages.push({ $sort: this.sortStage(query) });');
    return project !== -1 && sort !== -1 && project < sort;
});

assert('the sort keys on the projected `price`, so it inherits the flip', () =>
    repoSrc.includes('return { price: 1, _id: 1 };') && repoSrc.includes('return { price: -1, _id: 1 };'));

assert('the SKU resolution projects vectorisationEnabled and prices through the same rule', () =>
    repoSrc.includes('vectorisationEnabled: 1')
    && repoSrc.includes("vectorisationEnabled: '$product.vectorisationEnabled'"));

assert('⚠ the variant lookup projects the ASK ALONE — the floor never enters the pipeline', () =>
    // Structural, not incidental: with only `maxPrice` in `sellableVariants` there is no
    // floor for a later `$project` to pick up by accident, however the projection changes.
    repoSrc.includes("'bargain.maxPrice': 1")
    && !/\bbargain:\s*1\b/.test(repoSrc));

assert('⚠ neither file names the path `bargain.minPrice` at all', () =>
    !repoSrc.includes('bargain.minPrice') && !dtoSrc.includes('bargain.minPrice'));

assert('⚠ the public DTO carries no `minPrice` of any kind', () =>
    // ⚠ The repository legitimately does, and that is a NAME COLLISION rather than a leak:
    // `PublicProductQuery.minPrice` is the SHOPPER's filter floor, which travels in the
    // query string. The DTO has no such parameter, so there the word can only mean the
    // vendor's reserve — which is why the two halves of this rule are asserted separately
    // instead of as one grep that would have to be weakened to pass.
    !dtoSrc.includes('minPrice'));

assert('the repository\'s only `minPrice` is the shopper\'s filter bound', () =>
    repoSrc.split('minPrice').length - 1 === repoSrc.split(/(?:query\.minPrice|minPrice\?:)/).length - 1);

assert('⚠ the public DTO reads no raw `variant.price` — every quote goes through the rule', () =>
    !dtoSrc.includes('variant.price')
    && dtoSrc.includes('publicDisplayPrice(')
    && dtoSrc.includes('publicCompareAtPrice('));

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
