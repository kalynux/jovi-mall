import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
dotenv.config();

interface BotInfo {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
}

interface SendMessageResponse {
    ok: boolean;
    result?: any;
    description?: string;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export class TelegramBotService {
    private api: AxiosInstance;
    private botToken: string;

    constructor() {
        this.botToken = BOT_TOKEN || '';

        if (!this.botToken) {
            console.warn('[TelegramBot] TELEGRAM_BOT_TOKEN not configured');
        }

        this.api = axios.create({
            baseURL: `https://api.telegram.org/bot${this.botToken}/`,
            timeout: 10000,
        });
    }

    /**
     * Send a text message to a Telegram chat
     * @param chatId Telegram chat ID
     * @param text Message text (max 4096 chars)
     * @returns True if sent successfully
     */
    async sendMessage(chatId: string, text: string): Promise<boolean> {
        try {
            const response = await this.api.post<SendMessageResponse>('sendMessage', {
                chat_id: chatId,
                text,
                parse_mode: 'Markdown',
            });

            if (response.data.ok) {
                console.log(`[TelegramBot] Message sent to chat ${chatId}`);
                return true;
            } else {
                console.error(`[TelegramBot] Failed to send message: ${response.data.description}`);
                return false;
            }
        } catch (error: any) {
            if (error.response?.status === 403) {
                console.error(`[TelegramBot] Bot blocked by user or chat not found: ${chatId}`);
            } else if (error.response?.status === 429) {
                console.error(`[TelegramBot] Rate limit exceeded`);
            } else {
                console.error(`[TelegramBot] Error sending message:`, error.message);
            }
            return false;
        }
    }

    /**
     * Get bot information (health check)
     * @returns Bot info if token is valid
     */
    async getMe(): Promise<BotInfo | null> {
        try {
            const response = await this.api.get<{ ok: boolean; result: BotInfo }>('getMe');

            if (response.data.ok) {
                console.log(`[TelegramBot] Bot info:`, response.data.result);
                return response.data.result;
            }

            return null;
        } catch (error: any) {
            console.error(`[TelegramBot] Error fetching bot info:`, error.message);
            return null;
        }
    }
}
