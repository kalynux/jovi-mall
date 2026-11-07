import { Types } from 'mongoose';
import { ProductModel } from '../../catalog/models/product.model';
import { StoreRepository } from '../../store/repositories/store.repository';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { productImageKey, resolveProductImages } from '../../catalog/read-models/product-image.resolver';

/**
 * What the customer's booking reads say about the SERVICE and the SHOP — the part of a booking
 * screen that is a picture and a name rather than a time and a price.
 *
 * ── WHY THIS EXISTS (2026-10-26) ─────────────────────────────────────────────
 * `getUserBooking(s)` populate `productId` and `vendorId` in place, so the documented `product` /
 * `vendor` keys never existed: every storefront booking screen fell back to the bare word
 * "Service". Worse, the populated `productId` reached the client as an OBJECT where the doc and
 * the client type say an id string, and the storefront's reschedule screen built
 * `/api/products/[object Object]/availability` from it.
 *
 * So this puts `productId` / `vendorId` back to the documented id strings and ADDS three keys:
 *
 *  - `product` — `{ id, title, slug, type, image, images }`, or `null` when the product is gone.
 *    Pictures are resolved live through `resolveProductImages` (default variant first, product
 *    second), exactly as an order line's are — an image is not a term of the sale.
 *  - `vendor`  — `{ id, name }`, the STORE's business name, the profile's display name failing it.
 *  - `store`   — `{ name, slug }` for linking back to the storefront, or `null`.
 *
 * Batched: one product query, one store-name query, one slug read per vendor, one file query —
 * for the whole page of bookings.
 */

const GALLERY_MAX = 6;

export interface CustomerBookingProduct {
    id: string;
    title: string;
    slug: string | null;
    type: string | null;
    /** The thumbnail — `images[0]`, or `null` when nothing renderable is left. */
    image: FileDetail | null;
    images: FileDetail[];
}

export interface CustomerBookingParties {
    productId: string | null;
    vendorId: string | null;
    product: CustomerBookingProduct | null;
    vendor: { id: string; name: string } | null;
    store: { name: string; slug: string | null } | null;
}

/** An id out of whatever the read left there: an ObjectId, a string, or a populated document. */
export function idOf(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Types.ObjectId) return value.toString();
    if (typeof value === 'object') {
        const v = value as { _id?: unknown; id?: unknown };
        if (v._id != null) return idOf(v._id);
        if (typeof v.id === 'string') return v.id;
    }
    return null;
}

/** The populated vendor profile's display name, when the read populated it. */
function displayNameOf(value: unknown): string | null {
    if (value && typeof value === 'object' && 'display_name' in value) {
        const name = (value as { display_name?: unknown }).display_name;
        return typeof name === 'string' && name.trim() ? name : null;
    }
    return null;
}

export interface BookingPartyLookups {
    products: Map<string, { title: string; slug: string | null; type: string | null; defaultVariantId: string | null }>;
    storeNames: Map<string, string>;
    storeSlugs: Map<string, string>;
    images: Map<string, FileDetail[]>;
}

/**
 * The pure half: one booking's parties out of the batched lookups. Exported for the suite —
 * the shapes it guards (ids as strings, `null` rather than a half-filled object) are the
 * contract the storefront reads.
 */
export function toBookingParties(
    raw: { productId?: unknown; vendorId?: unknown },
    lookups: BookingPartyLookups,
): CustomerBookingParties {
    const productId = idOf(raw.productId);
    const vendorId = idOf(raw.vendorId);

    const found = productId ? lookups.products.get(productId) : undefined;
    const images = found && productId
        ? (lookups.images.get(productImageKey(productId, found.defaultVariantId)) ?? []).slice(0, GALLERY_MAX)
        : [];
    const product: CustomerBookingProduct | null = found && productId
        ? {
            id: productId,
            title: found.title,
            slug: found.slug,
            type: found.type,
            image: images[0] ?? null,
            images,
        }
        : null;

    const storeName = vendorId ? lookups.storeNames.get(vendorId) ?? null : null;
    const vendorName = storeName ?? displayNameOf(raw.vendorId);

    return {
        productId,
        vendorId,
        product,
        vendor: vendorId && vendorName ? { id: vendorId, name: vendorName } : null,
        store: storeName ? { name: storeName, slug: (vendorId && lookups.storeSlugs.get(vendorId)) || null } : null,
    };
}

export class CustomerBookingViewService {
    constructor(
        private readonly storeRepository = new StoreRepository(),
        private readonly fileRepository = new FileRepositoryMongo(),
    ) { }

    /** Parties for each booking, in input order. */
    async partiesFor(bookings: Array<{ productId?: unknown; vendorId?: unknown }>): Promise<CustomerBookingParties[]> {
        const productIds = [...new Set(bookings.map((b) => idOf(b.productId)).filter(
            (id): id is string => !!id && Types.ObjectId.isValid(id),
        ))];
        const vendorIds = [...new Set(bookings.map((b) => idOf(b.vendorId)).filter((id): id is string => !!id))];

        const [productRows, names, slugs] = await Promise.all([
            productIds.length > 0
                ? ProductModel.find({ _id: { $in: productIds } })
                    .select('title slug type defaultVariantId')
                    .lean()
                    .exec()
                : Promise.resolve([]),
            this.storeRepository.findNamesByVendorIds(vendorIds),
            this.resolveSlugs(vendorIds),
        ]);

        const products: BookingPartyLookups['products'] = new Map(
            (productRows as Array<{ _id: Types.ObjectId; title?: string; slug?: string; type?: string; defaultVariantId?: Types.ObjectId | null }>)
                .map((p) => [
                    p._id.toString(),
                    {
                        title: p.title ?? '',
                        slug: p.slug ?? null,
                        type: p.type ?? null,
                        defaultVariantId: p.defaultVariantId ? p.defaultVariantId.toString() : null,
                    },
                ]),
        );

        const images = await resolveProductImages(
            [...products.entries()].map(([productId, p]) => ({ productId, variantId: p.defaultVariantId })),
            this.fileRepository,
            getStorageProvider(),
        );

        const storeNames = new Map([...names.entries()].map(([vendorId, s]) => [vendorId, s.name]));
        return bookings.map((b) => toBookingParties(b, { products, storeNames, storeSlugs: slugs, images }));
    }

    /** Vendor id → store slug. `findNamesByVendorIds` projects name + logo only. */
    private async resolveSlugs(vendorIds: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        await Promise.all(
            vendorIds.map(async (vendorId) => {
                const store = await this.storeRepository.findByVendorIdOrNull(vendorId);
                if (store?.slug) out.set(vendorId, store.slug);
            }),
        );
        return out;
    }
}

export const customerBookingViewService = new CustomerBookingViewService();
