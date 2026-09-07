import { Router } from 'express';
import { PublicCatalogController } from '../controllers/public-catalog.controller';

/**
 * Public catalog routes — the storefront's read side, readable without a session.
 * Mounted at `/api/public` → `/public/products`, `/public/variants`, `/public/categories`,
 * `/public/stores`.
 *
 * ⚠️ There is **no `requireAuth`** on this router, the same as `public-billing.routes.ts`
 * and `public-blog.routes.ts`. Every handler mounted here must be a read of data a vendor
 * has already deliberately put on sale. Nothing owner-scoped, nothing that reads `req.auth`,
 * nothing that writes. The vendor's own catalogue lives on `/api/vendor/products` behind
 * `requireRole(['vendor'])`, and a "preview my draft" endpoint belongs there — never here
 * behind a flag, because a flag on this router is a flag anyone on the internet can set.
 *
 * Visibility is decided in exactly one place for every route below —
 * `domain/services/public-catalog.filter.ts`. Do not spell a status filter out inline.
 *
 * This is the **third** router on the `/public` prefix. That is fine and already the
 * established pattern (billing + blog): their paths do not overlap, and Express falls
 * through one router when nothing in it matches. `/products`, `/variants`, `/categories`
 * and `/stores` collide with neither `/plans`, `/credit-packs` nor `/articles*`.
 */
const router = Router();

// ─── Products ────────────────────────────────────────────────────────────────

/** Browse, search, filter and sort. `?q=`, `?category=`, `?type=`, `?sort=`, `?page=`… */
router.get('/products', PublicCatalogController.listProducts);

/**
 * The deep-link form, ObjectId only.
 *
 * Safe to declare after `/products` and before nothing: there is no literal path under
 * `/products/` on this router, so `:productId` cannot shadow a sibling. It is nonetheless
 * constrained to 24-hex by its Zod schema rather than matching anything — a slug arriving
 * here is a `400`, which is a clearer answer than a `404` for what is really a wrong-URL-shape.
 */
/**
 * ⚠ **Declared BEFORE `/products/:productId`**, and this one is not a formality.
 *
 * Express matches in declaration order, but these two differ in segment count, so they
 * cannot actually shadow each other today. The ordering is here because the comment on
 * `/products/:productId` below says "there is no literal path under `/products/`" — and
 * that stopped being true the moment this landed. Most-specific-first keeps the file
 * honest about what is under that prefix, and keeps the next sibling safe by default.
 *
 * "Customers also bought" (Phase 6 · 6.E.3). A read: it records nothing about who asked.
 */
router.get('/products/:productId/related', PublicCatalogController.listRelatedProducts);

/**
 * ⚠ **Declared BEFORE `/products/:productId`, and here the ordering is LOAD-BEARING.**
 *
 * Unlike `/products/:productId/related` above — which is safe because it has one more
 * segment — this route has exactly the same segment count as `/products/:productId`.
 * Express matches in declaration order, so declaring it second means `by-ids` is read as a
 * product id, fails the 24-hex schema, and every hydration request answers `400` with a
 * message about a malformed id. Most-specific-first is not a style preference on this pair.
 *
 * `by-ids` is a literal segment for the same reason `variants/by-sku/:sku` is: it keeps the
 * `/products/` prefix open for the next sibling instead of letting a parameter swallow it.
 *
 * Batch hydration of ids the caller already holds — see the controller for why order and
 * `missing` are part of the contract.
 */
router.get('/products/by-ids', PublicCatalogController.listProductsByIds);

router.get('/products/:productId', PublicCatalogController.getProductById);

// ─── Variants ────────────────────────────────────────────────────────────────

/**
 * SKU → variant (GAP-003), the one route on this router keyed on something a customer TYPES.
 *
 * ⚠ **`by-sku` is a literal segment and `:sku` is the parameter** — deliberately, rather than
 * `/variants/:sku`. `ProductVariant.sku` is globally unique so a bare `/variants/:sku` would
 * work today, and would leave the next sibling under `/variants/` (a variant by id, say) with
 * nowhere to go that this parameter does not already swallow. The literal keeps the prefix
 * open, which is the same lesson `/articles/index` behind `/articles/:slug` taught this
 * service the hard way.
 */
router.get('/variants/by-sku/:sku', PublicCatalogController.resolveVariantBySku);

/** Distinct categories with counts, derived over the browse filter. */
router.get('/categories', PublicCatalogController.listCategories);

// ─── Stores ──────────────────────────────────────────────────────────────────

/**
 * ⚠️ **Declaration order matters below.** Express matches in the order routes are declared,
 * and these three share a prefix. They are ordered most-specific-first:
 *
 *   /stores                                   → the directory
 *   /stores/:slug                             → one store
 *   /stores/:slug/products                    → that store's grid
 *   /stores/:storeSlug/products/:productSlug   → one product (the canonical URL)
 *
 * The two-segment and three-segment forms cannot shadow each other (Express matches on
 * segment count), so the real constraint is that `/stores/:slug/products` is declared
 * before `/stores/:storeSlug/products/:productSlug` only for readability — they differ in
 * length too. `verify:storefront` asserts all four resolve to distinct handlers, because a
 * route table is exactly the kind of thing that looks right and is not.
 */
router.get('/stores', PublicCatalogController.listStores);
router.get('/stores/:slug', PublicCatalogController.getStoreBySlug);
router.get('/stores/:slug/products', PublicCatalogController.listStoreProducts);

/**
 * The canonical product URL.
 *
 * Products are nested under their store because `Product.slug` is unique per VENDOR, not
 * globally — see the controller. Keep this the address the sitemap and every internal link
 * emit; `/products/:productId` is a fallback, not an alternative.
 */
router.get('/stores/:storeSlug/products/:productSlug', PublicCatalogController.getProductBySlugs);

export default router;
