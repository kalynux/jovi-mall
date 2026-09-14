import { MailProviderName } from '../mail.config';

/**
 * Which providers are currently believed to be out of allowance, and until when.
 *
 * ═══ THE ONE RULE ════════════════════════════════════════════════════════════
 *
 *   A latch is an OPTIMISATION. It may never be the reason a message is not sent.
 *
 * Everything below follows from that. The latch exists to stop the chain spending a round trip
 * to be told something it already knows — with a 300/day Brevo account and a few thousand sends,
 * that is thousands of pointless calls a day. It is a *guess*, derived from one earlier refusal,
 * about a counter held on somebody else's server. `ChainedMailProvider` therefore tries latched
 * providers anyway once the unlatched ones are exhausted, and this module deliberately offers no
 * way to express "refuse to send". Dropping a password reset on the strength of a guess is not a
 * trade this platform makes.
 *
 * ═══ WHY IN-PROCESS, AND NOT REDIS OR MONGO ══════════════════════════════════
 *
 * This is the question to answer before "improving" it, because both alternatives look better
 * than they are here:
 *
 *   Redis   would converge across instances — but the logical-database budget is FULL. This
 *           service may only assign 5–15, all eleven are taken, and two already hold two things
 *           each behind key prefixes (`infra/redis/redis.factory.ts`). Buying a latch with a
 *           third such pairing is not worth it for state this cheap to rebuild.
 *   Mongo   would survive a restart and show up on the ops surface — at the cost of a read on
 *           the send path, a collection, and (the part that decides it) a latch an operator who
 *           has just upgraded their Brevo plan CANNOT CLEAR. A durable latch is a durable wrong
 *           answer; this one is cleared by a restart, which is a remedy an operator already has.
 *
 * What losing the state actually costs is **one wasted API call per provider per restart**: the
 * chain asks Brevo, is refused, and re-latches. That is the whole downside, and it is the
 * argument for keeping this a `Map`.
 *
 * ⚠ The corollary is that the latch is **per process**. The deployment is one host today
 * (`docs/ADR-019-RELEASE-SHAPE.md`) and this service has no cross-instance coordination at all,
 * which `system/models/system-state.model.ts` already states. Scaling to two instances doubles
 * the wasted calls and breaks nothing.
 */

export type MailLatchKind = 'quota' | 'cooldown';

export interface MailLatchState {
    provider: MailProviderName;
    kind: MailLatchKind;
    /** The instant the latch releases. */
    until: Date;
    latchedAt: Date;
    /** The `ERROR_CODES` value that caused it, for the ops row. Never a provider's prose. */
    reason: string;
}

const latches = new Map<MailProviderName, MailLatchState>();

/**
 * Is this provider latched right now?
 *
 * Expired entries are deleted on read rather than swept, because there are at most four of them
 * and a sweep would be a timer this process does not need — it already carries eighteen.
 */
export function isLatched(provider: MailProviderName, now: Date = new Date()): boolean {
    const state = latches.get(provider);
    if (!state) return false;
    if (state.until.getTime() <= now.getTime()) {
        latches.delete(provider);
        return false;
    }
    return true;
}

/**
 * Record a latch.
 *
 * ⚠ **The LONGER latch wins.** A quota refusal (latched to midnight) followed by a rate limit
 * (five minutes) must not shorten the first — the allowance is still spent, and re-asking five
 * minutes later burns exactly the call the latch existed to save. Comparing instants rather than
 * kinds keeps that true without a precedence table to get wrong.
 */
export function latch(state: MailLatchState): void {
    const existing = latches.get(state.provider);
    if (existing && existing.until.getTime() >= state.until.getTime()) return;
    latches.set(state.provider, state);
}

/** Release one provider, or all of them. Used by the tests and by nothing on the send path. */
export function clearLatch(provider?: MailProviderName): void {
    if (provider) latches.delete(provider);
    else latches.clear();
}

/**
 * Every live latch, for `/system/integrations`.
 *
 * Reporting this is half the point of the feature: "Brevo is latched until 00:00 on
 * MAIL_PROVIDER_QUOTA_EXCEEDED" is the sentence that tells an operator their free tier is the
 * binding constraint, and it is not deducible from anywhere else — a successful send through the
 * reserve provider looks exactly like a successful send through the primary.
 */
export function latchSnapshot(now: Date = new Date()): MailLatchState[] {
    const live: MailLatchState[] = [];
    for (const [provider, state] of latches) {
        if (state.until.getTime() <= now.getTime()) latches.delete(provider);
        else live.push(state);
    }
    return live;
}
