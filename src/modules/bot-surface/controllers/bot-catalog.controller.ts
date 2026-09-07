import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { wishlistService } from '../../customers/services/wishlist.service';
import { recentlyViewedService } from '../../customers/services/recently-viewed.service';
import { DigitalEntitlementService } from '../../digital-delivery/services/digital-entitlement.service';
import { DownloadLinkService } from '../../digital-delivery/services/download-link.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { windowForChat } from '../domain/bot-list-window';
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

    /** `POST /digital/my-products` — the purchased library, with each entitlement's state. */
    static listEntitlements = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
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
            language: botResponseLanguageOf(req),
        });

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
