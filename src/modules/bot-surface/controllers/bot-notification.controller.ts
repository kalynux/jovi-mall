import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { CustomerNotificationService } from '../../notifications/services/customer-notification.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { botStorefrontLink, windowForChat } from '../domain/bot-list-window';
import { toBotNotificationDto } from '../dto/bot-projections';
import {
    BotNoArgsSchema,
    BotNotificationListSchema,
    BotNotificationParamSchema,
    BotNotificationPreferencesSchema,
} from '../validators/bot.validators';

const service = new CustomerNotificationService();

export class BotNotificationController {
    /**
     * `POST /notifications/list` — the customer's own inbox, newest first.
     *
     * ⚠ **Projected, not relayed.** Three fields on the stored document must not reach a
     * model — `idempotencyKey`, `deliveryErrors[]` (raw provider error strings) and
     * `customerId` — so this is one of the few routes here that builds its own shape rather
     * than passing the customer API's through. See `toBotNotificationDto`.
     *
     * `meta.unreadCount` is carried through from the service beside the chat window,
     * because "you have 3 unread" is the sentence a customer actually wants and it is
     * already computed on this call.
     */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const query = BotNotificationListSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);
        const language = botResponseLanguageOf(req);

        const result = await service.listNotifications(
            caller.customerId,
            { page: query.page, limit: query.limit },
            { unreadOnly: query.unreadOnly, aggregateType: query.aggregateType },
        );

        const chat = windowForChat({
            items: result.notifications.map((n) =>
                toBotNotificationDto(n, (path) => botStorefrontLink(path, language))),
            total: result.meta.total,
            offset: (query.page - 1) * query.limit,
            surface: 'notifications',
            language,
        });

        sendSuccess(res, chat.items, {
            meta: { ...result.meta, unreadCount: result.unreadCount, ...chat.window },
        });
    });

    /**
     * `POST /notifications/unread-count` — the badge number alone.
     *
     * Worth its own route rather than reading `meta.unreadCount` off the list: answering
     * "anything new?" should not cost a page of rows, a product hydration and a model
     * narrating five items nobody asked for.
     */
    static unreadCount = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const unreadCount = await service.countUnread(botCallerOf(req).customerId);
        sendSuccess(res, { unreadCount });
    });

    /**
     * `PATCH /notifications/:notificationId/read` — acknowledge one.
     *
     * ⚠ **One-way: there is no mark-UNREAD route anywhere on this platform.** That is why
     * `mark_all_read` is `flow_only` while this one is not — reading a single notification
     * aloud to the customer IS them seeing it, so acknowledging it is honest. Doing that to
     * a whole inbox on the model's initiative is not.
     *
     * A notification belonging to somebody else is a `404`, never a `403`: the repository
     * scopes by `customerId` in the query, so a caller learns nothing about whether the id
     * exists.
     */
    static markRead = asyncHandler(async (req: Request, res: Response) => {
        const { notificationId } = BotNotificationParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const language = botResponseLanguageOf(req);

        const notification = await service.markAsRead(notificationId, botCallerOf(req).customerId);
        sendSuccess(
            res,
            toBotNotificationDto(notification, (path) => botStorefrontLink(path, language)),
        );
    });

    /**
     * `PATCH /notifications/read-all` — acknowledge the whole inbox.
     *
     * ⚠ **`flow_only`, and it is the tier that matters more than the code here.** Nothing
     * can undo it — no mark-unread exists — and the unread flag is how a customer finds
     * what they have not seen. A model tidying up on its own reading of "yeah I know about
     * those" would silently hide everything the platform had tried to tell them.
     *
     * Answers how many rows actually moved, so a flow can say "cleared 4" rather than
     * asserting something it did not measure.
     */
    static markAllRead = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const updated = await service.markAllAsRead(botCallerOf(req).customerId);
        sendSuccess(res, { updated }, { message: 'All notifications marked as read' });
    });

    /**
     * `POST /notifications/preferences` — where notifications go, and which are on.
     *
     * Verification status is computed live rather than read from the stored flags, which
     * is what makes the answer honest: a customer whose Telegram connection was revoked
     * sees `telegramVerified: false` immediately, rather than a preference pointing at a
     * channel that no longer reaches them.
     */
    static get = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const prefs = await service.getPreferences(botCallerOf(req).customerId);
        sendSuccess(res, prefs);
    });

    /**
     * `PATCH /notifications/preferences` — change them.
     *
     * ── ONE `channel`, NOT THREE BOOLEANS ───────────────────────────────────
     * The customer API takes `emailEnabled` / `telegramEnabled` / `whatsappEnabled`
     * independently because a settings screen renders three switches, and the service then
     * auto-disables the others. A chat cannot render three switches, and a caller sending
     * two `true`s would be relying on which one the service happens to keep. `channel` says
     * the only thing that is actually true — at most one secondary channel — and translates
     * to the service's shape here, in one place.
     *
     * `none` clears all three, which the boolean form can only express as three falses and
     * which no chat would phrase that way.
     *
     * ⚠ An unverified channel is refused with `400
     * CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED` rather than silently accepted. That
     * refusal is the useful one in a chat: the remedy is `/connect`, and a preference that
     * quietly failed to apply would leave the customer waiting for messages that never come.
     *
     * ⚠ **Money and cancellation notifications are absent from this schema and must stay
     * absent.** `SITUATION_PREFERENCE` carries no key for them, so nothing silences them: a
     * customer is the counterparty to somebody else's action there, not the owner of a
     * dashboard. Only progress reporting is gated.
     */
    static update = asyncHandler(async (req: Request, res: Response) => {
        const input = BotNotificationPreferencesSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const preferences: Record<string, boolean> = {};
        if (input.orderUpdates !== undefined) preferences.orderUpdates = input.orderUpdates;
        if (input.bookingUpdates !== undefined) preferences.bookingUpdates = input.bookingUpdates;
        if (input.bookingReminders !== undefined) preferences.bookingReminders = input.bookingReminders;
        if (input.marketing !== undefined) preferences.marketing = input.marketing;

        const prefs = await service.updatePreferences(caller.customerId, {
            // All three are sent together whenever `channel` is present, so the chosen one
            // is enabled and the other two are explicitly disabled in the same call. Sending
            // only the `true` and relying on the service's auto-disable would work today and
            // would break silently the day that behaviour is revisited — and "at most one"
            // is a property this surface asserts rather than inherits.
            ...(input.channel === undefined ? {} : {
                emailEnabled: input.channel === 'email',
                telegramEnabled: input.channel === 'telegram',
                whatsappEnabled: input.channel === 'whatsapp',
            }),
            ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
        });

        sendSuccess(res, prefs, { message: 'Notification preferences updated' });
    });
}
