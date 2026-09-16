import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { PublicStoreDto } from '../../../store/dto/public-store.dto';
import { StoreSlugSchema } from '../../../catalog/validators/public-catalog.validator';
import { publicCatalogService } from '../../../catalog/services/public-catalog.service';
import { toPublicMediaUrl } from '../../domain/product-card';
import { BotCopyLanguage, toBotCopyLanguage } from '../../domain/bot-error-copy';
import { __IN_APP_SCREEN_PATH } from '../../domain/inapp-url';
import { InAppSurfaceSession, inAppSurfaceStore } from '../../services/inapp-surface.store';

/**
 * `inAppStoreListing` — the shop directory.
 *
 * ── WHY THIS IS A SCREEN AND NOT A CHAT PICKER ──────────────────────────────
 * There are well over a hundred shops. A WhatsApp list holds ten rows and a chat answer is
 * capped at five, so a picker over five of a hundred is a sample rather than a directory.
 * `bot-inapp.controller.ts`'s `stores` door has always minted a session for this screen; until
 * it existed that door fell back to a storefront link. Landing this file is what switches the
 * real thing on, with no change on the chat side.
 *
 * ── ⚠ A SHOP SHOWS A CITY AND NEVER AN ADDRESS ──────────────────────────────
 * Owner's decision, and it is a privacy rule rather than a layout one: a shop's ship-from
 * address is not public, and the city is what a customer actually needs in order to judge
 * delivery.
 *
 * The rule is kept **structurally rather than by care**. `toShopCard` builds a fresh object
 * with named fields and never spreads `PublicStoreDto`, so the card cannot inherit a field that
 * DTO gains later — the same argument `bot-projections.ts` makes one layer further out, and the
 * reason it matters more here is that this payload is rendered on a phone somebody is holding
 * in public. It also drops the three support-contact fields that DTO does carry: they belong on
 * a shop's own page, not on every row of a directory.
 *
 * ⚠ **The underlying read cannot reach a ship-from address either.** `PublicStoreDto` carries
 * `city` and `country` and no street, so there is no path from here to one. `test:inapp-orders`
 * § 2 pins both halves — the card's exact key set, and the absence of the address vocabulary
 * from this file and from `sl.html`.
 *
 * ── THE MOUNT IS THE SECURITY DECISION, AND IT IS INHERITED ─────────────────
 * `/api/bot/miniapp/**` carries neither `INTERNAL_SERVICE_TOKEN` nor `BOT_WEBHOOK_SECRET`. The
 * opaque handle in the URL is the only credential; it is kind-checked on read and dies in
 * thirty minutes. Nothing here reads an identity out of the request — and this screen needs
 * none, since a shop directory is public information either way.
 */

/**
 * How many shops a page holds.
 *
 * The grid's own figure, and for the grid's reason: it divides by two, three and four, so the
 * last row fills evenly at every column count `shell.css` produces, and it stays under
 * `LimitSchema`'s ceiling of 100.
 */
const PAGE_SIZE = 24;

/**
 * The furthest a customer may walk forward.
 *
 * A bound on a public, unauthenticated read whose cursor is caller-supplied — twenty-four times
 * two hundred is 4 800 rows, past which nobody is browsing and somebody is enumerating the
 * directory one deep `$skip` at a time.
 */
const MAX_PAGE = 200;

/**
 * ⚠ **A page number, deliberately not opaque** — the product grid's reasoning, unchanged. The
 * session pins the query; the cursor only says how far down it the customer has scrolled, and
 * an edited one reaches the same place scrolling reaches.
 */
const CursorSchema = z.object({
    cursor: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});

const HandleSchema = z.object({ handle: z.string().trim().min(3).max(64) });

/**
 * ⚠ **`StoreSlugSchema` is imported rather than a regex written here.** A second opinion about
 * what a slug may contain is how a shop becomes unreachable from one surface only — and this
 * value is about to be put into a `pl` session that the catalogue will match on.
 */
const OpenSchema = z.object({ storeSlug: StoreSlugSchema }).strict();

export class StoreListingController {
    /**
     * `GET /api/bot/miniapp/s/sl/:handle/data` — one page of the directory.
     *
     * ⚠ **Re-read live on every page, never cached onto the session.** A shop can close for
     * vacation or be unpublished inside the thirty minutes a screen lives, and a directory that
     * still offers it sends a customer into an empty grid. The session holds the *question*.
     */
    static data = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { cursor } = CursorSchema.parse(req.query);
        const session = await readStoreSession(handle);

        const language = toBotCopyLanguage(session.language);
        const page = cursor ?? 1;

        /**
         * Built as a literal rather than re-parsed through `PublicStoreListQuerySchema`:
         * nothing here is caller-supplied — `q` and `city` were validated by the chat door that
         * minted the session, and the paging is this file's own.
         */
        const { data, meta } = await publicCatalogService.listStores({
            q: session.query.q ?? undefined,
            city: session.query.city ?? undefined,
            page,
            limit: PAGE_SIZE,
        });

        /**
         * ⚠ **Extended on a READ** — somebody scrolling the directory is using the screen, and
         * letting it lapse under them is a lapse they did nothing to earn. Not awaited: a failed
         * extension costs a re-tap much later, and failing this read over it costs them the page
         * they are looking at now.
         */
        void inAppSurfaceStore.touch('sl', handle).catch(() => undefined);

        sendSuccess(res, {
            heading: headingFor(session.query),
            shops: data.map(toShopCard),
            labels: { verified: VERIFIED[language], closed: CLOSED[language] },
            emptyText: SHOPS_EMPTY[language],
            cursor: nextCursor(page, meta.total),
        });
    });

    /**
     * `POST /api/bot/miniapp/s/sl/:handle/open` — open one shop's products.
     *
     * ⚠ **A POST rather than a link per row, and the reason is arithmetic** — the same the
     * product grid gives for its own `open`. The grid screen needs a `pl` handle and only the
     * backend can mint one, so drawing 24 rows as links would mean 24 Redis writes per page for
     * a customer who taps at most one. The page posts the shop it wants and gets one URL back.
     *
     * ⚠ **This mints a session and nothing else.** No cart, no price, no order — it hands the
     * customer to the product grid, which is where a purchase can begin.
     *
     * ⚠ **Without this the directory is a wall of shops that do nothing.** The alternative
     * considered was linking out to each shop's storefront page, which was declined: it
     * navigates the customer out of the Telegram WebView mid-session, losing `close()`, the
     * theme and the back button, and it swaps one product-browsing experience for a second one
     * — the thing R9/R10's retirement of the old rail exists to avoid.
     */
    static open = asyncHandler(async (req: Request, res: Response) => {
        const { handle } = HandleSchema.parse(req.params);
        const { storeSlug } = OpenSchema.parse(req.body ?? {});
        const session = await readStoreSession(handle);

        await assertOfferable(storeSlug);

        const listingHandle = await inAppSurfaceStore.mint({
            kind: 'pl',
            owner: session.owner,
            customerId: session.customerId,
            channel: session.channel,
            externalId: session.externalId,
            language: session.language,
            /**
             * ⚠ **The owner binding is carried from the session, never read from the request.**
             * That is the security property of the whole surface: a session can only ever be
             * addressed at the conversation that asked for it, and nothing this page sends can
             * change whose basket a later write lands in.
             */
            query: { q: null, category: null, storeSlug, productIds: null },
        });

        /**
         * ⚠ **A same-origin path rather than `inAppScreenUrl`'s absolute URL**, exactly as the
         * grid's `open` does. That helper is the one reader of `BOT_MINIAPP_BASE_URL` and is
         * right for a URL that has to travel into a Telegram `web_app` button. This one does
         * not travel — it is handed to a page that is already open — and building it absolutely
         * would let a deployment whose configured origin is not the host the customer actually
         * reached navigate them off it mid-session. The path constant is imported so it cannot
         * drift from the helper's.
         */
        const url = `${__IN_APP_SCREEN_PATH}/pl/${listingHandle}?lang=${toBotCopyLanguage(session.language)}`;

        sendSuccess(res, { url });
    });
}

/**
 * Resolve a directory handle, or refuse the way the chat would have.
 *
 * One refusal bucket for unknown, lapsed, wrong-owner and wrong-kind — this surface's standing
 * position, because all four have the same remedy and distinguishing them would confirm that a
 * handle the caller does not own is real. `read('sl', …)` refuses every other kind by
 * construction.
 *
 * ⚠ **The code name says "product list" and this is a shop directory** — wrong in a log,
 * invisible to a customer, and shared with the order screen. There is no generic
 * in-app-screen-lapsed code, and `core/error-codes.ts` is a shared file this stream does not
 * own. Raised with the coordinator rather than added quietly.
 */
async function readStoreSession(
    handle: string,
): Promise<Extract<InAppSurfaceSession, { kind: 'sl' }>> {
    const session = await inAppSurfaceStore.read('sl', handle);
    if (!session) {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED,
            404,
            'That shop directory is no longer held',
        );
    }
    return session;
}

/**
 * May this screen open that shop?
 *
 * ⚠ **Bounded by publishability, not by membership — and the difference is stated rather than
 * hidden.** A directory session holds a *query*, so there is no set of slugs to test a tap
 * against without re-running the search, which would be a second full read on every tap racing
 * the first. The bound is therefore the same one the query itself has: the slug must name a
 * store the public catalogue would serve.
 *
 * The residual is that a tampered slug can open a publishable shop the customer's filter would
 * not have returned. What that reaches is a public shop's public products — already readable by
 * anyone at `/api/public/stores/:slug` with no credential at all — and the `pl` session it
 * mints is addressed at the session's own owner, so a later cart write lands in that customer's
 * own basket. The grid's `assertOfferable` states the same residual for the same reason.
 *
 * ⚠ **The 404 `getStoreBySlug` raises is re-thrown as a 422, and that is a correctness fix
 * rather than a preference.** Letting it through was wrong in a way only visible on the page:
 * `sl.html`'s `explain()` maps EVERY 404 to "This page is no longer available — ask me again in
 * the chat", because on every other path a 404 here means the handle has lapsed. So a single
 * shop being unpublished between the directory rendering and the customer tapping it told them
 * the whole screen was dead, and sent them back to the chat to reopen a directory that was
 * working perfectly.
 *
 * 422 is the grid's posture for exactly this ("that item is not on this list"), and it is what
 * makes the two 404-shaped faults distinguishable to a page that can only see a status code.
 * The message is written here rather than inherited, so the customer is told about the shop.
 *
 * ⚠ The code's registry name is product-flavoured — the same mismatch the lapsed-handle code
 * has, and the same one the coordinator is scheduling a generic replacement for. The status and
 * the message are what the page and the customer actually see.
 */
async function assertOfferable(storeSlug: string): Promise<void> {
    try {
        await publicCatalogService.getStoreBySlug(storeSlug);
    } catch {
        throw createAppError(
            ERROR_CODES.BOT_PRODUCT_NOT_IN_LIST,
            422,
            'That shop is not available any more',
        );
    }
}

/**
 * The next page's cursor, or null when there is not one this endpoint would accept.
 *
 * ⚠ **`MAX_PAGE` belongs in this condition as well as in the schema, and leaving it out was a
 * real defect.** `CursorSchema` refuses anything above `MAX_PAGE`, so a cursor of `MAX_PAGE + 1`
 * is a page the customer can be OFFERED and this endpoint will then refuse: "Load more"
 * appears, the tap 400s, and the page says "Something went wrong" — a customer told the screen
 * is broken when they have simply reached the end of it.
 *
 * The two places answer different questions: the schema bounds what a caller may ask for, this
 * bounds what we may offer. A bound only on the refusing side turns a natural end into a fault.
 */
function nextCursor(page: number, total: number): string | null {
    if (page >= MAX_PAGE) return null;
    return page * PAGE_SIZE < total ? String(page + 1) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  What the page renders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One shop, as a directory row.
 *
 * ⚠ **This key set IS the privacy rule**, and `test:inapp-orders` § 2 asserts it exactly rather
 * than asserting the absence of a list of forbidden words — a denylist agrees with any field
 * added to it later. `city` is the only location this shape can hold; there is no field for a
 * street, a ship-from address, a coordinate or a support contact, so adding one has to be a
 * deliberate act that breaks a test.
 */
interface ShopCard {
    slug: string;
    name: string;
    /** ⚠ The ONLY location on this card. A shop's ship-from address is not public. */
    city: string | null;
    imageUrl: string | null;
    verified: boolean;
    /** Vendor vacation mode. Products stay listed either way — the shop is simply not serving. */
    open: boolean;
}

function toShopCard(store: PublicStoreDto): ShopCard {
    return {
        slug: store.slug,
        name: store.name,
        city: store.city,
        imageUrl: logoUrl(store),
        verified: store.verified,
        open: store.isOpen,
    };
}

/**
 * The shop's logo, for a **browser** rather than for a platform's fetcher.
 *
 * ⚠ **The reachability rule is the wrong test on this surface**, the point the grid's own image
 * helper makes: `toPublicMediaUrl` exists because Telegram and Meta fetch media server-side, so
 * a loopback or carrier-NAT host is a rejected send rather than a slow image. Here the fetcher
 * is the customer's own phone inside a WebView, which on a development machine can reach exactly
 * the private host that rule rejects. So the rewrite is kept — it is what makes the URL correct
 * in production — and the rejection is not.
 *
 * `logo.url` is already `null` for a file in a private tree (`FileDetail` enforces that), and a
 * shop logo never is; the null branch here is the shop that has not uploaded one.
 */
function logoUrl(store: PublicStoreDto): string | null {
    const raw = store.logo?.url ?? null;
    return raw ? toPublicMediaUrl(raw) ?? raw : null;
}

/**
 * What the screen calls this shelf — the city or the search term, or nothing.
 *
 * ⚠ **Never translated and never invented**, the rule the grid's `headingFor` states: it is
 * echoed from what the customer asked for, so it is already in their words. The screen's own
 * heading comes from `inAppCopy.storesHeading`.
 */
function headingFor(query: { q?: string | null; city?: string | null }): string | null {
    return query.city?.trim() || query.q?.trim() || null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The directory's own vocabulary
//
//  ⚠ Two badges and an empty state, and they live here rather than in `inapp-copy.ts` for the
//  reason the order screen's status words do: that table is Stream 0's, it is read by five
//  screens, and `assertInAppCopyComplete` runs at BOOT — a key added there mid-flight with one
//  translation missing stops the server for every session in this tree.
//
//  They are sent ONCE at the top of the payload rather than repeated on every row: they do not
//  vary per shop, and a directory of 24 rows would otherwise carry 48 copies of two words.
// ─────────────────────────────────────────────────────────────────────────────

type Copy = Record<BotCopyLanguage, string>;

const VERIFIED: Copy = Object.freeze({
    en: 'Verified',
    fr: 'Vérifiée',
    pt: 'Verificada',
    es: 'Verificada',
    ar: 'موثّقة',
});

/**
 * ⚠ **"Closed" is about the shop, not about the account.** It is vendor vacation mode: the shop
 * is not serving today and its products stay listed. Worded as a state rather than as a warning
 * for that reason — a customer can still browse, and the cart is where an unavailable item is
 * actually refused.
 */
const CLOSED: Copy = Object.freeze({
    en: 'Closed',
    fr: 'Fermée',
    pt: 'Fechada',
    es: 'Cerrada',
    ar: 'مغلقة',
});

const SHOPS_EMPTY: Copy = Object.freeze({
    en: 'No shops to show here. Ask me in the chat and I will look again.',
    fr: 'Aucune boutique à afficher ici. Demandez-moi dans la discussion et je chercherai à nouveau.',
    pt: 'Não há lojas para mostrar aqui. Pergunte-me na conversa e procuro outra vez.',
    es: 'No hay tiendas que mostrar aquí. Pídemelo en el chat y buscaré de nuevo.',
    ar: 'لا توجد متاجر لعرضها هنا. اسألني في المحادثة وسأبحث مرة أخرى.',
});

/** ⚠ Exported for `test:inapp-orders` § 2, which pins the card's key set and the five languages. */
export const __STORE_LISTING = Object.freeze({
    PAGE_SIZE,
    MAX_PAGE,
    VERIFIED,
    CLOSED,
    SHOPS_EMPTY,
    toShopCard,
    headingFor,
    nextCursor,
});
