import { getRedisClient, WA_WINDOW_DB } from '../../infra/redis/redis.factory';

// Track the window for 23h rather than the full 24h Meta allows, so we stop
// sending free-form text a safe margin before the real window closes (and fall
// back to a template) instead of risking a rejected out-of-window text send.
const WINDOW_TTL = 82800; // 23 hours

/**
 * One key per person, whichever spelling of the number the caller holds.
 *
 * ⛔ **Two spellings reach this file, and until 2026-09-21 they were two different keys.** The
 * inbound stamp writes the bare digits Meta delivers (`237600123456`). `WhatsAppMessagingService`
 * normalises every recipient to E.164 (`+237600123456`) before its policy check asks. So the
 * window the bot had just opened was read under a key nothing wrote, every free-form send was
 * refused as "outside the 24-hour window", and texting the bot first made a phone code FAIL
 * rather than helping. In-window notifications have no template fallback, so they were dropped.
 *
 * Stripping one leading `+` is the whole normalisation, deliberately. It cannot invent a
 * country code, and every writer already stores bare digits, so no stored key moves.
 */
function windowKey(waPhoneId: string): string {
  return `open_chat_window:${waPhoneId.trim().replace(/^\+/, '')}`;
}

export class WhatsappService {
  /**
   * Record inbound traffic and open/refresh the 24h chat window.
   * @param waPhoneId The WhatsApp Phone ID (user's phone number as ID from WA)
   * @param userId Optional User ID if known
   */
  async recordInbound(waPhoneId: string, userId?: string): Promise<void> {
    const redis = await getRedisClient(WA_WINDOW_DB);
    const key = windowKey(waPhoneId);
    const value = userId || waPhoneId; // Fallback to storing phone ID if user unknown
    
    await redis.set(key, value, { EX: WINDOW_TTL });
  }

  /**
   * Check if we can send a free message (within 24h window).
   * @param waPhoneId The WhatsApp Phone ID
   */
  async canSendFreeMessage(waPhoneId: string): Promise<boolean> {
    const redis = await getRedisClient(WA_WINDOW_DB);
    const key = windowKey(waPhoneId);
    const exists = await redis.exists(key);
    return exists === 1;
  }

  /**
   * The same verdict, plus WHEN it stops being true (GAP-012).
   *
   * `canSendFreeMessage` answers the only question the send path has — may this go now —
   * and that is all it should answer. The automation layer has a different question: it is
   * deciding whether a conversational flow can FINISH here, or has to end with "we will
   * message you", and for that it needs the deadline rather than the boolean.
   *
   * ⚠ **`expiresAt` is OUR window, not Meta's, and it is deliberately earlier.** The key
   * lives 23 hours against Meta's 24, so free-form sends stop a safe margin before the real
   * boundary rather than racing it — see WINDOW_TTL above. A caller must treat this as
   * "after this we send a template", never as "Meta closes at this instant".
   *
   * A missing or non-expiring key answers null, so a caller cannot mistake "no deadline
   * known" for "closes now". `-1` (no TTL) and `-2` (no key) both land there.
   */
  async windowStatus(waPhoneId: string): Promise<{ open: boolean; expiresAt: Date | null }> {
    const redis = await getRedisClient(WA_WINDOW_DB);
    const key = windowKey(waPhoneId);
    const ttl = await redis.ttl(key);
    if (ttl < 0) return { open: false, expiresAt: null };
    return { open: true, expiresAt: new Date(Date.now() + ttl * 1000) };
  }
}
