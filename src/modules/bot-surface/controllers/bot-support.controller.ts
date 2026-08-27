import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { supportContextService } from '../services/support-context.service';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { BotSupportContextSchema } from '../validators/bot.validators';

/**
 * `POST /support/context` — who the customer should be talking to (GAP-004).
 *
 * The first step of the `/support` flow, and the reason it is one call rather than three:
 * composed client-side it was `GET /api/public/stores/:slug`, `GET /api/customer/orders`
 * and `GET /api/customer/orders/:orderId/shipments`, with the ladder that joins them
 * implemented in n8n. Every input already existed; the routing policy did not exist
 * anywhere, which meant it lived in the automation layer — three chances per conversation
 * to route somebody to the wrong seller, and a policy nobody could test.
 *
 * ⚠ **The answer names its own subject, and the flow must relay that.** `resolvedFrom` and
 * `subject.label` are contract fields: *"about your order ORD-2026-000123 from Maison
 * Bella"*. A support contact for the wrong purchase is worse than asking which one.
 *
 * ⚠ **Any contact field may be null**, on either party — `support_phone`, `support_email`
 * and `support_whatsapp` are all optional on a Store and on a Magazin, and plenty of both
 * have published none. Offer the ones that exist and fall through to a ticket; `platform`
 * is present in every scope precisely so that fall-through is always available.
 *
 * See `services/support-context.service.ts` for the ladder, the two refusals and why the
 * delivery company is read from the order's shipments rather than from its items.
 */
export class BotSupportController {
    static context = asyncHandler(async (req: Request, res: Response) => {
        const query = BotSupportContextSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const context = await supportContextService.resolve(caller.customerId, query);

        sendSuccess(res, context);
    });
}
