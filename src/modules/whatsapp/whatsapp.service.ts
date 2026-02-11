import { getRedisClient, WA_WINDOW_DB } from '../../infra/redis/redis.factory';

const WINDOW_TTL = 86400; // 24 hours

export class WhatsappService {
  /**
   * Record inbound traffic and open/refresh the 24h chat window.
   * @param waPhoneId The WhatsApp Phone ID (user's phone number as ID from WA)
   * @param userId Optional User ID if known
   */
  async recordInbound(waPhoneId: string, userId?: string): Promise<void> {
    const redis = await getRedisClient(WA_WINDOW_DB);
    const key = `open_chat_window:${waPhoneId}`;
    const value = userId || waPhoneId; // Fallback to storing phone ID if user unknown
    
    await redis.set(key, value, { EX: WINDOW_TTL });
  }

  /**
   * Check if we can send a free message (within 24h window).
   * @param waPhoneId The WhatsApp Phone ID
   */
  async canSendFreeMessage(waPhoneId: string): Promise<boolean> {
    const redis = await getRedisClient(WA_WINDOW_DB);
    const key = `open_chat_window:${waPhoneId}`;
    const exists = await redis.exists(key);
    return exists === 1;
  }
}
