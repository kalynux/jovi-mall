import type { MessagingChannel } from '../../channel-connections';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import { digestForKey } from '../domain/bot-key-digest';

/**
 * A Bargain pressed on a SCREEN, held until the customer's next message — so the answer to
 * "what would you like to pay?" reaches the bargainer rather than the main assistant.
 *
 * ── ⛔ THE GAP THIS CLOSES ──────────────────────────────────────────────────
 * The bargainer is routed to by a flag in the AUTOMATION LAYER's own Redis
 * (`wi-mall:bargain:<channel>:<externalId>`, `api-doc/n8n/N8N-DEPLOY-DAY-CHANGES.md` § 8.2).
 * n8n sets it when a chat `bargain:` TAP comes back `outcome: 'chat'`, because the tap
 * travels through n8n. A press on the in-app detail screen does not: the page posts straight
 * here, this service pushes the question into the thread, and n8n never learns a haggle was
 * asked for. The customer then types their offer, it lands on the main assistant with no
 * product in view, and "they think they are haggling and nobody is" — § 8.2's own words for
 * the same defect on the tap, before that was fixed.
 *
 * jovi-mall cannot write n8n's flag (a different Redis, and not this service's keyspace), and
 * it cannot start a bargain (`bargain-cannot-be-started-from-backend`). What it CAN do is
 * answer the call n8n already makes on every inbound message. So the press records what was
 * asked here, and `POST /identity/sync` hands it over ONCE as `pendingBargain`; n8n writes its
 * own flag from it, exactly as it does from a tap.
 *
 * ── ⚠ ONE PER CONVERSATION, AND THE LATEST PRESS WINS ───────────────────────
 * Keyed by the conversation, never by a handle: the next message arrives from the chat, and
 * the chat is all `/identity/sync` knows. A second press on another product overwrites the
 * first, which is what the customer means — the last question they were asked is the one
 * they are answering.
 *
 * ── ⚠ HANDED OVER ONCE ──────────────────────────────────────────────────────
 * Read-and-delete on the sync that reports it. After that the flag n8n wrote is the authority,
 * and it is cleared by n8n when the haggle closes. Leaving it here would re-open a finished
 * haggle on every later message for as long as the entry lived.
 *
 * ⚠ **The hand-off is inert until n8n reads the field.** A sync consumes it either way; until
 * the automation layer uses it, it is consumed and discarded, which is exactly today's
 * behaviour.
 */

/**
 * Thirty minutes — the lifetime n8n gives the flag it writes on a Bargain TAP (§ 8.2), which in
 * turn mirrors `NEGOTIATION_SESSION_TTL_MINUTES`.
 *
 * ⚠ **Not read from the negotiation config, deliberately.** The purchase path must not reach for
 * the negotiation module at all (`test:inapp-purchase` refuses the import), and this only has to
 * outlive the gap between a press and the customer's next message.
 */
export const PENDING_BARGAIN_TTL_SECONDS = 30 * 60;

/** What the automation layer is told, and it is exactly the shape a tap's response carries. */
export interface PendingBargain {
    productId: string;
    variantId: string;
    /** Always 1: a detail screen has no quantity control, and neither does a card (§ 8.2). */
    quantity: number;
}

interface StoredPendingBargain extends PendingBargain {
    /** The `users` row that pressed. A sync resolving to anyone else is refused. */
    owner: string;
    /** The authority on liveness, above the Redis TTL — the rule every store here keeps. */
    expiresAt: string;
}

/**
 * Read-and-delete atomically. `GETDEL` is Redis 6.2 and the development Redis is 3.0 — see
 * `geo-candidate.store.ts`, which was bitten by exactly this once already.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

/**
 * Hashed for the reason every conversation-keyed name on this surface is: key NAMES are listed
 * to dev-tools callers, and a raw `whatsapp:2376…` there is a list of who has been haggling.
 */
const conversationKey = (channel: MessagingChannel, externalId: string): string =>
    `bot:bargain:pending:${digestForKey(`${channel}:${externalId}`)}`;

export class PendingBargainStore {
    /** Record a press. Overwrites any earlier one for the same conversation — see the header. */
    async record(
        conversation: { owner: string; channel: MessagingChannel; externalId: string },
        bargain: { productId: string; variantId: string },
    ): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const stored: StoredPendingBargain = {
            owner: conversation.owner,
            productId: bargain.productId,
            variantId: bargain.variantId,
            quantity: 1,
            expiresAt: new Date(Date.now() + PENDING_BARGAIN_TTL_SECONDS * 1000).toISOString(),
        };
        await redis.set(
            conversationKey(conversation.channel, conversation.externalId),
            JSON.stringify(stored),
            { EX: PENDING_BARGAIN_TTL_SECONDS },
        );
    }

    /**
     * Hand the press over, once. Null when there is none, it lapsed, or it belongs to another
     * account — one bucket, because all three mean "route this message as usual".
     */
    async consume(
        channel: MessagingChannel,
        externalId: string,
        owner: string,
    ): Promise<PendingBargain | null> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = (await redis.eval(CONSUME_SCRIPT, {
            keys: [conversationKey(channel, externalId)],
        })) as string | null;
        if (!raw) return null;

        let stored: StoredPendingBargain;
        try {
            stored = JSON.parse(raw) as StoredPendingBargain;
        } catch {
            return null;
        }

        const expiry = Date.parse(stored.expiresAt);
        if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
        if (stored.owner !== owner || !stored.productId || !stored.variantId) return null;

        return { productId: stored.productId, variantId: stored.variantId, quantity: 1 };
    }
}

export const pendingBargainStore = new PendingBargainStore();
