import { MessagingChannel } from './channel';

/**
 * What the frontend is allowed to see of a messaging identity.
 *
 * The raw `external_id` — a WhatsApp phone id, a Telegram chat id — **never
 * leaves this service**. It is a durable identifier for a real person's
 * messaging account: enough to message them, enough to correlate them across
 * systems, and of no use whatsoever to a settings screen, which only needs to
 * answer "is this the right account?".
 *
 * So the DTO layer renders a hint instead. Pure, so `test:connections` can
 * assert the leak property without a database: build a DTO from a document
 * carrying a full identity, serialise it, and check the identity is absent.
 */

/** Trailing digits shown for a phone-shaped identity. */
const VISIBLE_TAIL = 4;

const DOT = '•';

/**
 * A short, non-reversible hint at the connected account.
 *
 *   whatsapp  "237600001234" → "••••1234"   (last four, the convention every
 *                                            bank and carrier already uses)
 *   telegram  "@janedoe"     → "@janedoe"   (a handle the person chose and
 *                                            publishes; not an identifier we
 *                                            are disclosing)
 *   telegram  no handle      → null         (the numeric chat id is NEVER a
 *                                            fallback — that is the identifier
 *                                            this function exists to withhold)
 *
 * Returns null rather than a partial id whenever there is nothing safe to show.
 * The caller renders `displayName` alone in that case.
 */
export function maskIdentity(
  channel: MessagingChannel,
  externalId: string,
  handle?: string | null
): string | null {
  switch (channel) {
    case 'whatsapp': {
      const digits = externalId.replace(/\D/g, '');
      if (digits.length < VISIBLE_TAIL) return null;
      return `${DOT.repeat(VISIBLE_TAIL)}${digits.slice(-VISIBLE_TAIL)}`;
    }
    case 'telegram': {
      if (!handle) return null;
      return handle.startsWith('@') ? handle : `@${handle}`;
    }
    default: {
      // Exhaustiveness: adding a channel without a masking rule fails to
      // compile here rather than silently defaulting to disclosure.
      const unreachable: never = channel;
      return unreachable;
    }
  }
}
