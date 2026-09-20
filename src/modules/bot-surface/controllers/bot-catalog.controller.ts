import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { wishlistService } from '../../customers/services/wishlist.service';
import { recentlyViewedService } from '../../customers/services/recently-viewed.service';
import { DigitalEntitlementService } from '../../digital-delivery/services/digital-entitlement.service';
import { DownloadLinkService } from '../../digital-delivery/services/download-link.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { downloadActionId } from '../domain/bot-action-id';
import { BotActionHandlers, ParsedBotAction, unknownBotAction } from '../domain/bot-action-dispatch';
import { BOT_CHAT_LIST_MAX, windowForChat } from '../domain/bot-list-window';
import { BotReplyOption } from '../domain/channel-reply';
import {
    BotEntitlementSchema,
    BotNoArgsSchema,
    BotPageSchema,
    BotProductIdSchema,
    BotProductParamSchema,
} from '../validators/bot.validators';

const entitlementService = new DigitalEntitlementService();
const downloadLinkService = new DownloadLinkService();

/**
 * The customer's own lists, and their digital library.
 *
 * Every one of these is owner-scoped by `customerId` inside the query — the same
 * `role_entity._id` the customer API passes — so there is no parameter a caller could set
 * to reach somebody else's list. That is worth stating because it is the property the
 * whole surface rests on, and these are the routes where it is least obvious: a wishlist
 * looks like public data until you notice whose it is.
 */
export class BotCatalogController {
    /** `POST /wishlist/list` — saved products, newest save first. */
    static listWishlist = asyncHandler(async (req: Request, res: Response) => {
        const { page, limit } = BotPageSchema.parse(req.body ?? {});
        const { data, meta } = await wishlistService.list(botCallerOf(req).customerId, page, limit);

        const chat = windowForChat({
            items: data,
            total: meta.total,
            offset: (page - 1) * limit,
            surface: 'wishlist',
            language: botResponseLanguageOf(req),
        });

        sendSuccess(res, chat.items, { meta: { ...meta, ...chat.window } });
    });

    /**
     * `POST /wishlist` — save a product.
     *
     * Idempotent by design: saving something already saved answers 200 and does NOT move
     * the entry, because a wishlist is ordered by when the customer decided. That is the
     * customer API's behaviour and the reason this route needs no special handling under a
     * retry beyond the key the surface demands anyway.
     */
    static addWishlist = asyncHandler(async (req: Request, res: Response) => {
        const { productId } = BotProductIdSchema.parse(req.body ?? {});
        const entry = await wishlistService.add(botCallerOf(req).customerId, productId);
        sendSuccess(res, entry, { message: 'Saved to your wishlist.' });
    });

    /**
     * `DELETE /wishlist/:productId` — remove a save.
     *
     * Answers `{ removed: true }` rather than the customer API's `null`, matching the
     * catalogue's `important_fields`. A chat has to say something happened, and `data: null`
     * gives a model nothing to say it with.
     */
    static removeWishlist = asyncHandler(async (req: Request, res: Response) => {
        const { productId } = BotProductParamSchema.parse(req.params);
        await wishlistService.remove(botCallerOf(req).customerId, productId);
        sendSuccess(res, { removed: true }, { message: 'Removed from your wishlist.' });
    });

    /**
     * `POST /recently-viewed` — record that a product was opened.
     *
     * ⚠ **Carries no timestamp, deliberately.** The list is ordered and capped by that
     * value, so a caller-supplied one is a caller-chosen position in a bounded list. The
     * customer API's schema has no such field either, and this one must not grow one.
     *
     * It also updates `recentProductCode` on the profile, which is what the support-routing
     * ladder falls back to — so this is not only a convenience list.
     */
    static recordView = asyncHandler(async (req: Request, res: Response) => {
        const { productId } = BotProductIdSchema.parse(req.body ?? {});
        const entry = await recentlyViewedService.record(botCallerOf(req).customerId, productId);
        sendSuccess(res, entry);
    });

    /**
     * `POST /recently-viewed/list` — what the customer has been looking at.
     *
     * ⚠ **This list gets NO `moreUrl`, and that is the honest answer rather than an
     * omission.** The storefront records views from the product page and shows them on no
     * page at all — verified in `frontend/landing`, where the only reference is the write.
     * Sending a customer to "see the rest on the website" would be an invitation to a page
     * that does not list them. `windowForChat` takes `surface: null` for exactly this.
     *
     * The rows survive their products going away — the service degrades those to
     * `product: null` rather than dropping them — so a caller must expect an entry it
     * cannot render and say "no longer available" instead of skipping it silently.
     */
    static listRecentlyViewed = asyncHandler(async (req: Request, res: Response) => {
        const { page, limit } = BotPageSchema.parse(req.body ?? {});
        const { data, meta } = await recentlyViewedService.list(
            botCallerOf(req).customerId,
            page,
            limit,
        );

        const chat = windowForChat({
            items: data,
            total: meta.total,
            offset: (page - 1) * limit,
            surface: null,
            language: botResponseLanguageOf(req),
        });

        sendSuccess(res, chat.items, { meta: { ...meta, ...chat.window } });
    });

    /**
     * `DELETE /recently-viewed` — forget the browsing history.
     *
     * ⚠ **Genuinely destructive: the rows are deleted, not flagged**, and nothing
     * reconstructs them. It is `requires_confirmation` in the catalogue for that reason —
     * "clear my history" is a sentence a model could plausibly infer from "I'm not
     * interested in those", and it must not.
     *
     * The service also clears the legacy `recentProductCode` mirror, which is what the
     * support-routing ladder falls back to when it has nothing else — so a customer who
     * clears their history and then asks "who do I contact about that thing" may get the
     * platform rung rather than a vendor. Correct, and worth knowing.
     */
    static clearRecentlyViewed = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const { removed } = await recentlyViewedService.clear(botCallerOf(req).customerId);
        sendSuccess(res, { cleared: true, removed }, { message: 'Browsing history cleared.' });
    });

    /**
     * `POST /digital/my-products` — the purchased library, with each entitlement's state, **and
     * the downloadable ones drawn as buttons**.
     *
     * ⛔ **Until this reply existed, a customer could not download a file they had paid for.**
     * The model can list the library, but minting a link is `flow_only` — deliberately, because a
     * model holding a bearer URL is a model that can put it in a sentence — and no flow was ever
     * built to call it. So the capability was built, mounted, validated, documented and reachable
     * by nobody. A tap is the path that restriction always left room for.
     */
    static listEntitlements = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const language = botResponseLanguageOf(req);
        const entitlements = await entitlementService.getCustomerEntitlements(
            botCallerOf(req).customerId,
        );

        /**
         * ⚠ **Unpaginated, so the slice inside `windowForChat` IS the cap here.** The
         * service returns the whole library and there is no `limit` to clamp — a customer
         * with forty downloads would otherwise have had all forty narrated at them.
         */
        const chat = windowForChat({
            items: entitlements,
            total: entitlements.length,
            surface: 'digital',
            language,
        });

        /**
         * ⚠ **Filtered BEFORE the chat window, not after**, and the difference is the behaviour: a
         * customer whose five most recent purchases have all expired would otherwise see a picker
         * with nothing in it while a downloadable sixth sat just out of view. The DATA response
         * keeps the window over everything, because the model narrates the library — including why
         * an expired row cannot be fetched. That is the split this surface makes everywhere: the
         * buttons offer only what will work, and the model explains the rest.
         */
        const downloadable = entitlements.filter((entitlement) => entitlement.canDownload);
        const options = downloadOptions(downloadable.slice(0, BOT_CHAT_LIST_MAX));

        if (options.length > 0) {
            setBotReply(req, {
                kind: 'choice',
                text: botChrome('downloadsPrompt', language),
                options,
                listButton: botChrome('chooseListButton', language),
                sectionTitle: botChrome('chooseSectionTitle', language),
            });
        } else if (entitlements.length === 0) {
            setBotReply(req, { kind: 'text', text: botChrome('noDownloadsPrompt', language) });
        } else {
            /**
             * ⚠ **Owned, but nothing is fetchable — and this deliberately sets NO reply.** The
             * reason differs per row (revoked, expired, allowance used up) and each row carries its
             * own, so the model has what it needs to say the true thing about the right item. One
             * generic sentence here would talk over it with something less accurate.
             */
            setBotReply(req, null);
        }

        sendSuccess(res, chat.items, { meta: { ...chat.window } });
    });

    /**
     * `POST /digital/download-links` — mint a single-use, 15-minute download link.
     *
     * ⚠ **The URL carries its own authority: anyone holding it can download the file.**
     * That is true of the customer API too, and it is exactly why the route is `flow_only`
     * in the catalogue — the model is never handed it as a tool to reach for, and a flow
     * that mints one is a flow that decided to put a bearer URL into a chat.
     *
     * The allowance moves on EXECUTE rather than on creation, so an unused link costs the
     * customer nothing. That is what makes a retry here cheap even though the route is
     * classified as mutating.
     */
    static createDownloadLink = asyncHandler(async (req: Request, res: Response) => {
        const { entitlementId } = BotEntitlementSchema.parse(req.body ?? {});
        const result = await downloadLinkService.createDownloadLink({
            entitlementId,
            customerId: botCallerOf(req).customerId,
        });
        sendSuccess(res, result, { status: 201 });
    });
}

/** Only the fields a picker row is built from. Wider than this is the service's shape, not a row's. */
interface DownloadableRow {
    id: string;
    productTitle?: string | null;
    variantName?: string | null;
    originalName?: string | null;
}

/**
 * One picker row per purchased file.
 *
 * ── ⛔ WHY THE TITLE IS NOT THE PRODUCT NAME ────────────────────────────────
 * A WhatsApp list row title is cut at **24 characters**, mid-word, and two modules of one course
 * then render identically:
 *
 *     "Cours de couture profes…"
 *     "Cours de couture profes…"
 *
 * A customer picking at random between two files they have PAID for. This survived the entire build
 * because in English the same two rows read "Sewing course — part 1" and "part 2" and fit inside
 * twenty-four characters.
 *
 * So the title carries what DISTINGUISHES one purchase from another — the variant, then the file's
 * own name — and the product's full name goes in the description, where a row has 72 characters.
 * It is the shape the order picker already uses: the order number titles the row, the state and the
 * money go underneath.
 *
 * ⚠ **The rule this belongs to, binding for anything that builds a row title from DATA: it needs a
 * `shortLabel`, and its test case must be French or Arabic, never English.**
 *
 * Exported so `test:inapp-discovery` can drive it through the real renderer rather than assert on a
 * copy of it.
 */
export function downloadOptions(rows: readonly DownloadableRow[]): BotReplyOption[] {
    /**
     * ⚠ **The fallback chain ends at the product's name, and two rows can still land on it** — the
     * same purchase twice with no variant and no file name, which happens when an asset row has
     * gone and the populate came back empty. That is the original defect all over again, so the
     * last resort counts the repeats and numbers them. It invents no data: "(2)" says only that
     * this is the second row the platform cannot tell apart, which is the truth the customer needs
     * in order to pick deliberately rather than at random.
     */
    const seen = new Map<string, number>();

    return rows.map((row) => {
        const title = row.productTitle || row.originalName || '—';
        const distinguishing = row.variantName || row.originalName || title;

        const cut = [...distinguishing].slice(0, WA_ROW_TITLE_CAP).join('');
        const repeat = (seen.get(cut) ?? 0) + 1;
        seen.set(cut, repeat);

        return {
            id: downloadActionId(row.id),
            /** Telegram has room for the whole thing. */
            label: row.variantName ? `${title} — ${row.variantName}` : title,
            /**
             * ⚠ **The number is made to FIT, not appended and hoped for.** A suffix on a title that
             * is already at the cap is cut straight back off by the renderer — which would leave
             * the numbering doing nothing in precisely the case it exists for, the long identical
             * names.
             */
            shortLabel: repeat === 1 ? distinguishing : numbered(distinguishing, repeat),
            description: title,
        };
    });
}

/** WhatsApp's list-row title cap — see `distinguishingPart` in the discovery controller. */
const WA_ROW_TITLE_CAP = 24;

/**
 * `<name> (2)`, shortened so the number survives the channel's cut.
 *
 * Code points, not `slice`: the names this is for are the ones with accents and Arabic in them.
 */
function numbered(value: string, repeat: number): string {
    const suffix = ` (${repeat})`;
    const room = WA_ROW_TITLE_CAP - suffix.length;
    const head = [...value].slice(0, room).join('').trimEnd();
    return `${head}${suffix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The download tap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `dl:<entitlementId>` — mint a download link and hand it over as a BUTTON.
 *
 * ── ⛔ WHY THE LINK IS NEVER IN THE MESSAGE TEXT ─────────────────────────────
 * The URL is a bearer credential: whoever holds it gets the file. It is **single-use** — the
 * token is read-and-deleted atomically on the first GET, by whoever makes that GET — and it lives
 * fifteen minutes. Telegram and WhatsApp both PRE-FETCH URLs that appear in message text, to build
 * a link preview, so a pasted link is spent by a robot before the customer's thumb arrives: they
 * tap a dead link and the access log records a successful download. A link BUTTON is not
 * pre-fetched. So this answers with a `link` intent — an inline URL button on Telegram, `cta_url`
 * on WhatsApp — and the sentence beside it contains no URL at all.
 *
 * ⚠ **THE LIMIT OF THAT CLAIM, stated because the next person deserves both halves.** The
 * pre-fetch failure is reasoned from two things we know — the token is read-and-deleted atomically
 * on the first GET (`DownloadTokenHelper`), and both platforms document fetching URLs in message
 * text to build previews — and **nobody here has watched a crawler spend a token**. The design is
 * safe whether or not it happens, because a button is not pre-fetched and the URL now reaches
 * neither the message text nor the JSON body. But if you are weighing whether this button is worth
 * its complexity, weigh it knowing the failure was predicted rather than observed.
 *
 * ── ⚠ MINTED ON THE TAP, NEVER WHEN THE LIBRARY IS DRAWN ────────────────────
 * The picker's tokens name ENTITLEMENTS, not links, for the same reason `open:co` carries no
 * checkout handle: a link minted at listing time is dead for almost everyone who ever taps it. It
 * also costs nothing to re-mint — the allowance moves when the file is actually fetched, not when
 * the link is made — so a customer coming back to the chat tomorrow taps the same row and gets a
 * fresh link for free.
 *
 * ── ⚠ FIFTEEN MINUTES IS NOT A NUMBER TO "FIX" ──────────────────────────────
 * It looks short, and minting on the tap is what makes it right: a longer life would buy nothing
 * except a longer window in which a public URL is valid. The sentence states it in words, and
 * `test:inapp-discovery` pins the service's TTL against that sentence so the two cannot drift.
 *
 * ── ⚠ BUILT BESIDE A RESTRICTION, NOT AROUND IT ─────────────────────────────
 * `digital_create_download_link` is tier `flow_only` in the tool catalogue and STAYS that way: the
 * model is never handed a tool that mints a bearer URL, because a model holding one is a model
 * that can put it in a sentence. This handler calls `DownloadLinkService` directly, from a tap the
 * server itself minted — the path that restriction was always leaving room for.
 */
async function handleDownloadTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    /** Refused as a TOKEN, not as a schema failure — a malformed tap is not something typed. */
    if (!/^[0-9a-fA-F]{24}$/.test(action.argument)) throw unknownBotAction();

    /**
     * ⚠ **The origin is checked BEFORE minting.** A link this deployment cannot present is a live
     * credential nobody can use, and it would make "how many download tokens are outstanding" a
     * number that means nothing — the reasoning `mintCheckoutUrl` applies to checkout handles.
     */
    const origin = downloadOrigin();
    if (!origin) {
        setBotReply(req, { kind: 'text', text: botChrome('downloadUnavailablePrompt', language) });
        sendSuccess(res, { minted: false });
        return;
    }

    /**
     * Ownership, revocation, expiry and the allowance are all checked inside the service, which
     * raises the four `DIGITAL_*` refusals by name. They are thrown rather than caught: each has
     * its own customer sentence now, so "you have used all the downloads for that item" reaches the
     * customer instead of the authorization fallback — "you do not have access to that" — about a
     * file they own.
     */
    const link = await downloadLinkService.createDownloadLink({
        entitlementId: action.argument,
        customerId: caller.customerId,
    });

    setBotReply(req, {
        kind: 'link',
        text: botChrome('downloadReadyPrompt', language),
        label: botChrome('downloadButton', language),
        url: origin + link.url,
    });

    /**
     * ⚠ **The URL is not in the JSON either.** The body says a link was minted and how many
     * downloads remain; the address itself travels only inside `reply`, which the automation layer
     * relays to the channel without reading. A model that could see the URL is a model that could
     * repeat it in a sentence, which is the one thing this design is arranged to prevent.
     */
    sendSuccess(res, {
        minted: true,
        expiresAt: link.expiresAt,
        downloadsRemaining: link.downloadsRemaining,
    });
}

/**
 * The public origin a customer's phone can actually open, or null.
 *
 * ⚠ **HTTPS only, and the refusal is not pedantry.** Telegram rejects an inline URL button on any
 * other scheme and drops the WHOLE message with it, so an `http://` link produces silence rather
 * than a working-looking button; WhatsApp's `cta_url` requires HTTPS too. A local deployment
 * therefore refuses honestly instead of sending a message that vanishes.
 *
 * ⚠ Read as a spelled-out property access, never through a helper taking the name as an argument —
 * `test:env` re-derives the environment contract by scanning source and cannot see the other shape.
 */
function downloadOrigin(): string | null {
    const configured = (process.env.API_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
    if (!configured) return null;
    try {
        return new URL(configured).protocol === 'https:' ? configured : null;
    } catch {
        return null;
    }
}

/**
 * The verb this controller answers, for the dispatcher's registry.
 *
 * One key, and it is the only tap this stream's digital half needs: the library itself is drawn by
 * a tool the model calls, and every other row state is narrated rather than offered.
 */
export const DIGITAL_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    dl: handleDownloadTap,
});
