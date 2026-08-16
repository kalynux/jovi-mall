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

        // Send message via bot (with optional inline URL button)
        const sent = await this.botService.sendMessage(chatId, params.message, {
            button: params.button ? { text: params.button.label, url: params.button.url } : undefined,
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
