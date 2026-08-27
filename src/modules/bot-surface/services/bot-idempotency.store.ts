import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import { digestForKey } from '../domain/bot-key-digest';

/**
 * `Idempotency-Key` records for the bot surface.
 *
 * ── WHY THIS EXISTS AT ALL, IN ONE SENTENCE ──────────────────────────────────
 * `POST /api/internal/bot/checkout` is not idempotent underneath — a retried call creates
 * a SECOND set of orders and a SECOND thirty-minute stock hold — and chat transports
 * retry constantly: the automation layer retries, the network retries, and the customer
 * taps the button twice. `POST /cart/items` is the same shape in miniature, silently
 * doubling a line. Every other mutating route on the surface is covered by the same
 * mechanism rather than case by case, because the next route added will have the same
 * problem and nobody will remember.
 *
 * ── THE RECORD IS SCOPED TO (identity, key, request), AND ALL THREE MATTER ───
 * The key alone is not enough. It is caller-chosen, so two conversations may pick the
 * same string; scoping to the resolved identity means one customer's retry can never
 * return another's response. And the request FINGERPRINT is stored beside it, so a caller
 * that reuses one key for a different call is refused (`BOT_IDEMPOTENCY_KEY_REUSED`)
 * rather than handed the earlier answer — replaying a cart response to a checkout would
 * be far worse than an error.
 *
 * ── TWO TTLs, AND THE SHORT ONE IS THE IMPORTANT ONE ────────────────────────
 * A claim lives 60 seconds; a completed record lives 24 hours. If the short claim carried
 * the full 24 hours, a process that died mid-request would block that key for a day and
 * the customer would be told "still in flight" until tomorrow. Sixty seconds is longer
 * than any request this surface makes and short enough that a crash costs one minute.
 *
 * ── A FAILURE RELEASES THE KEY ───────────────────────────────────────────────
 * Only a 2xx is stored. A 422 from the stock gate, a 502 from a gateway, a 409 from a
 * compare-and-set — all release the claim, so the caller may retry the same key once the
 * cause is gone. Storing a failure and replaying it forever would turn a transient
 * outage into a permanently poisoned key, which is the opposite of what a retry mechanism
 * is for.
 */

/** How long an unanswered claim blocks its key. */
export const BOT_IDEMPOTENCY_CLAIM_TTL_SECONDS = 60;

/** How long a completed response is replayable. GAP-001's stated 24 hours. */
export const BOT_IDEMPOTENCY_RECORD_TTL_SECONDS = 24 * 60 * 60;

/** What was answered, verbatim, so a replay is byte-identical to the original. */
export interface BotIdempotentResponse {
    status: number;
    body: unknown;
}

interface StoredRecord {
    /** `in_progress` while the first call is still running. */
    state: 'in_progress' | 'done';
    /** Of `(method, absolute path, arguments)` — see `fingerprintRequest`. */
    fingerprint: string;
    tool: string;
    response?: BotIdempotentResponse;
}

export type BotClaimResult =
    /** Nobody has used this key: run the operation. */
    | { status: 'claimed' }
    /** The first call finished: answer with what it answered. */
    | { status: 'replay'; response: BotIdempotentResponse }
    /** The first call has not finished yet. */
    | { status: 'in_progress'; tool: string }
    /** This key was spent by a DIFFERENT request. A caller bug, never a retry. */
    | { status: 'reused'; tool: string };

const recordKey = (identity: string, key: string): string =>
    `bot:idem:${digestForKey(identity)}:${digestForKey(key)}`;

export class BotIdempotencyStore {
    /**
     * Claim a key, or learn why you cannot.
     *
     * `SET … NX` is what makes the claim atomic. A `GET` followed by a `SET` would let two
     * concurrent retries of one checkout both find the key free and both proceed — which
     * is precisely the double-order this whole file exists to prevent, arriving through
     * the mechanism meant to stop it. Do not "simplify" it.
     */
    async claim(input: {
        identity: string;
        key: string;
        fingerprint: string;
        tool: string;
    }): Promise<BotClaimResult> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const k = recordKey(input.identity, input.key);

        const pending: StoredRecord = {
            state: 'in_progress',
            fingerprint: input.fingerprint,
            tool: input.tool,
        };

        const claimed = await redis.set(k, JSON.stringify(pending), {
            NX: true,
            EX: BOT_IDEMPOTENCY_CLAIM_TTL_SECONDS,
        });
        if (claimed !== null) return { status: 'claimed' };

        const raw = await redis.get(k);
        if (!raw) {
            // The record expired between the failed claim and this read. Treating that as
            // a fresh claim would race a genuinely concurrent caller; refusing costs one
            // retry and cannot double anything.
            return { status: 'in_progress', tool: input.tool };
        }

        let record: StoredRecord;
        try {
            record = JSON.parse(raw) as StoredRecord;
        } catch {
            // A key we wrote that we cannot read is our bug. Fail closed: refusing costs a
            // retry, and guessing costs a duplicate order.
            console.error('[BotSurface] malformed idempotency record; refusing the retry');
            return { status: 'in_progress', tool: input.tool };
        }

        if (record.fingerprint !== input.fingerprint) {
            return { status: 'reused', tool: record.tool };
        }

        if (record.state === 'done' && record.response) {
            return { status: 'replay', response: record.response };
        }

        return { status: 'in_progress', tool: record.tool };
    }

    /**
     * Store what was answered, and extend the key to its full life.
     *
     * The fingerprint is rewritten rather than trusted from the pending record, so a
     * completed row always describes the request that actually produced it.
     */
    async complete(input: {
        identity: string;
        key: string;
        fingerprint: string;
        tool: string;
        response: BotIdempotentResponse;
    }): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const record: StoredRecord = {
            state: 'done',
            fingerprint: input.fingerprint,
            tool: input.tool,
            response: input.response,
        };
        await redis.set(recordKey(input.identity, input.key), JSON.stringify(record), {
            EX: BOT_IDEMPOTENCY_RECORD_TTL_SECONDS,
        });
    }

    /** Drop a claim so the same key may be retried. Called on every non-2xx outcome. */
    async release(identity: string, key: string): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(recordKey(identity, key));
    }
}

export const botIdempotencyStore = new BotIdempotencyStore();
