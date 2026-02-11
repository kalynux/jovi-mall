import { TelegramRepository } from '../telegram.repository';
import { TelegramBotService } from './telegram-bot.service';

export interface SendNotificationParams {
    userId?: string;
    chatId?: string;
    message: string;
}

export interface SendNotificationResult {
    success: boolean;
    chatId?: string;
    error?: string;
}

export class TelegramNotificationService {
    private repository: TelegramRepository;
    private botService: TelegramBotService;

    constructor() {
        this.repository = new TelegramRepository();
        this.botService = new TelegramBotService();
    }

    /**
     * Send a notification to a Telegram user
     * @param params Notification parameters (userId or chatId + message)
     * @returns Success status and chat ID
     */
    async send(params: SendNotificationParams): Promise<SendNotificationResult> {
        let chatId = params.chatId;

        // If chatId not provided, lookup from userId
        if (!chatId && params.userId) {
            const link = await this.repository.findByUserId(params.userId);

            if (!link) {
                console.log(`[TelegramNotification] No Telegram link found for user ${params.userId}`);
                return {
                    success: false,
                    error: 'No Telegram account linked',
                };
            }

            if (!link.isActive) {
                console.log(`[TelegramNotification] Telegram link is not active for user ${params.userId}`);
                return {
                    success: false,
                    error: 'Telegram link is not active',
                };
            }

            chatId = link.chatId;
        }

        if (!chatId) {
            return {
                success: false,
                error: 'Chat ID could not be determined',
            };
        }

        // Send message via bot
        const sent = await this.botService.sendMessage(chatId, params.message);

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
