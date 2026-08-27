import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { wishlistService } from '../../customers/services/wishlist.service';
import { recentlyViewedService } from '../../customers/services/recently-viewed.service';
import { DigitalEntitlementService } from '../../digital-delivery/services/digital-entitlement.service';
import { DownloadLinkService } from '../../digital-delivery/services/download-link.service';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
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
        sendSuccess(res, data, { meta });
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

    /** `POST /digital/my-products` — the purchased library, with each entitlement's state. */
    static listEntitlements = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const entitlements = await entitlementService.getCustomerEntitlements(
            botCallerOf(req).customerId,
        );
        sendSuccess(res, entitlements);
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
