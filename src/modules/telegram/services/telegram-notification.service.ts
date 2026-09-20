import { connectionService } from '../../channel-connections';
import { TelegramBotService, TelegramParseMode } from './telegram-bot.service';

export interface SendNotificationParams {
    userId?: string;
    chatId?: string;
    /**
     * The message body. When `parseMode` is `'HTML'` this must already be
     * escaped — use `escapeTelegramHtml` from `core/richtext` on every
     * interpolated value, not just the ones that look risky.
     */
    message: string;
    /** Optional inline URL button rendered under the message. */
    button?: { label: string; url: string };
    /**
     * Optional chat quick replies, rendered in the SAME row as `button`, after it
     * (phase 10, stage 1). A tap comes back as a `callback_query` carrying `token`.
     *
     * ⚠ **Unlike WhatsApp, Telegram keeps the URL button AND these together** — an
     * inline keyboard row mixes both kinds freely. So a Telegram customer loses
     * nothing to gain a quick reply, and the WhatsApp `viewLine` compensation is
     * deliberately NOT applied here.
     *
     * ⚠ Each `token` must be ≤ 64 BYTES: over it Telegram rejects the whole
     * message, not just the button.
     */
    quickReplies?: Array<{ token: string; label: string }>;
    /** Defaults to `'none'` — see `TelegramParseMode`. */
    parseMode?: TelegramParseMode;
}

export interface SendNotificationResult {
    success: boolean;
    chatId?: string;
    error?: string;
}

export class TelegramNotificationService {
    private botService: TelegramBotService;

    constructor() {
        this.botService = new TelegramBotService();
    }

    /**
     * Send a notification to a Telegram user
     * @param params Notification parameters (userId or chatId + message)
     * @returns Success status and chat ID
     */
    async send(params: SendNotificationParams): Promise<SendNotificationResult> {
        let chatId = params.chatId;

        /**
         * Resolve the chat from the account's Telegram connection.
         *
         * ⚠ There is deliberately NO second "is it active?" check here any more.
         * The old `telegram_links.isActive` flag was a mute switch living beside
         * the notification preferences' own `telegramEnabled`, so a connected
         * account that had muted itself reported as *not connected* — and the
         * settings UI then offered "Connect" to somebody already connected.
         * Muting is the preference's job; this resolves an address.
         */
        if (!chatId && params.userId) {
            const connection = await connectionService.getConnection(params.userId, 'telegram');

            if (!connection) {
                console.log(`[TelegramNotification] No Telegram connection for user ${params.userId}`);
                return {
                    success: false,
                    error: 'No Telegram account connected',
                };
            }

            chatId = connection.external_id;
        }

        if (!chatId) {
            return {
                success: false,
                error: 'Chat ID could not be determined',
            };
        }

        /**
         * One row: the URL button first, then any quick replies.
         *
         * ⚠ **`buttons` is passed ONLY when there is a quick reply.** With none, the call
         * goes through the original `button` path untouched, so every pre-phase-10 caller
         * produces the exact keyboard it always did.
         */
        const quickReplies = params.quickReplies ?? [];
        const urlButton = params.button ? { text: params.button.label, url: params.button.url } : undefined;
        const sent = await this.botService.sendMessage(chatId, params.message, {
            button: urlButton,
            ...(quickReplies.length > 0 && {
                buttons: [
                    ...(urlButton ? [urlButton] : []),
                    ...quickReplies.map(q => ({ text: q.label, callbackData: q.token })),
                ],
            }),
            parseMode: params.parseMode,
        });

        if (sent) {
            console.log(`[TelegramNotification] Notification sent to chat ${chatId}`);
            return {
                success: true,
                chatId,
            };
        } else {
            console.error(`[TelegramNotification] Failed to send notification to chat ${chatId}`);
            return {
                success: false,
                chatId,
                error: 'Failed to send message via Telegram Bot API',
            };
        }
    }
}
