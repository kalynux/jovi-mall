/**
 * Verify the storefront against a REAL database.
 *
 * The counterpart to `verify:blog` and `verify:live-parity`, and it exists for the three
 * things the DB-free suites structurally cannot cover:
 *
 * 1. **The indexes actually BUILD.** `autoIndex` is on, so Mongoose creates them at boot —
 *    and a failed build fails *silently*: the promise rejects into a listener nobody
 *    attached, the process comes up healthy, and every storefront request quietly scans the
 *    collection instead. The `$text` index is the one that matters most, because MongoDB
 *    permits exactly one per collection and will refuse a second without anyone noticing.
 * 2. **The aggregation pipelines RUN.** Mongo validates a pipeline at execution time, not at
 *    compile time, so a malformed `$lookup` or a bad `$project` expression is a runtime error
 *    `tsc` cannot see. Every public read here is an aggregation.
 * 3. **The Express route table resolves.** `/stores/:slug` vs `/stores/:slug/products` vs
 *    `/stores/:storeSlug/products/:productSlug` — declaration order decides which handler a
 *    URL reaches, and a route table is exactly the kind of thing that looks right and is not.
 *
 * Read-only against your data: it creates its own `verify-storefront-*` fixtures and deletes
 * them, pass or fail.
 *
 * Run: npm run verify:storefront   (NEEDS Mongo — a replica set, like everything else here)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { COLLECTIONS } from '../../src/core/database/collections';
import { ProductModel } from '../../src/modules/catalog/models';
import { publicCatalogRepository } from '../../src/modules/catalog/repositories/mongo/public-catalog.repository.mongo';
import { skuCandidates } from '../../src/modules/catalog/domain/services/sku-resolution';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

// The console bridge swallows a test harness's own output — print through the original.
const log = console.log.bind(console);
const err = console.error.bind(console);

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
    try {
        const ok = await fn();
        if (ok) {
            log(`  ✅ ${name}`);
            passed++;
        } else {
            err(`  ❌ FAIL: ${name}`);
            failed++;
        }
    } catch (e) {
        err(`  ❌ THROW: ${name} — ${(e as Error).message}`);
        failed++;
    }
}

/** Everything this script creates carries this marker, so cleanup cannot miss a row. */
const MARKER = 'verify-storefront';

async function cleanup(): Promise<void> {
    const db = mongoose.connection;
    await Promise.all([
        db.collection(COLLECTIONS.PRODUCT).deleteMany({ slug: { $regex: `^${MARKER}` } }),
        // ⚠ Case-INSENSITIVE, unlike its siblings. The SKU fixtures deliberately include an
        // all-uppercase code (GAP-003 resolves a typed code by trying case variants, and that
        // path only means anything against a stored SKU whose case differs) — and a
        // case-sensitive sweep would leave it behind for the unique index to collide with on
        // the next run. No real SKU carries this prefix in any case.
        db.collection(COLLECTIONS.PRODUCT_VARIANT).deleteMany({ sku: { $regex: `^${MARKER}`, $options: 'i' } }),
        db.collection(COLLECTIONS.STORE).deleteMany({ slug: { $regex: `^${MARKER}` } }),
        db.collection(COLLECTIONS.VENDOR).deleteMany({ email: { $regex: `^${MARKER}` } }),
    ]);
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    log(`Connected to ${MONGO_URI}\n`);

    await cleanup(); // in case a previous run died mid-flight

    try {
        // ─── 1. Indexes ───────────────────────────────────────────────────────
        log('── Indexes (autoIndex fails SILENTLY, so this is the only proof) ──');

        // Force the build rather than trusting boot to have done it.
        await ProductModel.init();
        const indexes = await mongoose.connection.collection(COLLECTIONS.PRODUCT).indexes();
        const byKey = indexes.map((i) => JSON.stringify(i.key));

        await assert('the browse index built { status, deletedAt, createdAt:-1 }', () =>
            byKey.includes(JSON.stringify({ status: 1, deletedAt: 1, createdAt: -1 })));

        await assert('the category index built { status, deletedAt, category }', () =>
            byKey.includes(JSON.stringify({ status: 1, deletedAt: 1, category: 1 })));

        await assert('the $text index built (the ONE this collection is allowed)', () =>
            indexes.some((i) => Object.prototype.hasOwnProperty.call(i.key, '_fts')));

        await assert('there is exactly ONE text index — a second is silently refused', () =>
            indexes.filter((i) => Object.prototype.hasOwnProperty.call(i.key, '_fts')).length === 1);

        await assert('the text index carries our weights and no stemming', () => {
            const text = indexes.find((i) => Object.prototype.hasOwnProperty.call(i.key, '_fts'));
            const w = (text as { weights?: Record<string, number> })?.weights ?? {};
            return w.title === 10 && w.tags === 4 && w.description === 1 &&
                (text as { default_language?: string })?.default_language === 'none';
        });

        await assert('the per-vendor slug index still exists — the nested URL depends on it', () =>
            byKey.includes(JSON.stringify({ vendorId: 1, slug: 1 })));

        // ─── 2. Fixtures ──────────────────────────────────────────────────────
        log('\n── Fixtures ──');

        const db = mongoose.connection;
        const vendorId = new Types.ObjectId();
        const productId = new Types.ObjectId();
        const variantId = new Types.ObjectId();

        await db.collection(COLLECTIONS.VENDOR).insertOne({
            _id: vendorId,
            user_id: new Types.ObjectId(),
            email: `${MARKER}@example.com`,
            phone: '+237670000000',
            status: 'pending_verification', // the case §2.4 would have wrongly hidden
            country: 'CM',
            preferred_language: 'fr',
            kyc_details: { legit_verified: true },
            business_addresses: [{ _id: new Types.ObjectId(), label: 'Shop', address_line1: '1 St', city: 'Douala' }],
            policies: null,
            created_at: new Date(),
            updated_at: new Date(),
        } as never);

        await db.collection(COLLECTIONS.STORE).insertOne({
            vendor_id: vendorId,
            name: 'Verify Storefront Store',
            slug: `${MARKER}-store`,
            is_open: true,
            version: 0,
            created_at: new Date(),
            updated_at: new Date(),
        } as never);

        await db.collection(COLLECTIONS.PRODUCT).insertOne({
            _id: productId,
            vendorId,
            type: 'physical',
            status: 'active',
            mode: 'advanced',
            title: 'Verify Storefront Kettle',
            description: 'A kettle for verification',
            slug: `${MARKER}-kettle`,
            category: 'Home',
            tags: ['kettle'],
            hasVariants: true,
            defaultVariantId: variantId,
            fileIds: [],
            suspension: null,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as never);

        await db.collection(COLLECTIONS.PRODUCT_VARIANT).insertOne({
            _id: variantId,
            productId,
            sku: `${MARKER}-KETTLE-1`,
            status: 'active',
            optionSignature: 'default',
            price: 12000,
            stock: 4,
            isInfiniteStock: false,
            allow_oversell: false,
            optionValueIds: [],
            fileIds: [],
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as never);

        /**
         * A second sellable variant on the same product, for GAP-003.
         *
         * ⚠ **Its SKU is all-uppercase and its facts differ from the default variant's** —
         * both deliberately. The case is what makes the candidate-spelling path mean
         * anything (a stored code identical to the typed one proves nothing about it), and
         * the price/stock difference is what proves the resolution answers about the
         * VARIANT rather than about the product card, which is the whole design point.
         *
         * It does not disturb the browse assertions above: a list row quotes the DEFAULT
         * variant, which is still the 12 000 one, and `inStock` is true if ANY variant is.
         */
        await db.collection(COLLECTIONS.PRODUCT_VARIANT).insertOne({
            _id: new Types.ObjectId(),
            productId,
            sku: `${MARKER.toUpperCase()}-KETTLE-2`,
            name: 'Large',
            status: 'active',
            optionSignature: 'size:large',
            price: 15000,
            stock: 0,
            isInfiniteStock: false,
            allow_oversell: false,
            optionValueIds: [],
            fileIds: [],
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as never);

        log('  ✅ fixtures inserted');

        // ─── 3. The pipelines actually run ────────────────────────────────────
        log('\n── Pipelines (Mongo validates these at EXECUTION time) ──');

        await assert('browse runs and finds the fixture', async () => {
            const { rows, total } = await publicCatalogRepository.search({
                sort: 'newest', page: 1, limit: 50,
            });
            return total > 0 && rows.some((r) => r.slug === `${MARKER}-kettle`);
        });

        await assert('a PENDING_VERIFICATION vendor IS published — §2.4 would have hidden it', async () => {
            const { rows } = await publicCatalogRepository.search({ sort: 'newest', page: 1, limit: 50 });
            return rows.some((r) => r.storeSlug === `${MARKER}-store`);
        });

        await assert('the row carries resolved price and store identity', async () => {
            const { rows } = await publicCatalogRepository.search({ sort: 'newest', page: 1, limit: 50 });
            const row = rows.find((r) => r.slug === `${MARKER}-kettle`);
            return row?.price === 12000 && row?.storeName === 'Verify Storefront Store' && row?.inStock === true;
        });

        await assert('$text search runs and matches a whole word', async () => {
            const { rows } = await publicCatalogRepository.search({
                q: 'Kettle', sort: 'relevance', page: 1, limit: 50,
            });
            return rows.some((r) => r.slug === `${MARKER}-kettle`);
        });

        await assert('$text does NOT match a prefix — the documented trade', async () => {
            const { rows } = await publicCatalogRepository.search({
                q: 'Kettl', sort: 'relevance', page: 1, limit: 50,
            });
            return !rows.some((r) => r.slug === `${MARKER}-kettle`);
        });

        await assert('every filter combination runs without a pipeline error', async () => {
            await publicCatalogRepository.search({
                q: 'kettle', category: 'Home', types: ['physical'], storeSlug: `${MARKER}-store`,
                minPrice: 1, maxPrice: 999999, inStock: true, sort: 'price_asc', page: 1, limit: 10,
            });
            return true;
        });

        await assert('the nested (storeSlug, productSlug) lookup resolves', async () => {
            const hit = await publicCatalogRepository.findPublishableBySlugs(`${MARKER}-store`, `${MARKER}-kettle`);
            return hit?.id === productId.toString();
        });

        await assert('the id lookup resolves the same product', async () => {
            const hit = await publicCatalogRepository.findPublishableId(productId.toString());
            return hit?.id === productId.toString();
        });

        await assert('a wrong store slug does NOT resolve the product', async () => {
            const hit = await publicCatalogRepository.findPublishableBySlugs('some-other-store', `${MARKER}-kettle`);
            return hit === null;
        });

        await assert('categories aggregates and counts', async () => {
            const rows = await publicCatalogRepository.listCategories();
            return rows.some((r) => r.name === 'Home' && r.productCount > 0);
        });

        await assert('the store directory runs and includes the fixture', async () => {
            const { rows } = await publicCatalogRepository.listStores({ page: 1, limit: 50 });
            return rows.some((r) => r.slug === `${MARKER}-store` && r.productCount > 0);
        });

        await assert('the store directory filters by city', async () => {
            const { rows } = await publicCatalogRepository.listStores({ city: 'douala', page: 1, limit: 50 });
            return rows.some((r) => r.slug === `${MARKER}-store`);
        });

        await assert('a single store resolves with its policies projection', async () => {
            const row = await publicCatalogRepository.findStoreBySlug(`${MARKER}-store`);
            return row?.slug === `${MARKER}-store` && row?.vendorCity === 'Douala';
        });

        // ─── 3b. SKU resolution (GAP-003) ─────────────────────────────────────
        log('\n── SKU resolution ──');

        const resolveSku = (typed: string) =>
            publicCatalogRepository.findPublishableVariantsBySku(skuCandidates(typed));

        await assert('the SKU pipeline runs and resolves an exact code', async () => {
            const rows = await resolveSku(`${MARKER}-KETTLE-1`);
            return rows.length === 1
                && rows[0].productId === productId.toString()
                && rows[0].title === 'Verify Storefront Kettle'
                && rows[0].storeSlug === `${MARKER}-store`;
        });

        await assert('⚠ a code typed in the WRONG CASE still resolves — against the real unique index', async () => {
            // The stored SKU is upper; the customer types lower. This is the assertion the
            // candidate spellings exist for, and it cannot be made without a real index.
            const rows = await resolveSku(`${MARKER}-kettle-2`.toLowerCase());
            return rows.length === 1 && rows[0].sku === `${MARKER.toUpperCase()}-KETTLE-2`;
        });

        await assert('⚠ it answers about the VARIANT, not the product card', async () => {
            // The card quotes the default variant: 12 000, in stock. This variant is 15 000
            // and sold out. A resolution that reported the card's facts would quote the
            // wrong price to precisely the customer who typed a precise code.
            const [row] = await resolveSku(`${MARKER.toUpperCase()}-KETTLE-2`);
            return row?.price === 15000 && row?.inStock === false && row?.variantName === 'Large';
        });

        await assert('an unknown code resolves nothing — and never scans', async () => {
            const rows = await resolveSku(`${MARKER}-NOTHING-HERE`);
            return rows.length === 0;
        });

        await assert('a blank code issues no query at all', async () => {
            const rows = await publicCatalogRepository.findPublishableVariantsBySku(skuCandidates('   '));
            return rows.length === 0;
        });

        // ─── 4. Visibility, against real data ─────────────────────────────────
        log('\n── Visibility ──');

        await assert('drafting the product removes it from browse', async () => {
            await db.collection(COLLECTIONS.PRODUCT).updateOne({ _id: productId }, { $set: { status: 'draft' } });
            const { rows } = await publicCatalogRepository.search({ sort: 'newest', page: 1, limit: 50 });
            return !rows.some((r) => r.slug === `${MARKER}-kettle`);
        });

        await assert('a draft product does not resolve by its nested URL either', async () => {
            const hit = await publicCatalogRepository.findPublishableBySlugs(`${MARKER}-store`, `${MARKER}-kettle`);
            return hit === null;
        });

        await assert('⚠ nor by its SKU — a code is not a way past the publishable predicate', async () => {
            // The whole point of applying the predicate inside the product `$lookup`: a SKU
            // is a handle somebody may hold from before the product was withdrawn, and it
            // must answer 404 exactly like the URL does.
            const rows = await resolveSku(`${MARKER}-KETTLE-1`);
            return rows.length === 0;
        });

        await assert('suspending the VENDOR hides an otherwise-active product', async () => {
            await db.collection(COLLECTIONS.PRODUCT).updateOne({ _id: productId }, { $set: { status: 'active' } });
            await db.collection(COLLECTIONS.VENDOR).updateOne({ _id: vendorId }, { $set: { status: 'inactive' } });
            const { rows } = await publicCatalogRepository.search({ sort: 'newest', page: 1, limit: 50 });
            const store = await publicCatalogRepository.findStoreBySlug(`${MARKER}-store`);
            return !rows.some((r) => r.slug === `${MARKER}-kettle`) && store === null;
        });

        await assert('a suspended vendor\'s SKU does not resolve either', async () => {
            const rows = await resolveSku(`${MARKER}-KETTLE-1`);
            return rows.length === 0;
        });

        // ─── 5. Route table ───────────────────────────────────────────────────
        log('\n── Route table ──');

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const publicRouter = require('../../src/modules/catalog/routes/public-catalog.routes').default;
        const paths: string[] = publicRouter.stack
            .filter((l: { route?: unknown }) => l.route)
            .map((l: { route: { path: string } }) => l.route.path);

        // ⚠ This asserted `paths.length === 7` and broke when Step 9 added
        // `/products/:productId/related` — reporting only "expected 7", which says
        // nothing about WHICH route appeared or vanished. A count is the weakest form
        // of this check: it goes stale on every legitimate addition and it cannot tell
        // an added route from a deleted one plus an added one. Naming them makes the
        // failure message the diff.
        const EXPECTED_PUBLIC_ROUTES = [
            '/products',
            '/products/:productId/related',
            '/products/:productId',
            '/variants/by-sku/:sku',
            '/categories',
            '/stores',
            '/stores/:slug',
            '/stores/:slug/products',
            '/stores/:storeSlug/products/:productSlug',
        ];
        await assert(
            `the public catalog declares exactly its ${EXPECTED_PUBLIC_ROUTES.length} routes`,
            () => {
                const missing = EXPECTED_PUBLIC_ROUTES.filter((p) => !paths.includes(p));
                const unexpected = paths.filter((p) => !EXPECTED_PUBLIC_ROUTES.includes(p));
                if (missing.length || unexpected.length) {
                    log(`     missing:    ${missing.join(', ') || '(none)'}`);
                    log(`     unexpected: ${unexpected.join(', ') || '(none)'}`);
                    return false;
                }
                return true;
            },
        );

        // The two-segment route must come first. It is ordering-safe today because
        // Express matches on segment count, but that stops being true the moment
        // anybody makes the bare product route a prefix or wildcard match.
        await assert('/products/:productId/related precedes the bare /products/:productId', () =>
            paths.indexOf('/products/:productId/related') < paths.indexOf('/products/:productId'));

        await assert('/stores/:slug/products precedes the 4-segment product route', () =>
            paths.indexOf('/stores/:slug/products') < paths.indexOf('/stores/:storeSlug/products/:productSlug'));

        await assert('/stores (the directory) precedes /stores/:slug', () =>
            paths.indexOf('/stores') < paths.indexOf('/stores/:slug'));

        await assert('/categories is not shadowed by /products/:productId', () =>
            paths.includes('/categories'));

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cartPaths: string[] = require('../../src/modules/cart/routes').default.stack
            .filter((l: { route?: unknown }) => l.route)
            .map((l: { route: { path: string } }) => l.route.path);

        await assert('the variant-keyed delete precedes the product-keyed one', () =>
            cartPaths.indexOf('/items/variant/:variantId') < cartPaths.indexOf('/items/:productId'));

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const orderPaths: string[] = require('../../src/modules/orders/customer-order.routes').default.stack
            .filter((l: { route?: unknown }) => l.route)
            .map((l: { route: { path: string } }) => l.route.path);

        await assert('/orders/groups/:cartId precedes /orders/:id', () =>
            orderPaths.indexOf('/groups/:cartId') < orderPaths.indexOf('/:id'));
    } finally {
        await cleanup();
        log('\n  🧹 fixtures removed');
        await mongoose.disconnect();
    }

    log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main().catch((e) => {
    err('verify:storefront failed:', e);
    process.exit(1);
});
