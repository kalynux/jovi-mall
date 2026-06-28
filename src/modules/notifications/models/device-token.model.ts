import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Device Platforms
 *
 * The client platform that registered the FCM token.
 */
export type DevicePlatform = 'web' | 'android' | 'ios';

/**
 * Device Token
 *
 * An FCM registration token belonging to a user's device. Keyed by userId so
 * any authenticated user (vendor today, customers/agents later) can receive
 * push. The token itself is globally unique — a single device produces one
 * token, which can move between users (e.g. shared device), so registration
 * upserts on `token`.
 */
export interface IDeviceToken extends Document {
    userId: mongoose.Types.ObjectId;
    token: string;
    platform: DevicePlatform;
    userAgent?: string;
    lastUsedAt: Date;
    createdAt: Date;
}

const DeviceTokenSchema = new Schema<IDeviceToken>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: MODELS.USER,
            required: true,
            index: true
        },
        token: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        platform: {
            type: String,
            enum: ['web', 'android', 'ios'],
            required: true
        },
        userAgent: {
            type: String,
            trim: true,
            maxlength: 512
        },
        lastUsedAt: {
            type: Date,
            default: Date.now,
            required: true
        }
    },
    {
        timestamps: { createdAt: true, updatedAt: false }
        // Physical collection name is set centrally via COLLECTIONS (3rd model() arg).
    }
);

export const DeviceTokenModel =
    (mongoose.models.DeviceToken as mongoose.Model<IDeviceToken>) ||
    mongoose.model<IDeviceToken>(MODELS.DEVICE_TOKEN, DeviceTokenSchema, COLLECTIONS.DEVICE_TOKEN);
