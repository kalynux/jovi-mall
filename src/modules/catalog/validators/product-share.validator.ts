import { z } from 'zod';

/**
 * `POST /api/vendor/products/:id/share`.
 *
 * ⚠ **There is no `to` field, and that is a constraint rather than a simplification.**
 * Neither channel can address an arbitrary recipient: WhatsApp permits only an approved
 * template outside its 24-hour service window, and the Telegram Bot API sends to a
 * `chat_id`, which exists only after that person has started the bot. A share therefore
 * goes to the vendor's own connected identity, and they forward it.
 *
 * `.strict()` so a client sending `to` is told, rather than having it silently ignored and
 * believing a customer was messaged.
 */
export const ShareProductSchema = z
  .object({
    channel: z.enum(['whatsapp', 'telegram']),
  })
  .strict();

export type ShareProductInput = z.infer<typeof ShareProductSchema>;
