import { CustomerModel } from '../../customers/customer.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { botPendingQuestionStore } from './bot-pending-question.store';

/**
 * ⭐ **An administrator wipes the bot's conversation memory for one customer** — the jovi-mall half.
 *
 * ── THE MEMORY IS NOT HERE, AND THIS SERVICE MUST NOT REACH FOR IT ──────────
 * The chat memory lives in the automation layer's own Redis. Reaching into it from here would make
 * this service a second writer of a store it does not own, with key names it would have to copy.
 * So what jovi-mall owns is an EPOCH per customer (`Customer.bot_memory_epoch`), which
 * `/identity/sync` hands the automation layer on every inbound message and which n8n folds into its
 * memory key: epoch 0 keeps the original key, epoch N appends `:e<N>`. Bumping the number makes the
 * old memory unreachable on the very next message; the old keys lapse on their own TTL.
 *
 * ── WHAT A RESET WRITES — and nothing else ──────────────────────────────────
 *   - `bot_memory_epoch` `$inc` 1 — atomic, so two administrators pressing at once land on two
 *     different numbers rather than one lost write;
 *   - `bot_memory_reset_at` = now;
 *   - the question waiting for a typed answer (`bot:pq:`), in every chat of the account — a
 *     conversation that has just been forgotten must not still act on "yes" to a question the model
 *     no longer remembers asking.
 *
 * `timestamps: false` on the update, so `updated_at` does not move: forgetting a conversation is not
 * a change to the customer's profile, and a profile screen sorted by "recently edited" must not say
 * it was.
 *
 * ⚠ **The pending-question clear is best-effort, on purpose.** The epoch is already bumped by then;
 * failing the request would invite a retry that bumps it AGAIN. The question lapses within fifteen
 * minutes on its own.
 */

export interface BotMemoryResetResult {
    userId: string;
    memoryEpoch: number;
    /** ISO. */
    resetAt: string;
}

/** Everything the reset touches, as a seam — so `test:chat-answer` drives it with no database. */
export interface BotMemoryResetPorts {
    /** `$inc` the epoch and stamp the time on the customer profile of this user; the new epoch, or null. */
    bumpEpoch(userId: string, at: Date): Promise<number | null>;
    clearPendingQuestions(userId: string): Promise<void>;
}

const MONGO_PORTS: BotMemoryResetPorts = {
    async bumpEpoch(userId, at) {
        const updated = await CustomerModel.findOneAndUpdate(
            { user_id: userId },
            { $inc: { bot_memory_epoch: 1 }, $set: { bot_memory_reset_at: at } },
            { new: true, projection: { bot_memory_epoch: 1 }, timestamps: false },
        ).lean<{ bot_memory_epoch?: number }>();
        return updated ? updated.bot_memory_epoch ?? 0 : null;
    },
    clearPendingQuestions: (userId) => botPendingQuestionStore.clearForUser(userId),
};

export class BotMemoryService {
    constructor(private readonly ports: BotMemoryResetPorts = MONGO_PORTS) {}

    /**
     * Reset the bot memory of the customer behind `userId`.
     *
     * ⚠ **The caller checks the USER exists first** (`AdminUserService.getById` → `404
     * USER_NOT_FOUND`, which is also what a malformed id answers), so the refusal here means one
     * thing only: the account exists and has no customer profile — it has never talked to the bot
     * as a customer, so there is no memory to forget. `404 AUTH_PROFILE_NOT_FOUND`, `role: customer`.
     */
    async reset(userId: string, now: Date = new Date()): Promise<BotMemoryResetResult> {
        const memoryEpoch = await this.ports.bumpEpoch(userId, now);
        if (memoryEpoch === null) {
            throw createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, 'This account has no customer profile', {
                role: 'customer',
            });
        }

        try {
            await this.ports.clearPendingQuestions(userId);
        } catch (error) {
            console.warn('[BotSurface] memory reset: could not clear the pending question', error);
        }

        return { userId, memoryEpoch, resetAt: now.toISOString() };
    }
}

export const botMemoryService = new BotMemoryService();
