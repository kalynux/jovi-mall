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

export interface InlineUrlButton {
    text: string;
    url: string;
}

/**
 * How Telegram should parse the message body.
 *
 * `'none'` sends no `parse_mode` at all — the text is rendered verbatim and the
 * send can never be rejected for a parse failure. `'HTML'` is the formatted
 * mode, and the caller owns escaping (`escapeTelegramHtml` from `core/richtext`).
 *
 * **Legacy `'Markdown'` is deliberately absent.** It used to be hardcoded here
 * for every send, and it is a trap: any `_`, `*`, `[` or backtick in the body
 * makes the Bot API answer `400 can't parse entities`, `sendMessage` returns
 * `false`, and the boolean is only logged (below) — so the notification is
 * silently dropped. Every message this service sends interpolates user-authored
 * text (product titles, vendor names, order references, and now product
 * descriptions), so that was not a hypothetical.
 *
 * MarkdownV2 is not offered either: it requires escaping eighteen characters —
 * ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` — which commerce prose collides with
 * constantly (`12.500 FCFA`, `(x2)`, every `!`), and one miss drops the whole
 * message rather than degrading its formatting. HTML's escape set is three
 * characters that never appear in prose by accident.
 */
export type TelegramParseMode = 'none' | 'HTML';

export interface SendMessageOptions {
    /** Optional inline URL button rendered under the message. */
    button?: InlineUrlButton;
    /**
     * Defaults to `'none'`, and that default is the point: an unformatted
     * message always arrives, while a malformed formatted one arrives not at
     * all. A caller that wants marks opts in — and by opting in takes on
     * escaping every interpolated value.
     */
    parseMode?: TelegramParseMode;
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
     * @param text Message text (max 4096 chars). When `options.parseMode` is
     *   `'HTML'` this must ALREADY be escaped — see `TelegramParseMode`.
     * @returns True if sent successfully
     */
    async sendMessage(chatId: string, text: string, options: SendMessageOptions = {}): Promise<boolean> {
        const parseMode = options.parseMode ?? 'none';
        try {
            const response = await this.api.post<SendMessageResponse>('sendMessage', {
                chat_id: chatId,
                text,
                // Omitted entirely for 'none' — Telegram treats an absent
                // parse_mode as "render verbatim", which is not the same as
                // passing an empty string.
                ...(parseMode !== 'none' && { parse_mode: parseMode }),
                ...(options.button && {
                    reply_markup: {
                        inline_keyboard: [[{ text: options.button.text, url: options.button.url }]],
                    },
                }),
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
