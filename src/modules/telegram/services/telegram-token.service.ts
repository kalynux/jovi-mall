import { getRedisClient, TELEGRAM_LINK_TOKEN_DB } from '../../../infra/redis/redis.factory';
import crypto from 'crypto';

const TOKEN_TTL = 600; // 10 minutes in seconds

export class TelegramTokenService {
    /**
     * Generate a secure link token for a user
     * @param userId User ID to link
     * @returns Token and expiration timestamp
     */
    async generateToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
        // Generate URL-safe token with 128-bit entropy (24 bytes → 32 chars base64url)
        const token = crypto.randomBytes(24).toString('base64url');

        const redis = await getRedisClient(TELEGRAM_LINK_TOKEN_DB);
        const key = `tlgt:${token}`;

        // Store token with userId as value, TTL 10 minutes
        await redis.set(key, userId, { EX: TOKEN_TTL });

        const expiresAt = new Date(Date.now() + TOKEN_TTL * 1000);

        console.log(`[TelegramToken] Generated token for user ${userId}, expires at ${expiresAt.toISOString()}`);

        return { token, expiresAt };
    }

    /**
     * Validate a token and return the associated user ID
     * @param token Token to validate
     * @returns User ID if valid, null if expired or invalid
     */
    async validateToken(token: string): Promise<{ userId: string } | null> {
        const redis = await getRedisClient(TELEGRAM_LINK_TOKEN_DB);
        const key = `tlgt:${token}`;

        const userId = await redis.get(key);

        if (!userId) {
            console.log(`[TelegramToken] Token validation failed: not found or expired`);
            return null;
        }

        console.log(`[TelegramToken] Token validated for user ${userId}`);
        return { userId };
    }

    /**
     * Consume a token (validate and delete for single-use)
     * @param token Token to consume
     * @returns User ID if valid, null if expired or invalid
     */
    async consumeToken(token: string): Promise<{ userId: string } | null> {
        const result = await this.validateToken(token);

        if (!result) {
            return null;
        }

        // Delete token immediately (single-use)
        const redis = await getRedisClient(TELEGRAM_LINK_TOKEN_DB);
        const key = `tlgt:${token}`;
        await redis.del(key);

        console.log(`[TelegramToken] Token consumed and deleted for user ${result.userId}`);

        return result;
    }
}
