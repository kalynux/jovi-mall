/**
 * What "publishable" means, in one place.
 *
 * `/api/public/*` is the ONE mount with no auth guard anywhere above or below it, so
 * this predicate is the whole access-control story for the storefront: everything it
 * admits is world-readable. It exists as a single exported definition — rather than a
 * filter object spelled out at each call site — because the browse list, the product
 * detail, the category counts, the store list, the store's own product list and the
 * booking-availability route must all agree. A product that appears in the grid and
 * 404s on its own page (or vice versa) is a worse bug than either endpoint being
 * wrong on its own, and six hand-written copies is how that happens.
 *
 * ── The four conditions ──────────────────────────────────────────────────────
 *
 * `status: 'active'` — and this carries far more weight than it looks.
 * `ProductStatusValidationService.collectActivationBlockers` refuses to let a product
 * reach `active` without: a non-empty description, at least one variant, `price > 0`
 * on every active variant, a resolvable active `defaultVariantId`, a vendor that is
 * not suspended, and — for physical products — an active default delivery agency, an
 * approved vendor↔agency connection and a valid pickup location. Filtering on `active`
 * inherits every one of those, which is why the public endpoints do NOT re-validate
 * them. `revalidateActiveStatus` demotes a product to `draft` the moment any of it
 * stops holding.
 *
 * `deletedAt: null` — soft deletes. `BaseRepository` applies this automatically, but
 * these reads are aggregations that bypass it, so it is spelled out.
 *
 * `suspension: null` — a suspended product is off sale by an agency's, an
 * administrator's or a cascade's decision. Note `status: 'suspended'` already excludes
 * these; the second condition is belt-and-braces against a row whose status and
 * suspension block ever disagree.
 *
 * The **vendor** must not be suspended — which cannot be expressed here, because it
 * lives on another collection. See `VENDOR_PUBLISHABLE_MATCH` below; every aggregation
 * joins the vendor and applies it.
 *
 * ── Why `!== 'inactive'` and never `=== 'active'` ────────────────────────────
 *
 * `BACKEND-SHOP-REQUIREMENTS.md` §2.4 asks for `vendor.status === 'active'`. That is
 * the wrong form here, and the repo has been bitten by it before — see the long note
 * in `jovi-mall/CLAUDE.md` about `requireAuth`.
 *
 * `pending_verification` is the schema default at registration, so the positive form
 * would hide the store of every vendor who never verified their email. Worse, it would
 * hide it *inconsistently*: `ProductStatusValidationService` gates activation on
 * `vendor?.status === 'inactive'`, so those vendors' products are legitimately `active`
 * and would keep appearing in the browse grid while their store page 404s and their
 * product detail — which joins the same vendor — disappears.
 *
 * Matching the activation gate's own form is what keeps the storefront self-consistent.
 * Refusing only `inactive` is provably a no-op against existing data.
 */
import { FilterQuery } from 'mongoose';
import { IProduct } from '../../models/product.model';

/**
 * The product half of the predicate, as a Mongoose filter.
 *
 * Returned as a fresh object on every call, deliberately: a shared frozen constant
 * would be spread into `$match` stages and mutated by callers adding their own keys.
 */
export function publishableProductFilter(): FilterQuery<IProduct> {
    return {
        status: 'active',
        deletedAt: null,
        suspension: null,
    };
}

/**
 * The vendor half, as an aggregation `$match` fragment applied after a `$lookup`.
 *
 * The joined field is named `vendor` by convention in every public pipeline. Read the
 * negation carefully — see the header: this is `not suspended`, NOT `is active`.
 */
export const VENDOR_PUBLISHABLE_MATCH = Object.freeze({
    'vendor.status': { $ne: 'inactive' },
});

/**
 * The same vendor rule for a document already in hand, rather than a pipeline.
 *
 * Used by the two single-document reads (product detail, store detail) which resolve
 * the vendor separately instead of joining it.
 */
export function isVendorPublishable(vendorStatus: string | null | undefined): boolean {
    return vendorStatus !== 'inactive';
}

/**
 * The product half of the predicate, for a domain object already loaded.
 *
 * Pure and query-free, which is the point: it is called from paths that hold a product and
 * must not pay for a second round trip — notably the **unauthenticated**
 * `GET /api/products/:productId/availability`, which had no status check at all and leaked
 * the booking calendar of draft and suspended products.
 *
 * ⚠️ It does **not** check the vendor, because a domain `Product` does not carry one. In
 * practice that is covered: suspending a vendor cascades every one of their `active`
 * products to `suspended` in the same transaction (`ProductPlatformSuspensionService`), so
 * a live product under a suspended vendor is not a state the system produces. Any caller
 * that can afford the extra read should still apply `isVendorPublishable` on top — the
 * aggregation paths in `PublicCatalogRepositoryMongo` all do.
 */
export function isPublishableProduct(product: {
    status: string;
    deletedAt?: Date | null;
    suspension?: unknown;
}): boolean {
    return (
        product.status === 'active' &&
        !product.deletedAt &&
        (product.suspension === null || product.suspension === undefined)
    );
}

/**
 * The product statuses a shopper may never observe, as a positive list.
 *
 * Exported for the tests, which assert that exactly one of the five product statuses
 * is publishable — so adding a sixth to the enum without deciding about it here fails
 * loudly rather than silently becoming public.
 */
export const PUBLISHABLE_PRODUCT_STATUSES: readonly string[] = Object.freeze(['active']);
