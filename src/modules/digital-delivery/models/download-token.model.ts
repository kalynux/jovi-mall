import * as crypto from 'crypto';
import { getRedisClient, DOWNLOAD_TOKEN_DB } from '../../../infra/redis/redis.factory';

/**
 * Download Token Helper - Redis-based token management
 * 
 * Tokens are stored in Redis DB 8 with automatic TTL-based expiration.
 * Single-use enforcement via atomic GETDEL command.
 * 
 * CRITICAL GUARANTEES:
 * - Tokens auto-expire in 15 minutes via Redis TTL
 * -GETDEL is atomic - only one concurrent request can consume a token
 * - High entropy (32 bytes = 64 hex chars) prevents guessing
 */

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
   * Uses Redis GETDEL which is atomic - only one concurrent request
   * will successfully retrieve the token value.
   * 
   * @param token - The token string to consume
   * @returns Token data if valid, null if invalid/expired/already used
   */
  static async consumeToken(token: string): Promise<DownloadTokenData | null> {
    const redis = await getRedisClient(DOWNLOAD_TOKEN_DB);
    
    // GETDEL is atomic - only ONE concurrent request gets the value
    const value = await redis.getDel(`download_token:${token}`);
    
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
