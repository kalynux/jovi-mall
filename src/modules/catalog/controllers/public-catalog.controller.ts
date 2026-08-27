import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { publicCatalogService } from '../services/public-catalog.service';
import { relatedProductsService } from '../services/related-products.service';
import {
    PublicProductIdParamSchema,
    PublicProductListQuerySchema,
    PublicProductSlugsParamSchema,
    PublicSkuParamSchema,
    PublicSlugParamSchema,
    PublicStoreListQuerySchema,
    PublicStoreProductListQuerySchema,
} from '../validators/public-catalog.validator';

/**
 * Unauthenticated reads of the published catalogue — the storefront.
 *
 * Read-only, no side effects, no identity. Everything served here is a product a vendor has
 * deliberately put on sale, or a store that sells one; nothing owner-scoped is reachable
 * from this controller and it must stay that way — see `public-catalog.routes.ts`.
 */

/**
 * Matches the plan catalogue's and the blog's convention, and the number is the same for
 * the same reason: five minutes is the window in which a newly published product, a price
 * change or a vendor going on holiday is invisible to the storefront.
 *
 * **That is not instant, and must not be described to a vendor as instant** — the shopper
 * waits this window *plus* whatever the storefront's own revalidation adds. It is the trade
 * for not putting an unauthenticated endpoint straight onto Mongo on every page view.
 */
const PUBLIC_CACHE_SECONDS = 300;

function cacheable(res: Response): Response {
    return res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
}

export class PublicCatalogController {
    /**
     * GET /api/public/products
     *
     * The browse grid, search, category chips, filters and sort — and the sitemap's product
     * feed. Returns the standard `{ data, meta }` page envelope.
     *
     * An empty result is `data: []` with `meta.total: 0`, never a 404: "no products match
     * this filter" is a successful answer to a well-formed question.
     */
    static listProducts = asyncHandler(async (req: Request, res: Response) => {
        const query = PublicProductListQuerySchema.parse(req.query);
        const page = await publicCatalogService.listProducts(query);
        cacheable(res).json({ success: true, data: page.data, meta: page.meta });
    });

    /**
     * GET /api/public/products/:productId
     *
     * The deep-link form, keyed on an ObjectId. The canonical product URL is the nested one
     * below — this exists so a link held from an order, a notification or a share sheet
     * resolves without the client having to know the store slug.
     */
    static getProductById = asyncHandler(async (req: Request, res: Response) => {
        const { productId } = PublicProductIdParamSchema.parse(req.params);
        const product = await publicCatalogService.getProductById(productId);
        cacheable(res).json({ success: true, data: product });
    });

    /**
     * GET /api/public/stores/:storeSlug/products/:productSlug
     *
     * The canonical product URL.
     *
     * Products are nested under their store because `Product.slug` is unique **per vendor**
     * (`{ vendorId: 1, slug: 1 }`), not globally — two vendors may both own `blue-shirt`, so
     * a bare `/products/:slug` cannot resolve one of them. Resolving the store first also
     * turns the lookup into an exact hit on that existing compound index.
     */
    static getProductBySlugs = asyncHandler(async (req: Request, res: Response) => {
        const { storeSlug, productSlug } = PublicProductSlugsParamSchema.parse(req.params);
        const product = await publicCatalogService.getProductBySlugs(storeSlug, productSlug);
        cacheable(res).json({ success: true, data: product });
    });

    /**
     * GET /api/public/variants/by-sku/:sku
     *
     * A product code — off a package, a label or an advertisement — resolved to the variant it
     * identifies (GAP-003). It exists because `?q=` is a `$text` search over title, tags and
     * description that does **not** index SKU: a customer typing a real code got an empty
     * search result indistinguishable from "we do not sell that".
     *
     * ⚠ **Answers a resolution, not a product card.** A SKU names one variant, frequently not
     * the default one a card quotes — so a card here would show the wrong price to precisely
     * the customer who typed a precise code. `productId` is in the response for the client
     * that wants the full product next.
     *
     * `404 CATALOG_PRODUCT_NOT_FOUND` covers unknown, draft, archived, suspended and
     * suspended-vendor alike — the 404-never-403 rule this whole surface follows.
     */
    static resolveVariantBySku = asyncHandler(async (req: Request, res: Response) => {
        const { sku } = PublicSkuParamSchema.parse(req.params);
        const resolution = await publicCatalogService.resolveSku(sku);
        cacheable(res).json({ success: true, data: resolution });
    });

    /**
     * GET /api/public/categories
     *
     * `Product.category` is a plain indexed string with no Category collection, model or
     * taxonomy anywhere — so the chip list is derived, over exactly the browse filter.
     * Returns a bare array (no `meta`): it is a small complete set, not a page.
     */
    static listCategories = asyncHandler(async (_req: Request, res: Response) => {
        const categories = await publicCatalogService.listCategories();
        cacheable(res).json({ success: true, data: categories });
    });

    /**
     * GET /api/public/products/:productId/related
     *
     * "Customers also bought" (Phase 6 · 6.E.3). A read with no side effects — nothing here
     * records that the strip was requested, so it is safe on a route anyone can call.
     *
     * ⚠ **`meta.source` is part of the contract, not diagnostics.** It says which signal
     * produced the list: `co_purchase` (a real count of orders containing both products) or
     * `same_category` (the fallback, when nothing has been bought alongside this yet). A
     * client that heads both strips "customers also bought" is publishing a claim about
     * other shoppers that the second one does not support — the "do not invent a metric"
     * rule, which is why the label is published rather than kept server-side.
     *
     * An empty `data` is a `200`, never a 404: "nothing is related to this yet" is a
     * successful answer, and a young catalogue produces it often.
     */
    static listRelatedProducts = asyncHandler(async (req: Request, res: Response) => {
        const { productId } = PublicProductIdParamSchema.parse(req.params);
        const result = await relatedProductsService.forProduct(productId);
        cacheable(res).json({ success: true, data: result.data, meta: { source: result.source } });
    });

    /**
     * GET /api/public/stores
     *
     * The seller directory, and the sitemap's source of store URLs. Stores with no
     * publishable products are excluded — an empty storefront is a soft-404 to a crawler.
     */
    static listStores = asyncHandler(async (req: Request, res: Response) => {
        const query = PublicStoreListQuerySchema.parse(req.query);
        const page = await publicCatalogService.listStores(query);
        cacheable(res).json({ success: true, data: page.data, meta: page.meta });
    });

    /**
     * GET /api/public/stores/:slug
     *
     * One seller's page. A suspended vendor's store 404s.
     *
     * Unlike the directory, a store with zero publishable products still resolves — a
     * shopper following a link from an order should read "nothing for sale right now", not
     * a dead page. The zero-product exclusion is a directory-and-sitemap rule.
     */
    static getStoreBySlug = asyncHandler(async (req: Request, res: Response) => {
        const { slug } = PublicSlugParamSchema.parse(req.params);
        const store = await publicCatalogService.getStoreBySlug(slug);
        cacheable(res).json({ success: true, data: store });
    });

    /**
     * GET /api/public/stores/:slug/products
     *
     * The store page's grid. Same query contract as `listProducts` minus `storeSlug`, which
     * is the path here.
     */
    static listStoreProducts = asyncHandler(async (req: Request, res: Response) => {
        const { slug } = PublicSlugParamSchema.parse(req.params);
        const query = PublicStoreProductListQuerySchema.parse(req.query);
        const page = await publicCatalogService.listStoreProducts(slug, query);
        cacheable(res).json({ success: true, data: page.data, meta: page.meta });
    });
}
