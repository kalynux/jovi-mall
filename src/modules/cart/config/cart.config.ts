/**
 * Basket configuration.
 */
export const CART_CONFIG = {
  /**
   * The abandoned-basket reminder (`AbandonedCartWorker`).
   *
   * ⚠ **OFF unless `CART_REMINDER_ENABLED=true`** — owner's ruling 2026-09-27 (plan Q-7). It is
   * the first message the platform sends that is not the consequence of something the customer
   * or a counterparty did, so it ships dark and is switched on deliberately.
   */
  reminder: {
    enabled: process.env.CART_REMINDER_ENABLED === 'true',
    /**
     * How long after the basket was last touched, in minutes. **12 hours** by default (owner's
     * ruling 2026-09-27, plan Q-8). Still inside Meta's 23-hour free window for a basket built
     * in the chat, since building it meant messaging — and where the window HAS closed, the
     * WhatsApp message is simply not sent (the situation has no template, deliberately).
     */
    leadMinutes: parseInt(process.env.CART_REMINDER_LEAD_MINUTES || '720', 10),
    /**
     * The sweep's cadence, and the width of each pass's window — consecutive passes tile
     * `updatedAt` exactly, as the booking reminder tiles `startAt`.
     */
    intervalMs: parseInt(process.env.CART_REMINDER_INTERVAL_MS || '900000', 10), // 15 min
    batchSize: parseInt(process.env.CART_REMINDER_BATCH_SIZE || '500', 10),
  },
} as const;
