import mongoose, { Document, Schema } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

export interface ITelegramLink extends Document {
    userId: mongoose.Types.ObjectId;
    chatId: string;
    telegramUserId: number;
    firstName: string;
    lastName?: string;
    username?: string;
    isActive: boolean;
    connectedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const TelegramLinkSchema = new Schema<ITelegramLink>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.USER,
            required: true,
            unique: true,
            index: true,
        },
        chatId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        telegramUserId: {
            type: Number,
            required: true,
            unique: true,
            index: true,
        },
        firstName: {
            type: String,
            required: true,
        },
        lastName: {
            type: String,
        },
        username: {
            type: String,
        },
        isActive: {
            type: Boolean,
            required: true,
            default: true,
        },
        connectedAt: {
            type: Date,
            required: true,
            default: () => new Date(),
        },
    },
    {
        timestamps: true,
    }
);

export const TelegramLink = mongoose.model<ITelegramLink>(MODELS.TELEGRAM_LINK, TelegramLinkSchema, COLLECTIONS.TELEGRAM_LINK);
