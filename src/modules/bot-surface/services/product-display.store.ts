import { randomBytes } from 'crypto';
import { MessagingChannel } from '../../channel-connections';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import { digestForKey } from '../domain/bot-key-digest';

/**
 * The set of products a customer was just shown, and the two handles onto it.
 *
 * ── WHY ANY STATE AT ALL, WHEN THE TOKENS CARRY IDS ─────────────────────────
 * `add:<product>:<variant>` needs nothing stored — that was a deliberate decision in
 * `bot-action-id.ts`, so a card in a chat history keeps working. Two things do need state,
 * and neither can be squeezed into 64 bytes of `callback_data`:
 *
 *   1. **"See more."** The next page is the rest of a list the model chose, and that choice
 *      lives nowhere else — the model picked ten ids from a search it ran, and asking it again
 *      would re-run the search and possibly return a different ten.
 *   2. **The Mini App.** A browser cannot present `INTERNAL_SERVICE_TOKEN` or
 *      `BOT_WEBHOOK_SECRET` — those are the automation layer's, and putting either in a URL
 *      would hand every viewer the whole bot surface. So the page authenticates with a handle,
 *      and the handle has to resolve to a customer somewhere.
 *
 * ── TWO HANDLE KINDS, AND THEY ARE DELIBERATELY NOT THE SAME STRING ─────────
 * `ds_…` is a **set id**: it rides in `callback_data` and in a WhatsApp button payload, and it
 * never leaves the conversation. `ma_…` is a **Mini App handle**: it rides in a URL, in a
 * browser, through whatever the customer's phone does with links.
 *
 * Making them one value would mean that anything holding a "See more" token could also open a
 * page that writes to the basket. They are both random and both short-lived, so the risk is
 * small either way — but the two travel through different media with different leak
 * behaviour, and one string doing both jobs is how a payload token quietly becomes a bearer
 * credential.
 *
 * ── ⚠ A THIRD PREFIX ON `BOT_SURFACE_DB`, AND THAT IS A CONCESSION ──────────
 * DB 10 already holds `bot:idem:` (the duplicate-checkout guard — DESTRUCTIVE if flushed) and
 * `bot:geo:` (trivial). This adds `bot:display:` and `bot:miniapp:`. The Redis index budget
 * on this platform is 5–15 with a hard ceiling of 16 (`redis.factory.ts`), so there was no
 * database to take; the flush policy for DB 10 is prefix-scoped for exactly this reason, and
 * these two prefixes are as cheap to lose as `bot:geo:` — a customer re-asks and gets a fresh
 * list with live prices.
 */

/** GAP-005's 30 minutes, reused. A list a customer is still scrolling is a list still worth having. */
export const PRODUCT_DISPLAY_TTL_SECONDS = 30 * 60;

const SET_PREFIX = 'ds_';
const MINIAPP_PREFIX = 'ma_';
const HANDLE_BYTES = 16;

const setKey = (setId: string): string => `bot:display:${digestForKey(setId)}`;
const miniAppKey = (handle: string): string => `bot:miniapp:${digestForKey(handle)}`;

const randomHandle = (prefix: string): string =>
    `${prefix}${randomBytes(HANDLE_BYTES).toString('base64url')}`;

/** What was shown, to whom, and what is left. */
export interface ProductDisplaySet {
    /** The `users` row. Matched on every read — a handle belongs to one account. */
    owner: string;
    /** The `customers` row, so a Mini App cart write needs no second lookup. */
    customerId: string;
    channel: MessagingChannel;
    /** The conversation. A reply built from this set can be addressed nowhere else. */
    externalId: string;
    language: string | null;
    /**
     * The WHOLE ordered set the model chose — not just the page that was sent.
     *
     * Capped by the caller. It is the model's selection rather than a search: re-running the
     * search for page two could return different products at different prices, which reads to
     * a customer as the shop changing its mind.
     */
    productIds: string[];
    /** How many of them have already been sent. Page two starts here. */
    offset: number;
    /**
     * ⚠ **The authority on whether this set is still live**, over and above the Redis TTL.
     *
     * Same rule the bargaining flag follows: a key that outlives its TTL for any reason — a
     * restored dump, a replicated database with a different clock, an `EX` that did not take
     * — must not resurrect a list quoting last month's prices.
     */
    expiresAt: string;
}

interface MiniAppPointer {
    setId: string;
    owner: string;
    expiresAt: string;
}

const unexpired = (expiresAt: string): boolean => {
    const at = Date.parse(expiresAt);
    return Number.isFinite(at) && at > Date.now();
};

export class ProductDisplayStore {
    /** Persist a set and return its id. */
    async mint(set: Omit<ProductDisplaySet, 'expiresAt'>): Promise<string> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const setId = randomHandle(SET_PREFIX);
        const record: ProductDisplaySet = {
            ...set,
            expiresAt: new Date(Date.now() + PRODUCT_DISPLAY_TTL_SECONDS * 1000).toISOString(),
        };

        await redis.set(setKey(setId), JSON.stringify(record), {
            EX: PRODUCT_DISPLAY_TTL_SECONDS,
        });
        return setId;
    }

    /**
     * Read a set, refusing an unknown, lapsed or wrong-owner handle alike.
     *
     * One bucket, as `GeoCandidateStore.consume` does, and for the same reason: all four have
     * the same remedy (ask again), and distinguishing them would confirm to a caller that a
     * handle it does not own is real.
     *
     * ⚠ **Not single-use.** A geo candidate is spent because saving one address twice is a
     * bug; a product list is read again on every "See more" and on every Mini App refresh.
     */
    async read(owner: string, setId: string): Promise<ProductDisplaySet | null> {
        if (!setId.startsWith(SET_PREFIX)) return null;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = await redis.get(setKey(setId));
        if (!raw) return null;

        let record: ProductDisplaySet;
        try {
            record = JSON.parse(raw) as ProductDisplaySet;
        } catch {
            console.error('[BotSurface] malformed product-display record');
            return null;
        }

        if (record.owner !== owner) return null;
        if (!unexpired(record.expiresAt)) return null;
        return record;
    }

    /**
     * Move the read cursor on.
     *
     * ⚠ **Rewrites the value with a FRESH `EX`, and deliberately does not slide `expiresAt`.**
     * The Redis TTL is refreshed so the key survives as long as the customer keeps paging;
     * the recorded expiry is not, so the list still dies half an hour after it was built. A
     * sliding expiry would let a customer page through last week's prices indefinitely.
     */
    async advance(owner: string, setId: string, offset: number): Promise<void> {
        const existing = await this.read(owner, setId);
        if (!existing) return;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.set(setKey(setId), JSON.stringify({ ...existing, offset }), {
            EX: PRODUCT_DISPLAY_TTL_SECONDS,
        });
    }

    /**
     * Mint the URL handle for a set.
     *
     * A pointer rather than a copy, so the Mini App and the "See more" button always describe
     * the same list — two copies would drift the moment one of them paged.
     */
    async mintMiniAppHandle(owner: string, setId: string): Promise<string> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const handle = randomHandle(MINIAPP_PREFIX);
        const pointer: MiniAppPointer = {
            setId,
            owner,
            expiresAt: new Date(Date.now() + PRODUCT_DISPLAY_TTL_SECONDS * 1000).toISOString(),
        };

        await redis.set(miniAppKey(handle), JSON.stringify(pointer), {
            EX: PRODUCT_DISPLAY_TTL_SECONDS,
        });
        return handle;
    }

    /**
     * Resolve a Mini App handle to the set it names.
     *
     * ⚠ **Takes NO owner, because the handle IS the credential** — the page is opened by a
     * browser holding nothing else. That is the same posture the pay link takes, and it is
     * why the handle is 16 random bytes, lives thirty minutes, and resolves to a set that
     * already names its own customer: nothing the page sends can widen what it reaches.
     */
    async readByMiniAppHandle(handle: string): Promise<ProductDisplaySet | null> {
        if (!handle.startsWith(MINIAPP_PREFIX)) return null;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = await redis.get(miniAppKey(handle));
        if (!raw) return null;

        let pointer: MiniAppPointer;
        try {
            pointer = JSON.parse(raw) as MiniAppPointer;
        } catch {
            console.error('[BotSurface] malformed mini-app pointer');
            return null;
        }

        if (!unexpired(pointer.expiresAt)) return null;
        return this.read(pointer.owner, pointer.setId);
    }
}

export const productDisplayStore = new ProductDisplayStore();
