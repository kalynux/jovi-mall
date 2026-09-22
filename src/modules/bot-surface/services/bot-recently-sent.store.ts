import { CONNECTION_CHANNELS } from '../../channel-connections';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import type { BotReplyIntent } from '../domain/channel-reply';
import type { PendingQuestionOwner } from '../domain/bot-pending-question';
import {
    BotRecentlySentEntry,
    RECENTLY_SENT_TTL_SECONDS,
    appendRecentlySent,
    compactSentText,
    readRecentlySent,
    sentTextForIntent,
    serializeRecentlySent,
} from '../domain/bot-recently-sent';

/**
 * Where "what the platform has recently sent this customer" lives — one key per conversation,
 * two hours.
 *
 * The rules are in `domain/bot-recently-sent.ts`; this file only persists them.
 *
 * ── ⚠ A SIXTH PREFIX ON `BOT_SURFACE_DB` (10), AND THAT IS THE CONCESSION AGAIN ──
 * `bot:sent:` sits beside `bot:idem:`, `bot:geo:`, `bot:display:`, `bot:miniapp:` and `bot:pq:`.
 * The 5–15 index budget is full and the ceiling is 16 (`redis.factory.ts`), so there was no
 * database to take, and the flush policy for DB 10 is prefix-scoped for exactly this. Losing
 * these keys is as cheap as losing `bot:geo:`: the model answers the next message without knowing
 * what was sent before it, which is precisely the behaviour this record improves on and never a
 * behaviour it breaks. Nothing is placed, cancelled or disclosed by an absence.
 *
 * ── THE KEY IS THE ACCOUNT + CHANNEL — the pending question's own owner type ─
 * An ObjectId and a channel name, so no messaging identifier reaches a listable key name. The two
 * records describe the same conversation and must not be able to disagree about whose it is.
 *
 * ── WHO WRITES, WHO READS ───────────────────────────────────────────────────
 *   `noteDraw`   the reply interceptor, on every drawn success reply (`bot-reply.middleware.ts`)
 *                — which covers a tool's message and a TAP's message alike
 *   `noteSent`   the customer notification handler, once a chat delivery actually succeeded
 *   `peek`       `/identity/sync` and `/identity/resolve`, which show the model the list
 *
 * ── ⚠ EVERY CALLER IS BEST-EFFORT, AND THAT IS NOT DEFENSIVENESS ────────────
 * A write happens after the response's real work is done (the order is placed, the notification
 * is delivered) and a read happens on the one call every inbound message makes. A Redis blip must
 * cost at most some context in a prompt — never a turn, never a notification. The callers catch;
 * this file does not swallow, so a fault is still visible in a log line.
 */

const keyFor = (owner: PendingQuestionOwner): string => `bot:sent:${owner.userId}:${owner.channel}`;

export class BotRecentlySentStore {
    /**
     * Remember one thing the platform sent.
     *
     * ⚠ **Read-modify-write, deliberately not a Redis LIST.** Two writes for one conversation
     * within a millisecond would have to come from two inbound messages of the same customer on
     * the same channel, which the platforms serialise; and the loss if it ever happened is one
     * line of prompt context. A list would buy atomicity at the cost of a second expiry model
     * (`LTRIM` plus a key TTL cannot express a PER-ENTRY age, which is what
     * `RECENTLY_SENT_TTL_SECONDS` is about — see `appendRecentlySent`).
     */
    async record(
        owner: PendingQuestionOwner,
        entry: BotRecentlySentEntry,
        now: Date = new Date(),
    ): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const key = keyFor(owner);
        const entries = appendRecentlySent(readRecentlySent(await redis.get(key), owner, now), entry, now);
        await redis.set(key, serializeRecentlySent(owner, entries), { EX: RECENTLY_SENT_TTL_SECONDS });
    }

    /** What the platform has sent this conversation lately. Empty when there is nothing. */
    async peek(owner: PendingQuestionOwner, now: Date = new Date()): Promise<BotRecentlySentEntry[]> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        return readRecentlySent(await redis.get(keyFor(owner)), owner, now);
    }

    /** Forget this conversation's record. */
    async clear(owner: PendingQuestionOwner): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(keyFor(owner));
    }

    /**
     * Forget the record in EVERY chat of one account.
     *
     * Derived from `CONNECTION_CHANNELS`, never a hand-kept pair, so a third channel is covered
     * the day it is added — the same construction `BotPendingQuestionStore.clearForUser` uses.
     */
    async clearForUser(userId: string): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(CONNECTION_CHANNELS.map((channel) => keyFor({ userId, channel })));
    }

    /**
     * Record the message a drawn reply is about to send. Nothing when the intent renders no words.
     *
     * ⚠ **Touches Redis only when there is something to record**, and the interceptor calls this
     * on every response.
     */
    async noteDraw(
        owner: PendingQuestionOwner,
        intent: BotReplyIntent | null | undefined,
        now: Date = new Date(),
    ): Promise<BotRecentlySentEntry | null> {
        const text = sentTextForIntent(intent);
        if (!text) return null;
        const entry: BotRecentlySentEntry = { at: now.toISOString(), text };
        await this.record(owner, entry, now);
        return entry;
    }

    /**
     * Record a NOTIFICATION the platform delivered to this chat — the half of the record that
     * does not come through the bot surface at all.
     *
     * `body` is the notification's own rendered copy and `labels` its button and quick-reply
     * labels, so a notification reads in the record exactly as a drawn reply does.
     */
    async noteSent(
        owner: PendingQuestionOwner,
        body: string,
        labels: readonly string[] = [],
        now: Date = new Date(),
    ): Promise<BotRecentlySentEntry | null> {
        const text = compactSentText(body, labels);
        if (text.length === 0) return null;
        const entry: BotRecentlySentEntry = { at: now.toISOString(), text };
        await this.record(owner, entry, now);
        return entry;
    }
}

export const botRecentlySentStore = new BotRecentlySentStore();
