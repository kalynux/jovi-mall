/**
 * The messaging channels an account can be connected to.
 *
 * ── ONE declaration, derived everywhere ──────────────────────────────────────
 * The Mongoose `enum`, the Zod schema and every exhaustive `switch` in this
 * module all derive from `CONNECTION_CHANNELS`. Never hand-maintain a second
 * copy: the agent notification stack kept two and they drifted, leaving eight
 * `agent_contract.*` situations in the union and absent from the schema enum —
 * so every one of those notifications threw a ValidationError and the agent was
 * simply never told. `test:connections` asserts model-enum ↔ union agreement so
 * that cannot happen twice.
 *
 * Adding a channel is intended to be exactly this: one entry here, one branch in
 * `identity-mask.ts`, one branch wherever the bot handle is resolved. Nothing in
 * the code path from `/connect` to a bound account is channel-specific.
 */
export const CONNECTION_CHANNELS = ['whatsapp', 'telegram'] as const;

export type MessagingChannel = (typeof CONNECTION_CHANNELS)[number];

/** Narrowing guard for values arriving from Redis, a webhook, or a URL param. */
export function isMessagingChannel(value: unknown): value is MessagingChannel {
  return typeof value === 'string' && (CONNECTION_CHANNELS as readonly string[]).includes(value);
}
