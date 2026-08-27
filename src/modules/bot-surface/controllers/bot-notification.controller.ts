import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { CustomerNotificationService } from '../../notifications/services/customer-notification.service';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { BotNoArgsSchema, BotNotificationPreferencesSchema } from '../validators/bot.validators';

const service = new CustomerNotificationService();

export class BotNotificationController {
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
