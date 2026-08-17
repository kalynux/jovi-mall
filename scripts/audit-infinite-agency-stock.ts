/**
 * Audit: products that are LIVE with agency storage and unlimited stock.
 *
 * ## Why this exists
 *
 * `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` makes unlimited stock an
 * activation blocker for `agency_storage` products — a warehouse holds a countable
 * number of things. No migration came with it, deliberately: rewriting a vendor's
 * catalogue quantities on their behalf would be inventing numbers, and flipping the
 * products to `draft` would silently unpublish live listings with no explanation.
 *
 * So products that were already active in that state STAY active until something
 * revalidates them (a variant edit, a product edit). This script finds them, so the
 * situation is resolved deliberately instead of discovered the next time a vendor
 * saves an unrelated field and watches their product drop out of `active`.
 *
 * **READ-ONLY.** It writes nothing and has no `--fix`. What to do with the output is
 * a conversation with each vendor: raise the real quantity, or move the product off
 * agency storage.
 *
 * Run: npx ts-node scripts/audit-infinite-agency-stock.ts
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { ProductModel } from '../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../src/modules/catalog/models/product-variant.model';
import { VendorModel } from '../src/modules/vendors/vendor.model';
import { COLLECTIONS } from '../src/core/database/collections';

dotenv.config();

interface Offender {
    productId: string;
    productTitle: string;
    status: string;
    vendorId: string;
    vendorName: string;
    effectiveAgencyId: string | null;
    infiniteVariants: Array<{ variantId: string; sku: string; stock: number }>;
}

async function main(): Promise<void> {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) {
        console.error('Set MONGODB_URI (or MONGO_URI) before running this audit.');
        process.exit(1);
    }

    await mongoose.connect(uri);
    console.log('Connected. Scanning for agency-stored products with unlimited stock…\n');

    // The same shape `findAgencyStoredVariants` matches, minus the agency filter —
    // this audit is platform-wide, not per agency. Status is left open so a product
    // already sitting in `draft` shows up too: it is still a latent block on the
    // vendor's next publish attempt, and worth naming now.
    const products = await ProductModel.find({
        type: 'physical',
        deletedAt: null,
        'delivery.pickup_location.source': 'agency_storage',
    }).lean();

    if (products.length === 0) {
        console.log('No agency-stored products at all. Nothing to audit.\n');
        await mongoose.disconnect();
        return;
    }

    const vendorIds = [...new Set(products.map(p => p.vendorId.toString()))];
    const vendors = await VendorModel.find({ _id: { $in: vendorIds } })
        .select('_id default_delivery_agency_id')
        .lean();
    const defaultAgencyByVendor = new Map(
        vendors.map(v => [v._id.toString(), v.default_delivery_agency_id?.toString() ?? null]),
    );

    // Business names come from the Store, never the vendor profile — the platform
    // rule since the Store/Magazin split.
    const stores = await mongoose.connection
        .collection(COLLECTIONS.STORE)
        .find({ vendor_id: { $in: vendorIds.map(id => new mongoose.Types.ObjectId(id)) } })
        .project({ vendor_id: 1, name: 1 })
        .toArray();
    const storeNameByVendor = new Map(
        stores.map(s => [s.vendor_id.toString(), (s.name as string) ?? '']),
    );

    const offenders: Offender[] = [];

    for (const product of products) {
        const variants = await ProductVariantModel.find({
            productId: product._id,
            status: 'active',
            deletedAt: null,
            isInfiniteStock: true,
        }).select('_id sku stock').lean();

        if (variants.length === 0) continue;

        const vendorId = product.vendorId.toString();
        offenders.push({
            productId: product._id.toString(),
            productTitle: product.title,
            status: product.status,
            vendorId,
            vendorName: storeNameByVendor.get(vendorId) ?? '(unknown store)',
            // Override first, else the vendor default — the same resolution order the
            // activation gate and checkout use.
            effectiveAgencyId:
                product.delivery?.agency_id?.toString() ?? defaultAgencyByVendor.get(vendorId) ?? null,
            infiniteVariants: variants.map(v => ({
                variantId: v._id.toString(),
                sku: v.sku,
                stock: v.stock,
            })),
        });
    }

    console.log(`Scanned ${products.length} agency-stored product(s).\n`);

    if (offenders.length === 0) {
        console.log('✅ None have unlimited stock. Nothing to resolve.\n');
        await mongoose.disconnect();
        return;
    }

    const live = offenders.filter(o => o.status === 'active');
    const other = offenders.filter(o => o.status !== 'active');

    console.log(`⚠️  ${offenders.length} product(s) break the countable-stock rule.`);
    console.log(`   ${live.length} are LIVE right now and will drop to 'draft' the next time`);
    console.log(`   anything revalidates them. ${other.length} are already unpublished and`);
    console.log('   simply cannot be published until this is fixed.\n');

    for (const o of offenders) {
        console.log(`  ${o.status === 'active' ? '🔴 LIVE ' : '⚪ ' + o.status.padEnd(6)} ${o.productTitle}`);
        console.log(`     product ${o.productId} · vendor ${o.vendorName} (${o.vendorId})`);
        console.log(`     agency  ${o.effectiveAgencyId ?? '(none resolvable)'}`);
        for (const v of o.infiniteVariants) {
            console.log(`     · SKU ${v.sku} — unlimited (stock field reads ${v.stock})`);
        }
        console.log('');
    }

    console.log('Resolve each by either:');
    console.log('  · turning off unlimited stock and recording the real warehoused quantity');
    console.log('    (on an agency-stored SKU that now goes through the two-sided request');
    console.log('    flow, so the agency confirms it); or');
    console.log('  · moving the product off agency storage back to a vendor-address pickup.\n');

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('Audit failed:', err);
    process.exit(1);
});
