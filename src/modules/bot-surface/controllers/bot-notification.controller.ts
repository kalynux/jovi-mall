import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { CustomerNotificationService } from '../../notifications/services/customer-notification.service';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { botStorefrontLink, windowForChat } from '../domain/bot-list-window';
import { toBotNotificationDto } from '../dto/bot-projections';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { accountActionId } from '../domain/bot-action-id';
import { unknownBotAction } from '../domain/bot-action-dispatch';
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

// ─────────────────────────────────────────────────────────────────────────────
// `acct:inbox` and `acct:ntf` — the inbox, and the settings as a chat list
// ─────────────────────────────────────────────────────────────────────────────

/** How many the inbox row shows. The owner's number, and inside every channel's row cap. */
const INBOX_ROWS = 5;

/**
 * `acct:inbox` — the five most recent · `acct:inbox:read` — mark them all read.
 *
 * ⚠ **This reply RENDERS the notifications rather than handing them to the model, and that is
 * a consequence of it carrying a button.** A reply stands alone — the automation layer
 * suppresses the model's own sentence when one is set — so a reply that said only "here are
 * your notifications" and offered Mark all read would show the customer a button and none of
 * the notifications it refers to. Either the model narrates and there is no button, or this
 * renders and there is. The button is worth more than the prose.
 *
 * ⚠ **The unread marker is a bullet, not a word.** "unread" in five languages is two more copy
 * keys for something a dot says better and shorter, inside a row title capped at 24.
 */
export async function inboxSection(req: Request, res: Response, rest: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    if (rest === 'read') {
        const updated = await service.markAllAsRead(caller.customerId);
        setBotReply(req, { kind: 'text', text: botChrome('allMarkedRead', language) });
        sendSuccess(res, { updated });
        return;
    }
    if (rest !== '') throw unknownBotAction();

    const result = await service.listNotifications(
        caller.customerId,
        { page: 1, limit: INBOX_ROWS },
        {},
    );

    const rows = result.notifications.map((n) =>
        toBotNotificationDto(n, (path) => botStorefrontLink(path, language)));

    /**
     * Nothing at all: no reply, so the model says "nothing new" in the customer's own words.
     * The same rule as an empty address book — there is no control to draw over an empty list.
     */
    if (rows.length === 0) {
        sendSuccess(res, rows, { meta: { unreadCount: result.unreadCount } });
        return;
    }

    const lines = rows.map((n) => `${n.isRead ? '◦' : '•'} ${n.title}`);

    setBotReply(req, {
        kind: 'text',
        text: `${botChrome('inboxPrompt', language)}\n\n${lines.join('\n')}`,
        ...(result.unreadCount > 0
            ? {
                  actions: [{
                      id: accountActionId('inbox', 'read'),
                      label: botChrome('markAllReadButton', language),
                  }],
              }
            : {}),
    });
    sendSuccess(res, rows, { meta: { unreadCount: result.unreadCount } });
}

/**
 * The four switches, in the order they are drawn. The keys are the real preference names,
 * read from `BotNotificationPreferencesSchema` rather than invented.
 */
const NOTIFY_SWITCHES = Object.freeze([
    { key: 'orderUpdates', copy: 'notifyRowOrderUpdates' },
    { key: 'bookingUpdates', copy: 'notifyRowBookingUpdates' },
    { key: 'bookingReminders', copy: 'notifyRowBookingReminders' },
    { key: 'marketing', copy: 'notifyRowMarketing' },
] as const);

const NOTIFY_CHANNELS = Object.freeze(['email', 'telegram', 'whatsapp', 'none'] as const);
type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** Which secondary channel is on, as one value. At most one ever is. */
function currentChannel(prefs: {
    emailEnabled: boolean; telegramEnabled: boolean; whatsappEnabled: boolean;
}): NotifyChannel {
    if (prefs.emailEnabled) return 'email';
    if (prefs.telegramEnabled) return 'telegram';
    if (prefs.whatsappEnabled) return 'whatsapp';
    return 'none';
}

/**
 * The settings, as one list: where to send, then the four switches.
 *
 * ⚠ **Each switch row carries the OPPOSITE of its current state, never a toggle.** A toggle
 * token flips whatever the state happens to be when the button is finally pressed, and a chat
 * keeps its buttons for ever — so a row tapped twice, or tapped after the setting was changed
 * on the website, lands somewhere nobody chose. A target state is idempotent: pressing an old
 * "turn off" again turns it off again. It is the stale-Skip defect in another costume.
 *
 * ⚠ **State shows as ✓ / ✗ rather than a word**, which is why the five row copy keys are
 * capped at 22 and not 24: the marker has to fit inside a WhatsApp row title, and a truncated
 * marker would make every switch read as ON.
 */
function setNotifySettingsReply(
    req: Request,
    language: string | null,
    prefs: {
        emailEnabled: boolean; telegramEnabled: boolean; whatsappEnabled: boolean;
        preferences: Record<string, boolean>;
    },
    justChanged: boolean,
): void {
    const rows = [
        {
            id: accountActionId('ntf', 'ch'),
            label: botChrome('notifyRowChannel', language),
        },
        ...NOTIFY_SWITCHES.map((sw) => {
            const on = prefs.preferences?.[sw.key] === true;
            return {
                id: accountActionId('ntf', sw.key, on ? 'off' : 'on'),
                label: `${botChrome(sw.copy, language)} ${on ? '✓' : '✗'}`,
            };
        }),
    ];

    setBotReply(req, {
        kind: 'choice',
        text: botChrome(justChanged ? 'notifyUpdated' : 'notifySettingsPrompt', language),
        options: rows,
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });
}

/** The channel chooser — four options, the current one marked. */
function setChannelChoiceReply(req: Request, language: string | null, current: NotifyChannel): void {
    const label = (channel: NotifyChannel): string => {
        if (channel === 'email') return botChrome('notifyChannelEmail', language);
        if (channel === 'none') return botChrome('notifyChannelNone', language);
        // Brand names, identical in all five languages — the rule the language endonyms follow.
        return channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    };

    setBotReply(req, {
        kind: 'choice',
        text: botChrome('notifyChannelPrompt', language),
        options: NOTIFY_CHANNELS.map((channel) => ({
            id: accountActionId('ntf', 'ch', channel),
            label: channel === current ? `${label(channel)} ✓` : label(channel),
            shortLabel: label(channel),
        })),
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });
}

/**
 * `acct:ntf` · `acct:ntf:ch` · `acct:ntf:ch:<channel>` · `acct:ntf:<key>:<on|off>`.
 *
 * ⚠ **An unverified channel is REFUSED by the service** (`CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED`)
 * and that refusal is left to surface rather than pre-empted here. Its customer copy names the
 * remedy — connect that channel — which is more use than a row this surface quietly declined
 * to draw.
 */
export async function notifySection(req: Request, res: Response, rest: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);

    if (rest === '') {
        const prefs = await service.getPreferences(caller.customerId);
        setNotifySettingsReply(req, language, prefs, false);
        sendSuccess(res, prefs);
        return;
    }

    if (rest === 'ch') {
        const prefs = await service.getPreferences(caller.customerId);
        setChannelChoiceReply(req, language, currentChannel(prefs));
        sendSuccess(res, { channel: currentChannel(prefs) });
        return;
    }

    if (rest.startsWith('ch:')) {
        const channel = rest.slice(3);
        if (!(NOTIFY_CHANNELS as readonly string[]).includes(channel)) throw unknownBotAction();

        const prefs = await service.updatePreferences(caller.customerId, {
            emailEnabled: channel === 'email',
            telegramEnabled: channel === 'telegram',
            whatsappEnabled: channel === 'whatsapp',
        });

        setNotifySettingsReply(req, language, prefs, true);
        sendSuccess(res, prefs);
        return;
    }

    const colon = rest.indexOf(':');
    const key = colon < 0 ? '' : rest.slice(0, colon);
    const target = colon < 0 ? '' : rest.slice(colon + 1);

    if (!NOTIFY_SWITCHES.some((s) => s.key === key)) throw unknownBotAction();
    if (target !== 'on' && target !== 'off') throw unknownBotAction();

    const prefs = await service.updatePreferences(caller.customerId, {
        preferences: { [key]: target === 'on' },
    });

    setNotifySettingsReply(req, language, prefs, true);
    sendSuccess(res, prefs);
}
