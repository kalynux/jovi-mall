import { CustomerModel } from '../../customers/customer.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { botPendingQuestionStore } from './bot-pending-question.store';
import { botRecentlySentStore } from './bot-recently-sent.store';

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
 *   - what the platform has recently sent (`bot:sent:`), in every chat of the account — see below.
 *
 * `timestamps: false` on the update, so `updated_at` does not move: forgetting a conversation is not
 * a change to the customer's profile, and a profile screen sorted by "recently edited" must not say
 * it was.
 *
 * ── ⭐ WHY THE RECENTLY-SENT RECORD GOES TOO (owner's call, 2026-09-22) ──────
 * The button is described to administrators as *"make the bot forget this customer's chat"*, and it
 * is pressed because the bot is confused by something it remembers. Bumping the epoch and clearing
 * the waiting question while STILL handing the model the last five platform messages for up to two
 * hours does not match that promise — and those messages are exactly the material a confused turn
 * would latch back onto. The epoch already puts the automation layer's own memory out of reach;
 * `bot:sent:` is the one piece of remembered conversation left on this side, so it is the one thing
 * a reset would otherwise leave behind.
 *
 * ⚠ **Both clears are best-effort, on purpose.** The epoch is already bumped by then; failing the
 * request would invite a retry that bumps it AGAIN. The question lapses within fifteen minutes on
 * its own and the record within two hours.
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
    /**
     * Forget what the platform recently sent this account, in every chat (`bot:sent:`).
     *
     * ⚠ **OPTIONAL, and that is a compatibility decision rather than a design one** — the same
     * reasoning `BotProductCard.similarToken` carries. A required member would break every
     * hand-built `BotMemoryResetPorts` literal the moment it landed, in a suite another stream
     * owns, for a port whose real implementation is one line. `MONGO_PORTS` always supplies it, so
     * an absence only ever means "a fake, injected by a test that is about something else".
     */
    clearRecentlySent?(userId: string): Promise<void>;
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
    clearRecentlySent: (userId) => botRecentlySentStore.clearForUser(userId),
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

        /**
         * ⚠ **A SEPARATE try, not a second statement inside the one above.** The two clears are
         * independent forgettings of independent records; sharing a block would make a Redis error
         * on the first silently skip the second, which is the failure mode this reset exists to
         * prevent — a conversation that is half forgotten is the one that confuses the bot.
         */
        try {
            await this.ports.clearRecentlySent?.(userId);
        } catch (error) {
            console.warn('[BotSurface] memory reset: could not clear what was recently sent', error);
        }

        return { userId, memoryEpoch, resetAt: now.toISOString() };
    }
}

export const botMemoryService = new BotMemoryService();
