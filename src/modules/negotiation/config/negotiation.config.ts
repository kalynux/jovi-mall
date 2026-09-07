/**
 * Negotiation module configuration.
 *
 * Only what the playbook store needs today. The bargaining policy's own numbers
 * (the concession ladder, the reserve fraction, the round cap) land here when
 * that half is built.
 */

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export const NEGOTIATION_CONFIG = {
    /**
     * The playbook the bargaining sub-agent is served when a request names none.
     * Must match the authored file's frontmatter `name`.
     */
    DEFAULT_PLAYBOOK_KEY: process.env.NEGOTIATION_PLAYBOOK_KEY || 'market-vendor-negotiation',

    /**
     * How long a resolved playbook is held in process, in seconds.
     *
     * This is read on every bargaining turn, so an uncached read would put a Mongo
     * round-trip in front of every haggling message for a document that changes
     * perhaps weekly. Sixty seconds is the trade: a dashboard edit is live within a
     * minute, which is fast enough for prompt tuning and slow enough that the query
     * is effectively free.
     *
     * ⚠ It is deliberately IN PROCESS and not Redis. The Redis index budget is 5–15
     * and full (`infra/redis/redis.factory.ts`), and the value here is a few
     * kilobytes of static text that every instance can hold its own copy of. The
     * cost is that instances can disagree for up to one TTL after an edit — which
     * for a system prompt means a brief prompt-cache miss on the instances that
     * changed over, and nothing else.
     */
    PLAYBOOK_CACHE_TTL_SECONDS: intEnv('NEGOTIATION_PLAYBOOK_CACHE_TTL_SECONDS', 60),

    /**
     * How long a haggle stays resumable, in minutes.
     *
     * A chat conversation, not a shopping session: a customer who wanders off and
     * comes back an hour later is starting a new negotiation, not continuing one, and
     * resuming would hold the agent to a concession made in a conversation the person
     * has forgotten. The durable profile is what survives — see the profile model.
     */
    SESSION_TTL_MINUTES: intEnv('NEGOTIATION_SESSION_TTL_MINUTES', 30),

    /**
     * How long an agreed price stays spendable, in minutes.
     *
     * ⚠ **This is the entire window in which D-10 can strand a customer.** The lock is
     * re-validated when it is consumed and may be REFUSED if the vendor has moved the
     * window since — so this number is exactly how long a vendor's price edit has to
     * break a promise the bot already made. Keep it in minutes. Raising it to hours
     * trades a small convenience for a checkout failure the customer cannot understand
     * and did nothing to cause.
     */
    LOCK_TTL_MINUTES: intEnv('NEGOTIATION_LOCK_TTL_MINUTES', 20),

    /**
     * The currency a negotiation quotes in.
     *
     * Matches `cart.model.ts`'s own default rather than being derived from the
     * variant, which carries none. When a real multi-currency model arrives, both move
     * together — a negotiation quoting one currency and a cart another would produce a
     * lock the cart refuses for a reason nobody could see.
     */
    DEFAULT_CURRENCY: process.env.NEGOTIATION_DEFAULT_CURRENCY || 'XAF',
} as const;
