import { TelegramRepository, TelegramLinkData } from '../telegram.repository';
import { TelegramTokenService } from './telegram-token.service';
import { TelegramBotService } from './telegram-bot.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

export interface TelegramUserData {
    chatId: string;
    telegramUserId: number;
    firstName: string;
    lastName?: string;
    username?: string;
}

export interface LinkStatus {
    linked: boolean;
    chatId?: string;
    telegramUserId?: number;
    firstName?: string;
    lastName?: string;
    username?: string;
    isActive?: boolean;
    connectedAt?: Date;
}

export class TelegramLinkService {
    private repository: TelegramRepository;
    private tokenService: TelegramTokenService;
    private botService: TelegramBotService;

    constructor() {
        this.repository = new TelegramRepository();
        this.tokenService = new TelegramTokenService();
        this.botService = new TelegramBotService();
    }

    /**
     * Generate a link token and return deep-link URL
     * @param userId User ID to generate token for
     * @returns Bot URL and expiration timestamp
     */
    async generateLinkToken(userId: string): Promise<{ bot_url: string; expires_at: Date }> {
        const { token, expiresAt } = await this.tokenService.generateToken(userId);

        const botName = process.env.TELEGRAM_BOT_NAME || 'YourBotName';
        const bot_url = `https://t.me/${botName}?start=${token}`;

        console.log(`[TelegramLink] Generated link URL for user ${userId}`);

        return {
            bot_url,
            expires_at: expiresAt,
        };
    }

    /**
     * Handle /start <token> command from Telegram
     * @param token Link token from /start command
     * @param telegramData Telegram user data
     * @returns Success status and message
     */
    async handleStartCommand(
        token: string,
        telegramData: TelegramUserData
    ): Promise<{ success: boolean; message: string }> {
        // Validate and consume token (single-use)
        const result = await this.tokenService.consumeToken(token);

        if (!result) {
            console.log(`[TelegramLink] Invalid or expired token`);
            return {
                success: false,
                message: 'Invalid or expired link token. Please generate a new link from your account.',
            };
        }

        const { userId } = result;

        // Create or update Telegram link
        const linkData: TelegramLinkData = {
            chatId: telegramData.chatId,
            telegramUserId: telegramData.telegramUserId,
            firstName: telegramData.firstName,
            lastName: telegramData.lastName,
            username: telegramData.username,
        };

        await this.repository.createOrUpdate(userId, linkData);

        console.log(`[TelegramLink] Account linked for user ${userId}, chat ${telegramData.chatId}`);

        // Send confirmation message
        await this.botService.sendMessage(
            telegramData.chatId,
            '✅ *Your Telegram account has been successfully linked!*\n\n' +
            'You will now receive notifications from our platform. ' +
            'You can toggle notifications on/off from your account settings.'
        );

        return {
            success: true,
            message: 'Telegram account linked successfully',
        };
    }

    /**
     * Get link status for a user
     * @param userId User ID
     * @returns Link status
     */
    async getStatus(userId: string): Promise<LinkStatus> {
        const link = await this.repository.findByUserId(userId);

        if (!link) {
            return { linked: false };
        }

        return {
            linked: true,
            chatId: link.chatId,
            telegramUserId: link.telegramUserId,
            firstName: link.firstName,
            lastName: link.lastName,
            username: link.username,
            isActive: link.isActive,
            connectedAt: link.connectedAt,
        };
    }

    /**
     * Toggle activation state for a user's Telegram link
     * @param userId User ID
     * @returns Updated activation state
     */
    async toggleActivation(userId: string): Promise<{ is_active: boolean }> {
        const link = await this.repository.toggleActivation(userId);

        console.log(`[TelegramLink] Toggled activation for user ${userId}: ${link.isActive}`);

        return {
            is_active: link.isActive,
        };
    }

    /**
     * Disconnect Telegram account for a user
     * @param userId User ID
     */
    async disconnectAccount(userId: string): Promise<void> {
        const link = await this.repository.findByUserId(userId);

        if (!link) {
            throw createAppError(ERROR_CODES.TELEGRAM_NOT_LINKED, 404);
        }

        // Send warning message before deletion
        await this.botService.sendMessage(
            link.chatId,
            '⚠️ *Your Telegram account will be disconnected from our platform.*\n\n' +
            'You will no longer receive notifications. ' +
            'You can link your account again anytime from your account settings.'
        );

        // Delete the link
        await this.repository.deleteByUserId(userId);

        console.log(`[TelegramLink] Account disconnected for user ${userId}`);
    }
}
