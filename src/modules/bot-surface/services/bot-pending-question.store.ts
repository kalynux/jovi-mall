import { CONNECTION_CHANNELS } from '../../channel-connections';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import type { BotReplyIntent } from '../domain/channel-reply';
import {
    BotPendingQuestion,
    PENDING_QUESTION_TTL_SECONDS,
    PendingQuestionDecision,
    PendingQuestionOwner,
    PendingQuestionTaker,
    pendingQuestionDecisionFor,
    readPendingQuestion,
    serializePendingQuestion,
} from '../domain/bot-pending-question';

/**
 * Where "the question waiting for an answer" lives — one key per conversation, fifteen minutes.
 *
 * The rules are in `domain/bot-pending-question.ts`; this file only persists them.
 *
 * ── ⚠ A FIFTH PREFIX ON `BOT_SURFACE_DB` (10), AND THAT IS THE CONCESSION AGAIN ──
 * `bot:pq:` sits beside `bot:idem:`, `bot:geo:`, `bot:display:` and `bot:miniapp:`. The 5–15 index
 * budget is full and the ceiling is 16 (`redis.factory.ts`), so there was no database to take, and
 * the flush policy for DB 10 is prefix-scoped for exactly this. Losing these keys is as cheap as
 * losing `bot:geo:`: a customer who types "yes" is told there is no question waiting and taps the
 * button instead — nothing is placed, cancelled or closed by an absence.
 *
 * ── THE KEY IS THE ACCOUNT + CHANNEL — see `PendingQuestionOwner` ───────────
 * An ObjectId and a channel name, so no messaging identifier reaches a listable key name and no
 * digest is needed. It also lets `clearForUser` reach every chat of one account with no lookup.
 *
 * ── WHO WRITES, WHO CLEARS ──────────────────────────────────────────────────
 *   `noteDraw`      the reply interceptor, on every drawn success reply (`bot-reply.middleware.ts`)
 *   `clear`         the tap dispatcher, before it routes any tap (`bot-action.controller.ts`)
 *   `take`          `chat_answer_question`, atomically, before it routes the stored token
 *   `peek`          `/identity/sync`, which shows the model the question (never its tokens)
 *   `clearForUser`  an administrator's memory reset (`bot-memory.service.ts`)
 */

const keyFor = (owner: PendingQuestionOwner): string => `bot:pq:${owner.userId}:${owner.channel}`;

/**
 * Read-and-delete atomically, on any Redis from 2.6 — the script `geo-candidate.store.ts` uses.
 *
 * ⚠ **Not `GETDEL`**: the development Redis on this platform is 3.0, where it is an unknown
 * command. And **never a `get` then a `del`**: two answers arriving together would both see the
 * question and both run its token.
 */
const TAKE_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

export class BotPendingQuestionStore implements PendingQuestionTaker {
    /** Remember a question. A newer one overwrites an older one — one question per conversation. */
    async record(owner: PendingQuestionOwner, question: BotPendingQuestion): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.set(keyFor(owner), serializePendingQuestion(owner, question), {
            EX: PENDING_QUESTION_TTL_SECONDS,
        });
    }

    /** The waiting question, left in place. Null when there is none, or it is not one we trust. */
    async peek(owner: PendingQuestionOwner, now: Date = new Date()): Promise<BotPendingQuestion | null> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        return readPendingQuestion(await redis.get(keyFor(owner)), owner, now);
    }

    /** The waiting question, removed in the same step. What an answer spends. */
    async take(owner: PendingQuestionOwner, now: Date = new Date()): Promise<BotPendingQuestion | null> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = (await redis.eval(TAKE_SCRIPT, { keys: [keyFor(owner)] })) as string | null;
        return readPendingQuestion(raw, owner, now);
    }

    /** Forget this conversation's question — a tap moved it on. */
    async clear(owner: PendingQuestionOwner): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(keyFor(owner));
    }

    /**
     * Forget the question in EVERY chat of one account — the administrator's memory reset.
     *
     * Derived from `CONNECTION_CHANNELS`, never a hand-kept pair, so a third channel is covered the
     * day it is added.
     */
    async clearForUser(userId: string): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(CONNECTION_CHANNELS.map((channel) => keyFor({ userId, channel })));
    }

    /**
     * Apply what a drawn reply means for the waiting question: record it, withdraw the old one, or
     * leave it alone. Returns the decision so the caller — and the suite — can see what was done.
     *
     * ⚠ **Touches Redis only when there is something to do.** Most replies carry no confirm button,
     * and the interceptor calls this on every one of them.
     */
    async noteDraw(
        owner: PendingQuestionOwner,
        intent: BotReplyIntent | null | undefined,
        now: Date = new Date(),
    ): Promise<PendingQuestionDecision> {
        const decision = pendingQuestionDecisionFor(intent, now);
        if (decision.kind === 'record') await this.record(owner, decision.question);
        if (decision.kind === 'supersede') await this.clear(owner);
        return decision;
    }
}

export const botPendingQuestionStore = new BotPendingQuestionStore();
