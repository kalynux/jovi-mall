import { PublicProductListItemDto } from '../../../catalog/dto/public-product.dto';
import { PublicProductListQuery } from '../../../catalog/validators/public-catalog.validator';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { formatBotPrice, formatBotPriceRange } from '../../domain/product-card';
import { InAppListingQuery } from '../../services/inapp-surface.store';
import { ImageSource, toImageSource } from './image-source';

/**
 * The product listing's READ — one query, one set of rules, rendered by two channels.
 *
 * ── ⚠ WHY THIS IS A SEPARATE FILE FROM ITS CONTROLLER ───────────────────────
 * The same listing is drawn twice: as a scrolling card grid in the Telegram Mini App
 * (`product-listing.controller.ts` → `pl.html`) and as a single-choice list in a WhatsApp Flow
 * (`whatsapp/flows`). A copy of this projection in the second place would be a second set of
 * rules that drifts from the first — a price formatted one way on one channel, a service
 * tappable on one and muted on the other.
 *
 * So the read lives here, and **both renderings import it**. It deliberately holds **no
 * Express, no session and no handle**: a Flow authenticates differently, and a controller
 * import would drag request-handling into a module that only wants data. That also keeps it
 * clear of the hazard that makes some surface controllers unimportable under bare ts-node.
 *
 * ── WHAT IS DECIDED HERE, AND THE ONE THING THAT IS NOT ─────────────────────
 * Decided here, identically for every channel: which products, in what order, their formatted
 * price, whether each is sellable, and what the shelf is called.
 *
 * ⚠ **NOT decided here: the picture's URL.** `imageSourceUrl` is the stored file's URL with no
 * rule applied, and that is deliberate rather than unfinished. The right rule depends on **who
 * fetches the image**, which differs per channel:
 *
 *   - a **browser** (the Mini App) fetches it from the customer's own phone, so a raw URL that
 *     phone may reach beats no picture — see `product-listing.controller.ts`;
 *   - a **platform** fetches server-side, where an unreachable host is a failed send;
 *   - a **WhatsApp Flow** takes an image as base64 bytes inside the response, not as a URL at
 *     all (Meta's component reference: Image `src` is "Base64 of an image").
 *
 * Resolving it here would bake one channel's rule into the other's data.
 */

/**
 * How many products a page holds unless the caller says otherwise.
 *
 * ⚠ **Deliberately NOT `BOT_DISPLAY_MAX_PRODUCTS` (10), and larger than it on purpose.** That
 * constant bounds a *chat* answer. A scrolling grid has no such constraint, and a customer who
 * taps "Load more" after nine products is being shown the seams of an implementation.
 * Twenty-four divides by two, three and four, so the Mini App's last row fills evenly.
 *
 * ⚠ **A WhatsApp Flow must pass its own, smaller size.** A `RadioButtonsGroup` holds at most
 * **20** options, so a default page overflows it by four. That cap belongs to the caller that
 * renders into it, which is why `pageSize` is a parameter rather than a second constant here.
 */
export const DEFAULT_LISTING_PAGE_SIZE = 24;

/** `LimitSchema`'s ceiling on a public catalogue read. A page is never asked for past it. */
const CATALOGUE_LIMIT_CEILING = 100;

export interface ListingProduct {
    productId: string;
    /**
     * The default variant, or null when nothing is sellable.
     *
     * ⚠ **"Is there anything sellable" — NOT `toBotProductCard`'s `buyable`.** That function
     * nulls the variant on every **service**, because a chat card would offer "Add to cart" and
     * the cart refuses services. A listing has the opposite obligation: a service is bookable,
     * the detail screen is where a booking starts, and nulling it would make every service
     * unopenable. The purchase ladder decides what the button *says*, one screen later.
     */
    variantId: string | null;
    title: string;
    /** Formatted, currency included. Never a number — no channel here does money maths. */
    priceText: string;
    storeName: string;
    inStock: boolean;
    /** ⚠ Raw. Each channel applies its own fetch rule — see the file header. */
    imageSourceUrl: string | null;
    /** The same picture as a stored file, for a renderer that needs its bytes — see `image-source.ts`. */
    image: ImageSource | null;
}

export interface ListingPage {
    /** The search term, the category, the shop's name, or null. Never translated, never invented. */
    heading: string | null;
    products: ListingProduct[];
    page: number;
    /** Is there a page after this one? Turning that into a cursor is the renderer's business. */
    hasMore: boolean;
}

/**
 * One page of a listing.
 *
 * ⚠ **Read live, every call.** A card quotes a price a customer can hold us to; nothing here
 * is cached, so page two says what a product costs now rather than when the listing opened.
 *
 * ⚠ **Pages the QUERY, not a held list of ids** — the deliberate opposite of
 * `ProductDisplaySet`, and `inapp-surface.store.ts` argues both sides. A pinned `productIds`
 * set is honoured when present, in the caller's order.
 */
export async function readListingPage(
    query: InAppListingQuery,
    options: { page?: number; pageSize?: number } = {},
): Promise<ListingPage> {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    /**
     * Clamped rather than refused: every caller is this codebase, and a page size outside the
     * catalogue's own limit is a caller's constant, not a customer's input. The clamp keeps the
     * query valid; it does NOT protect a Flow from its 20-option cap, which is the caller's to
     * respect.
     */
    const pageSize = Math.min(
        CATALOGUE_LIMIT_CEILING,
        Math.max(1, Math.trunc(options.pageSize ?? DEFAULT_LISTING_PAGE_SIZE)),
    );

    const { products, hasMore } = query.productIds?.length
        ? await pinnedPage(query.productIds, page, pageSize)
        : await queryPage(query, page, pageSize);

    return { heading: headingFor(query, products), products, page, hasMore };
}

/** One page of a catalogue query. */
async function queryPage(
    query: InAppListingQuery,
    page: number,
    pageSize: number,
): Promise<{ products: ListingProduct[]; hasMore: boolean }> {
    /**
     * Built as a literal rather than parsed through `PublicProductListQuerySchema`: nothing
     * here is a customer's input. `q`, `category` and `storeSlug` were validated by the chat
     * door that stored them, and the paging is this file's own.
     */
    const listQuery: PublicProductListQuery = {
        q: query.q ?? undefined,
        category: query.category ?? undefined,
        storeSlug: query.storeSlug ?? undefined,
        type: undefined,
        minPrice: undefined,
        maxPrice: undefined,
        inStock: undefined,
        /**
         * `relevance` with a search term, `newest` without — the storefront's own pairing. A
         * relevance sort with nothing to be relevant to is an arbitrary order passed off as a
         * ranking.
         *
         * ⚠ **What these actually sort by, measured in `sortStage` rather than read off the
         * names — it matters to any renderer that shows only page one** (a WhatsApp Flow shows
         * 20 and nothing more):
         *
         *   - `relevance` → Mongo `$text` score, highest first. Page one IS the best matches.
         *   - `newest`    → **`updatedAt` descending, NOT creation time.** A vendor editing an old
         *     product's description moves it to the top of a category or shop. "Most recently
         *     touched" is the honest description; "newest" is the parameter's name.
         *
         * Both tie-break on `_id`, so pages are stable — no row repeats or vanishes between
         * page one and page two unless the catalogue itself changes in between.
         */
        sort: query.q ? 'relevance' : 'newest',
        page,
        limit: pageSize,
    };

    const { data, meta } = await publicCatalogService.listProducts(listQuery);
    return {
        products: await withVariants(data),
        hasMore: page * pageSize < meta.total,
    };
}

/**
 * One page of a pinned set of ids — a wishlist, or a grid the model chose.
 *
 * ⚠ **The caller's ORDER is preserved and a missing id is DROPPED rather than an error**, the
 * rule `productDisplayService` follows: a product can be unpublished between the set being
 * built and the page being read, and four products is the right answer to five ids when one
 * has gone.
 */
async function pinnedPage(
    productIds: string[],
    page: number,
    pageSize: number,
): Promise<{ products: ListingProduct[]; hasMore: boolean }> {
    const start = (page - 1) * pageSize;
    const window = productIds.slice(start, start + pageSize);
    if (window.length === 0) return { products: [], hasMore: false };

    const hydrated = await publicCatalogService.listByIdsWithVariant(window);
    const rows = window
        .map((id) => hydrated.get(id))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    return {
        products: rows.map((entry) => toListingProduct(entry.item, entry.defaultVariantId)),
        hasMore: start + window.length < productIds.length,
    };
}

/**
 * A page of list rows → listing products.
 *
 * ⚠ **A second read, and it is not redundant.** `listProducts` answers
 * `PublicProductListItemDto`, which deliberately carries no variant id — `listByIdsWithVariant`
 * is a separate method precisely so the public DTO does not grow a field for one consumer.
 * Without it every product would be either wrongly sellable or wrongly muted. One extra by-ids
 * read per page, accepted rather than worked around with a new method on a catalogue service
 * another stream holds.
 */
async function withVariants(items: PublicProductListItemDto[]): Promise<ListingProduct[]> {
    if (items.length === 0) return [];

    const hydrated = await publicCatalogService.listByIdsWithVariant(items.map((i) => i.id));
    return items.map((item) => toListingProduct(item, hydrated.get(item.id)?.defaultVariantId ?? null));
}

function toListingProduct(item: PublicProductListItemDto, defaultVariantId: string | null): ListingProduct {
    return {
        productId: item.id,
        variantId: defaultVariantId,
        title: item.title,
        priceText: priceTextOf(item),
        storeName: item.store.name,
        inStock: item.inStock,
        imageSourceUrl: item.image?.url ?? null,
        image: toImageSource(item.image),
    };
}

/**
 * ⚠ **Formatted server-side; no channel does money maths.** The currency, the negotiable ask
 * and the discount rules are already resolved into this DTO by `public-display-price.ts`.
 * `formatBotPrice` rather than ICU, for the reason `product-card.ts` records: ICU's no-break
 * space differs between Node builds and its grouping would disagree with every other price
 * this platform prints.
 */
function priceTextOf(item: PublicProductListItemDto): string {
    return item.priceRange
        ? formatBotPriceRange(item.priceRange.min, item.priceRange.max, item.currency)
        : formatBotPrice(item.price, item.currency);
}

/**
 * What the shelf is called — the search term, the category, the shop, or nothing.
 *
 * ⚠ **Never translated and never invented.** A search term and a category are echoed from
 * what the customer asked for, so they are already in their words.
 *
 * ⚠ **A shop is named from its PRODUCTS, not from its slug and not by a lookup.** A
 * store-scoped query returns only that store's products, so every row already carries the same
 * `storeName` — reading it costs nothing and cannot disagree with the rows beneath it. A slug
 * (`electro-shop-douala`) is a database key, and resolving it would be a second catalogue read
 * per page. Null on an empty page: there is no row to read a name from.
 */
function headingFor(query: InAppListingQuery, products: ListingProduct[]): string | null {
    const asked = query.q?.trim() || query.category?.trim();
    if (asked) return asked;
    if (query.storeSlug) return products[0]?.storeName?.trim() || null;
    return null;
}
