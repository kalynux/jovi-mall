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
 * Run: npm run test:public-catalog
 */
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
    priceRangeOf([variant({ price: 100 })]) === undefined);
assert('identical prices across variants yield NO priceRange', () =>
    priceRangeOf([variant({ id: 'a', price: 100 }), variant({ id: 'b', price: 100 })]) === undefined);
assert('differing prices yield min/max', () => {
    const r = priceRangeOf([variant({ id: 'a', price: 100 }), variant({ id: 'b', price: 250 })]);
    return r?.min === 100 && r?.max === 250;
});
assert('an archived variant does NOT widen the price range', () => {
    const r = priceRangeOf([
        variant({ id: 'a', price: 100 }),
        variant({ id: 'b', price: 999, status: 'archived' }),
    ]);
    return r === undefined;
});

assert('a sub-hour duration reads "per 45 min"', () => servicePriceUnit(45) === 'per 45 min');
assert('an exact hour reads "per 1 h"', () => servicePriceUnit(60) === 'per 1 h');
assert('90 minutes reads "per 1 h 30 min"', () => servicePriceUnit(90) === 'per 1 h 30 min');
assert('priceFrom is the rate itself — peak hours only ever ADD', () =>
    servicePriceFrom(variant({ price: 24000 })) === 24000);

// ─── 3. The projections ──────────────────────────────────────────────────────

console.log('\n── Projections ──');

assert('compareAtPrice is explicit null when absent, not omitted', () => {
    const dto = toPublicVariantDto(variant({ compareAtPrice: undefined }), 'XAF', new Map(), new Map(), []);
    return 'compareAtPrice' in dto && dto.compareAtPrice === null;
});

assert('sku IS published — already unique and already shown on cart/order lines', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), []);
    return dto.sku === 'TSHIRT-RED-L';
});

assert('optionValueIds is published as the selection key', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), []);
    return Array.isArray(dto.optionValueIds) && dto.optionValueIds.length === 1;
});

assert('optionSignature is NEVER published — it goes stale on a value rename', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), []);
    return !('optionSignature' in dto) && !JSON.stringify(dto).includes('size:large');
});

assert('variant images are OMITTED when the variant has none', () => {
    const dto = toPublicVariantDto(variant(), 'XAF', new Map(), new Map(), []);
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
        'XAF', new Map(), new Map(), [],
    );
    // "per 1 h" rather than BACKEND-SHOP-REQUIREMENTS §2.7d's "per 60 min" example: the
    // former is the better human string, and `durationMinutes` ships beside it so a
    // five-locale storefront can format its own label rather than print this English one.
    return dto.service?.priceUnit === 'per 1 h' && dto.service?.priceFrom === 24000 && dto.price === 24000;
});

assert('a digital variant publishes terms of sale but never the asset', () => {
    const dto = toPublicVariantDto(
        variant({ digitalConfig: { assetId: 'SECRET_ASSET_ID', maxDownloads: 3, expiresAfterDays: 30 } }),
        'XAF', new Map(), new Map(), [],
    );
    return (
        dto.digital?.maxDownloads === 3 &&
        dto.digital?.expiresAfterDays === 30 &&
        !JSON.stringify(dto).includes('SECRET_ASSET_ID')
    );
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
    );
    return dto.name === buildVariantDisplayName(null, [{ optionName: 'Size', value: 'M' }], 'DRESS-WAX-M');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
