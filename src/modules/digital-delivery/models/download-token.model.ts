import * as crypto from 'crypto';
import { getRedisClient, DOWNLOAD_TOKEN_DB } from '../../../infra/redis/redis.factory';

/**
 * Download Token Helper - Redis-based token management
 * 
 * Tokens are stored in Redis DB 8 with automatic TTL-based expiration.
 * Single-use enforcement via an atomic read-and-delete.
 * 
 * CRITICAL GUARANTEES:
 * - Tokens auto-expire in 15 minutes via Redis TTL
 * - Consumption is atomic - only one concurrent request can consume a token
 * - High entropy (32 bytes = 64 hex chars) prevents guessing
 */

/**
 * Read-and-delete, atomically, on any Redis from 2.6 onwards.
 *
 * `GETDEL` says this in one word and was what this file used to call — but it landed in
 * **Redis 6.2**, and this platform's own development Redis is 3.0, where it is an unknown
 * command. That was not a hypothetical portability worry: `ERR unknown command 'GETDEL'`
 * came back from every single `GET /api/digital/download/:token`, so no customer in this
 * environment could ever download a purchased file. The token was minted, the link was
 * handed out, and the redemption 500ed.
 *
 * A Lua script is the portable form of the same guarantee — Redis runs one atomically, so
 * nothing can observe or spend the key between the GET and the DEL. It is one round trip,
 * exactly as `GETDEL` is. This is the shape `ConnectionCodeStore`, `GeoCandidateStore`,
 * `LoginSessionStore` and `core/jobs/worker-lock.ts` already use; this file was the last
 * holdout.
 *
 * What must NOT be done is a `get` followed by a `del`: two concurrent redemptions both see
 * a live token and both stream the file, which defeats the single-use property the download
 * counter depends on.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

export interface DownloadTokenData {
  entitlementId: string;
  createdAt: number; // timestamp
}

export class DownloadTokenHelper {
  private static readonly TOKEN_TTL_SECONDS = 900; // 15 minutes
  private static readonly TOKEN_BYTES = 32; // 64 hex chars

  /**
   * Generate a new download token and store in Redis
   * @param entitlementId - ID of the entitlement this token grants access to
   * @returns The generated token string
   */
  static async createToken(entitlementId: string): Promise<string> {
    // Generate high-entropy token
    const token = crypto.randomBytes(this.TOKEN_BYTES).toString('hex');
    
    const redis = await getRedisClient(DOWNLOAD_TOKEN_DB);
    
    const tokenData: DownloadTokenData = {
      entitlementId,
      createdAt: Date.now(),
    };
    
    // Store with automatic expiration (15 minutes)
    await redis.setEx(
      `download_token:${token}`,
      this.TOKEN_TTL_SECONDS,
      JSON.stringify(tokenData)
    );
    
    return token;
  }

  /**
   * Consume a download token (atomic single-use)
   *
   * See `CONSUME_SCRIPT` for why this is a Lua script and not `GETDEL`, and why it
   * must never become a `get` then a `del`.
   *
   * @param token - The token string to consume
   * @returns Token data if valid, null if invalid/expired/already used
   */
  static async consumeToken(token: string): Promise<DownloadTokenData | null> {
    const redis = await getRedisClient(DOWNLOAD_TOKEN_DB);

    // Atomic within Redis - only ONE concurrent request gets the value
    const value = (await redis.eval(CONSUME_SCRIPT, {
      keys: [`download_token:${token}`],
    })) as string | null;

    if (!value) {
      return null; // Token invalid, expired, or already used
    }
    
    try {
      return JSON.parse(value) as DownloadTokenData;
    } catch (error) {
      // Invalid JSON - corrupted token data
      return null;
    }
  }

  /**
   * Check if a token exists without consuming it (for debugging)
   * @param token - The token string to check
   * @returns true if token exists, false otherwise
   */
  static async exists(token: string): Promise<boolean> {
    const redis = await getRedisClient(DOWNLOAD_TOKEN_DB);
    const exists = await redis.exists(`download_token:${token}`);
    return exists === 1;
  }

  /**
   * Get TTL of a token without consuming it (for debugging)
   * @param token - The token string to check
   * @returns TTL in seconds, -2 if not found, -1 if no expiry
   */
  static async getTTL(token: string): Promise<number> {
    const redis = await getRedisClient(DOWNLOAD_TOKEN_DB);
    return await redis.ttl(`download_token:${token}`);
  }
}
