import mongoose from 'mongoose';
import { DeviceTokenModel, IDeviceToken, DevicePlatform } from '../models/device-token.model';

/** Plain device-token object (no Mongoose Document methods). */
export type LeanDeviceToken = {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    token: string;
    platform: DevicePlatform;
    userAgent?: string;
    lastUsedAt: Date;
    createdAt: Date;
};

/**
 * DeviceTokenRepository
 *
 * Persistence for FCM device tokens. Registration upserts on the globally
 * unique token; pruning removes tokens FCM reports as stale/invalid.
 */
export class DeviceTokenRepository {
    /**
     * Register (or refresh) a device token.
     *
     * Upserts on `token` so the same device keeps a single row even if it
     * re-registers or moves to a different user. Refreshes ownership, platform,
     * user agent, and lastUsedAt on every call.
     */
    async upsertToken(
        userId: string | mongoose.Types.ObjectId,
        token: string,
        platform: DevicePlatform,
        meta: { userAgent?: string } = {}
    ): Promise<IDeviceToken> {
        const result = await DeviceTokenModel.findOneAndUpdate(
            { token },
            {
                $set: {
                    userId: new mongoose.Types.ObjectId(userId),
                    platform,
                    userAgent: meta.userAgent,
                    lastUsedAt: new Date()
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return result as IDeviceToken;
    }

    /**
     * Return all tokens registered to a user.
     */
    async findActiveByUser(userId: string | mongoose.Types.ObjectId): Promise<LeanDeviceToken[]> {
        return DeviceTokenModel.find({
            userId: new mongoose.Types.ObjectId(userId)
        }).lean<LeanDeviceToken[]>();
    }

    /**
     * Remove a single token (used on logout / unregister).
     */
    async deleteByToken(token: string): Promise<void> {
        await DeviceTokenModel.deleteOne({ token });
    }

    /**
     * Remove many tokens at once (used to prune tokens FCM rejected as invalid).
     */
    async deleteManyTokens(tokens: string[]): Promise<void> {
        if (tokens.length === 0) return;
        await DeviceTokenModel.deleteMany({ token: { $in: tokens } });
    }
}
