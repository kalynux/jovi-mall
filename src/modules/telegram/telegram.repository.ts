import { TelegramLink, ITelegramLink } from './telegram.model';
import mongoose from 'mongoose';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

export interface TelegramLinkData {
    chatId: string;
    telegramUserId: number;
    firstName: string;
    lastName?: string;
    username?: string;
}

export class TelegramRepository {
    /**
     * Find Telegram link by user ID
     */
    async findByUserId(userId: string): Promise<ITelegramLink | null> {
        return TelegramLink.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    }

    /**
     * Find Telegram link by chat ID
     */
    async findByChatId(chatId: string): Promise<ITelegramLink | null> {
        return TelegramLink.findOne({ chatId });
    }

    /**
     * Find Telegram link by Telegram user ID
     */
    async findByTelegramUserId(telegramUserId: number): Promise<ITelegramLink | null> {
        return TelegramLink.findOne({ telegramUserId });
    }

    /**
     * Create or update a Telegram link for a user
     * Uses upsert for race-condition safety
     */
    async createOrUpdate(userId: string, data: TelegramLinkData): Promise<ITelegramLink> {
        const link = await TelegramLink.findOneAndUpdate(
            { userId: new mongoose.Types.ObjectId(userId) },
            {
                $set: {
                    chatId: data.chatId,
                    telegramUserId: data.telegramUserId,
                    firstName: data.firstName,
                    lastName: data.lastName,
                    username: data.username,
                    isActive: true,
                    connectedAt: new Date(),
                },
            },
            {
                new: true,
                upsert: true,
            }
        );

        if (!link) {
            throw createAppError(ERROR_CODES.TELEGRAM_LINK_FAILED, 500);
        }

        return link;
    }

    /**
     * Toggle activation state for a user's Telegram link
     */
    async toggleActivation(userId: string): Promise<ITelegramLink> {
        const link = await this.findByUserId(userId);

        if (!link) {
            throw createAppError(ERROR_CODES.TELEGRAM_LINK_NOT_FOUND, 404);
        }

        link.isActive = !link.isActive;
        await link.save();

        return link;
    }

    /**
     * Delete a Telegram link by user ID
     */
    async deleteByUserId(userId: string): Promise<void> {
        await TelegramLink.deleteOne({ userId: new mongoose.Types.ObjectId(userId) });
    }
}
