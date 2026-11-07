/**
 * test:customer-booking-view — what a customer's booking read says about the service and the shop.
 *
 * Until 2026-10-26 the reads populated `productId` / `vendorId` in place: the documented
 * `product` / `vendor` keys never existed (every storefront booking screen said "Service"), and
 * `productId` reached the client as an object. Offline: the projection is a pure function, and
 * the one door that must call it is pinned by a source scan.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';

import { idOf, toBookingParties, type BookingPartyLookups } from '../../src/modules/booking/services/customer-booking-view';
import { productImageKey } from '../../src/modules/catalog/read-models/product-image.resolver';
import type { FileDetail } from '../../src/modules/catalog/read-models/product-detail.read-model';

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => boolean): void {
    try {
        if (fn()) {
            passed += 1;
            console.log(`  ✅ ${label}`);
        } else {
            failed += 1;
            console.log(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed += 1;
        console.log(`  ❌ THROW: ${label} — ${error instanceof Error ? error.message : String(error)}`);
    }
}

const SRC = join(__dirname, '..', '..', 'src');
const code = (rel: string): string =>
    readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PRODUCT = new Types.ObjectId();
const VARIANT = new Types.ObjectId();
const VENDOR = new Types.ObjectId();

const file = (n: number): FileDetail =>
    ({ id: `f${n}`, key: `k${n}`, url: `https://cdn/x${n}.jpg`, access: 'public', mimeType: 'image/jpeg' }) as unknown as FileDetail;

const lookups = (over: Partial<BookingPartyLookups> = {}): BookingPartyLookups => ({
    products: new Map([[PRODUCT.toString(), { title: 'Box braids', slug: 'box-braids', type: 'service', defaultVariantId: VARIANT.toString() }]]),
    storeNames: new Map([[VENDOR.toString(), 'Salon Amina']]),
    storeSlugs: new Map([[VENDOR.toString(), 'salon-amina']]),
    images: new Map([[productImageKey(PRODUCT.toString(), VARIANT.toString()), [1, 2, 3, 4, 5, 6, 7, 8].map(file)]]),
    ...over,
});

function main(): void {
    console.log('\n── ids ─────────────────────────────────────────────────────────────');
    assert('a populated document becomes its id string', () =>
        idOf({ _id: PRODUCT, title: 'Box braids' }) === PRODUCT.toString());
    assert('an ObjectId becomes its string', () => idOf(PRODUCT) === PRODUCT.toString());
    assert('a toJSON-shaped document (`id`, no `_id`) becomes its id', () => idOf({ id: 'abc', title: 'x' }) === 'abc');
    assert('null stays null', () => idOf(null) === null);

    console.log('\n── parties ─────────────────────────────────────────────────────────');
    const populated = toBookingParties(
        { productId: { _id: PRODUCT, title: 'Box braids', type: 'service' }, vendorId: { _id: VENDOR, display_name: 'amina' } },
        lookups(),
    );
    assert('productId / vendorId go back to id STRINGS', () =>
        populated.productId === PRODUCT.toString() && populated.vendorId === VENDOR.toString());
    assert('product carries title, slug and type', () =>
        populated.product?.title === 'Box braids' && populated.product.slug === 'box-braids' && populated.product.type === 'service');
    assert('image is the first picture, the gallery is capped at six', () =>
        populated.product?.image?.id === 'f1' && populated.product.images.length === 6);
    assert('vendor name is the STORE name, not the profile display name', () => populated.vendor?.name === 'Salon Amina');
    assert('store carries name and slug', () => populated.store?.name === 'Salon Amina' && populated.store.slug === 'salon-amina');

    const bare = toBookingParties({ productId: PRODUCT, vendorId: VENDOR }, lookups({ images: new Map() }));
    assert('an unpopulated read (the cancel response) resolves the same parties', () =>
        bare.product?.title === 'Box braids' && bare.vendor?.name === 'Salon Amina');
    assert('no pictures → image null, images empty', () => bare.product?.image === null && bare.product.images.length === 0);

    const gone = toBookingParties(
        { productId: PRODUCT, vendorId: { _id: VENDOR, display_name: 'amina' } },
        lookups({ products: new Map(), storeNames: new Map(), storeSlugs: new Map() }),
    );
    assert('a deleted product is product: null, never a half-filled object', () =>
        gone.product === null && gone.productId === PRODUCT.toString());
    assert('no store → the profile display name, and store: null', () =>
        gone.vendor?.name === 'amina' && gone.store === null);

    const parties = toBookingParties({ productId: PRODUCT, vendorId: VENDOR }, lookups()) as unknown as Record<string, unknown>;
    assert('the projection ADDS only ids and parties — never access, location or rescheduleProposal', () =>
        Object.keys(parties).sort().join(',') === 'product,productId,store,vendor,vendorId');

    console.log('\n── the door ────────────────────────────────────────────────────────');
    const controller = code('modules/booking/controllers/customer-booking.controller.ts');
    assert('withRefunds spreads the parties AFTER the shaped booking, beside refund and protection', () =>
        controller.includes('{ ...shaped, ...parties[i], refund:'));
    assert('…and the shaped booking is still built by toCustomerBookingShape', () =>
        controller.includes('const shaped = toCustomerBookingShape(visible'));

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    console.error('Suite crashed:', error);
    process.exitCode = 1;
}
