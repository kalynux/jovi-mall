import { randomBytes } from 'crypto';
import { MessagingChannel } from '../../channel-connections';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import { digestForKey } from '../domain/bot-key-digest';

/**
 * The in-app screens' sessions — one handle per screen a customer was sent to.
 *
 * ── WHY A SIBLING OF `product-display.store.ts` RATHER THAN A WIDENING OF IT ─
 * That store is hard-typed to `ProductDisplaySet` and is read by the **shipped** chat-card
 * path — `productDisplayService`, `miniapp.controller.ts` and the `web_app` button all depend
 * on it working exactly as it does today. Adding a `kind` discriminator there would put a
 * working feature at risk to serve four screens that do not exist yet, and the old rail is
 * being retired anyway: it stays live until the new listing is proven on a real handset, then
 * it is deleted. Two stores during that overlap is the cost of not breaking the one that works.
 *
 * ⚠ **That deletion is a named task, not a someday.** Dead code that looks alive is how
 * somebody later fixes a bug in the wrong file.
 *
 * ── ONE PREFIX, FIVE SCREENS — AND THE KIND IS CHECKED ON READ ──────────────
 * `product-display.store.ts` argues that `ds_` and `ma_` must be different strings because
 * they travel through different media. All five screens here travel through the **same**
 * medium — a URL in a browser — so they share one prefix and one key space. What separates
 * them is not the string, it is that **`read` takes the kind it expects and refuses a
 * mismatch.** A listing handle replayed against the checkout endpoint reads as absent.
 *
 * That check is the load-bearing one, because the five kinds are not equally sensitive.
 *
 * ── ⚠ THE CHECKOUT HANDLE IS A BIGGER CREDENTIAL THAN ANYTHING ELSE HERE ────
 * The existing Mini App handle's stated worst case is *"adding items to a basket that is not
 * the thief's"* — annoying, reversible, worth nothing to an attacker. A `co` handle authorises
 * **placing an order against a stranger's saved address and starting a payment**, from a URL
 * carrying no other credential. That is a materially larger disclosure, so it gets three
 * things the others do not:
 *
 *   - a **shorter life** (`TTL_SECONDS.co`), because a checkout is finished in minutes or
 *     abandoned;
 *   - **single use on the write that places the order** (`consume`, not `read`), so a
 *     double-tap, a retry or a replayed URL cannot produce two orders;
 *   - the caller must project the address **masked** onto the page, the way
 *     `bot-projections.ts` already masks a phone number. Nothing here can enforce that, which
 *     is why it is stated here as well as there.
 *
 * ── ⚠ A FOURTH PREFIX ON `BOT_SURFACE_DB`, AND THE BUDGET IS THE REASON ─────
 * DB 10 already holds `bot:idem:` (destructive if flushed), `bot:geo:`, `bot:display:` and
 * `bot:miniapp:`. This adds `bot:inapp:`. The Redis index budget on this platform is 5–15
 * with a hard ceiling of 16, so there is no database to take — and DB 10's flush policy is
 * prefix-scoped for exactly this reason. Losing this prefix costs a customer a re-tap.
 */

/**
 * Which screen a handle opens.
 *
 * ⚠ **All five are declared now, including the two whose screens are a later milestone.**
 * This file is one stream's forever, and the alternative is a later session editing it while
 * others read it — which in one shared working tree is a lost write rather than a conflict.
 * The two short codes match `bot-action-id.ts`'s `open:<surface>` argument exactly, so a tap
 * and a session name the same thing.
 */
export type InAppSurfaceKind =
    /** Product listing — the search/category/wishlist grid. */
    | 'pl'
    /** Product detail — variants, options, description. */
    | 'pd'
    /** Order listing. A later milestone; the contract is frozen here. */
    | 'ol'
    /** Store listing. A later milestone; the contract is frozen here. */
    | 'sl'
    /** Checkout — cart, address, delivery, payment. The sensitive one. */
    | 'co'
    /** Ticket form — one screen to open a support request. */
    | 'tf'
    /** Bookings list — this customer's own appointments. */
    | 'bl'
    /** Booking picker — choose a time and confirm, for a new booking or a move. */
    | 'bk'
    /** Booking payment — pay a booking's deposit or its balance. */
    | 'bp';

/**
 * Per-kind lifetimes.
 *
 * ⚠ **Checkout is deliberately the odd one out.** Thirty minutes is right for a list somebody
 * is still scrolling; it is far too long for a credential that can place an order, and a
 * checkout is either finished in minutes or abandoned. Ten is generous for the work and mean
 * for a stolen URL.
 */
export const TTL_SECONDS: Readonly<Record<InAppSurfaceKind, number>> = Object.freeze({
    pl: 30 * 60,
    pd: 30 * 60,
    ol: 30 * 60,
    sl: 30 * 60,
    co: 10 * 60,
    /**
     * Thirty minutes, with the list screens rather than with checkout, because the customer is
     * WRITING here: describing what went wrong takes longer than paying, and a form that
     * expires mid-sentence loses what they typed. It spends its handle on submit all the same
     * — the single use is what stops a double tap opening two tickets — but single use and a
     * short life answer different risks, and only the first one applies to a support request.
     */
    tf: 30 * 60,
    bl: 30 * 60,
    /**
     * ⚠ **Fifteen minutes, and `touch` may NOT extend it** (see the signature below). A slot
     * picker whose life renews while somebody stares at it is an open-ended hold on a shop's
     * calendar; the expiry is what gives the time back to other customers.
     */
    bk: 15 * 60,
    /** Checkout's ten minutes, for checkout's reason: it is a credential that moves money. */
    bp: 10 * 60,
});

const HANDLE_PREFIX = 'ia_';
const HANDLE_BYTES = 16;

/**
 * A fresh handle — exactly what `mint` hands out, and the ONLY place one is built.
 *
 * ⚠ **Exported so a byte budget can measure the REAL thing rather than restate it.** A checkout
 * handle now rides inside a chat button (`yes:co:<handle>:<addressId>`, `bot-checkout-actions.ts`),
 * and Telegram truncates a `callback_data` over 64 bytes in silence — the button then does
 * nothing. That budget is asserted at import against a handle generated HERE, so a change to
 * `HANDLE_BYTES` or the prefix is measured the moment it is made instead of being discovered by a
 * customer whose Place order button stopped working.
 */
export function newInAppHandle(): string {
    return `${HANDLE_PREFIX}${randomBytes(HANDLE_BYTES).toString('base64url')}`;
}

const handleKey = (handle: string): string => `bot:inapp:${digestForKey(handle)}`;

/**
 * Read-and-delete in one atomic step.
 *
 * ⚠ **`GETDEL` is NOT usable on this platform** — it landed in Redis 6.2 and the development
 * Redis here is 3.0, where it is an unknown command: a hard failure on the first checkout, on
 * a server that is otherwise fine. It must also never become a `get` then a `del`: two
 * concurrent submits would both see a live handle and both place an order. Copied from
 * `geo-candidate.store.ts`, which was bitten by exactly this once already.
 */
const CONSUME_SCRIPT = `
local value = redis.call("get", KEYS[1])
if value then
  redis.call("del", KEYS[1])
end
return value`;

/** Who the session belongs to and where it came from. Identical across all five kinds. */
interface InAppSessionBase {
    /** The `users` row. Matched on every read — a handle belongs to one account. */
    owner: string;
    /** The `customers` row, so a write from the page needs no second lookup. */
    customerId: string;
    channel: MessagingChannel;
    /** The conversation. A reply built from this session can be addressed nowhere else. */
    externalId: string;
    language: string | null;
    /**
     * ⚠ **The authority on whether this session is still live**, above the Redis TTL — the
     * rule `product-display.store.ts` states and for the same reason: a restored dump, a
     * replica with a skewed clock or an `EX` that did not take must not resurrect a checkout
     * quoting last month's prices.
     */
    expiresAt: string;
}

/**
 * What a listing screen pages over.
 *
 * ⚠ **The QUERY, not a list of ids — and this is the opposite of `ProductDisplaySet`,
 * deliberately.** That store holds the ten ids the *model* chose, precisely so that page two
 * cannot re-run a search and quietly return different products at different prices. A listing
 * screen is not that: it is a grid a customer scrolls, it must page past ten, and
 * `BOT_DISPLAY_MAX_PRODUCTS` would make it look broken at row eleven. So it holds the query
 * and pages server-side against `publicCatalogService.listProducts`.
 *
 * Both doctrines are right for their surface. Do not "unify" them.
 *
 * Mirrors the fields of `PublicProductListQuery` this surface actually offers, declared
 * locally so the store does not depend on the catalog module's shape.
 */
export interface InAppListingQuery {
    q?: string | null;
    category?: string | null;
    storeSlug?: string | null;
    /** Product ids to pin, for a wishlist or a model-chosen set rendered as a grid. */
    productIds?: string[] | null;
}

export type InAppSurfaceSession =
    | (InAppSessionBase & { kind: 'pl'; query: InAppListingQuery })
    | (InAppSessionBase & { kind: 'pd'; productId: string })
    | (InAppSessionBase & { kind: 'ol' })
    | (InAppSessionBase & { kind: 'sl'; query: { q?: string | null; city?: string | null } })
    /**
     * ⚠ **`cartId` is null until the basket is read, and the session never holds prices.**
     * A checkout screen must quote live money — a held total is a total that can disagree
     * with the cart by the time somebody pays.
     */
    | (InAppSessionBase & { kind: 'co'; cartId: string | null })
    /**
     * The support form. Every member is nullable because the form is reached from three
     * doors — a bare "I need help", a button on one order, and a photo the customer has just
     * sent — and each knows a different amount. What it carries is what PRE-FILLS the screen;
     * the ticket itself is written from what the customer submits.
     *
     * ⚠ **A `tf` handle authorises ONE submit** (`consume`, not `read`, on that route), so a
     * double tap cannot open two tickets. Reading the form is repeatable.
     */
    | (InAppSessionBase & {
          kind: 'tf';
          form: {
              orderId: string | null;
              topic: 'rd' | 'ad' | 'hp' | null;
              attachmentRef: string | null;
          };
      })
    /** The customer's own appointments. Base fields only, exactly like `ol`; it writes nothing. */
    | (InAppSessionBase & { kind: 'bl' })
    /**
     * Pick a time and confirm. `bookingId` null means a NEW booking; set means moving that one.
     *
     * ⚠ **The handle authorises ONE booking or ONE move** — `consume` on the confirm, so a
     * double tap cannot take two slots. Reading the picker stays repeatable.
     */
    | (InAppSessionBase & { kind: 'bk'; productId: string; bookingId: string | null })
    /**
     * Pay a booking's deposit or its balance.
     *
     * ⛔ **It holds NO amount, deliberately.** The figure is re-resolved at pay, so a held one
     * can never disagree with what is charged — the same rule that keeps prices off the
     * checkout session.
     */
    | (InAppSessionBase & { kind: 'bp'; bookingId: string; purpose: 'primary' | 'balance' });

/** What `mint` is given: everything but the expiry, which only this store may set. */
export type InAppSessionInput =
    | Omit<Extract<InAppSurfaceSession, { kind: 'pl' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'pd' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'ol' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'sl' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'co' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'tf' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'bl' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'bk' }>, 'expiresAt'>
    | Omit<Extract<InAppSurfaceSession, { kind: 'bp' }>, 'expiresAt'>;

const unexpired = (expiresAt: string): boolean => {
    const at = Date.parse(expiresAt);
    return Number.isFinite(at) && at > Date.now();
};

export class InAppSurfaceStore {
    /** Persist a session and return the handle that opens it. */
    async mint(input: InAppSessionInput): Promise<string> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const ttl = TTL_SECONDS[input.kind];
        const handle = newInAppHandle();
        const record = {
            ...input,
            expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        } as InAppSurfaceSession;

        await redis.set(handleKey(handle), JSON.stringify(record), { EX: ttl });
        return handle;
    }

    /**
     * Read a session, refusing an unknown, lapsed, wrong-owner OR **wrong-kind** handle alike.
     *
     * ⚠ **The kind check is the point of this method's signature.** Without it a `pl` handle —
     * which is handed out freely, appears in a chat and may be forwarded — would open the
     * checkout endpoint. Naming the expected kind at the call site makes that impossible by
     * construction rather than by a guard somebody can forget, and the generic return type
     * means the caller gets the narrowed session with no cast.
     *
     * One refusal bucket, as `GeoCandidateStore.consume` does and for the same reason: all
     * four failures have the same remedy — go back to the chat and tap again — and
     * distinguishing them would confirm to a caller that a handle it does not own is real.
     *
     * ⚠ **Repeatable, NOT single-use.** A page reads on every open and every refresh. The one
     * write that must not repeat uses `consume` instead.
     */
    async read<K extends InAppSurfaceKind>(
        kind: K,
        handle: string,
    ): Promise<Extract<InAppSurfaceSession, { kind: K }> | null> {
        const record = await this.load(handle);
        if (!record || record.kind !== kind) return null;
        return record as Extract<InAppSurfaceSession, { kind: K }>;
    }

    /**
     * Spend a handle — read it and delete it in one atomic step.
     *
     * ⚠ **This is what stops a double-tap placing two orders.** The screen reads its session
     * with `read` as many times as it likes while the customer fills it in; the submit that
     * actually creates the order calls this, so a retried POST, a refreshed tab and a
     * forwarded URL all find the handle gone. `Idempotency-Key` guards the bot surface's own
     * routes, but this mount has no such header — a browser sends what the page sends.
     *
     * ⚠ **Spent even when the caller then fails.** That is the safe direction: a customer who
     * loses a checkout re-taps and gets a fresh screen, whereas a handle that survived a
     * partial failure is a handle that can place the order twice.
     */
    async consume<K extends InAppSurfaceKind>(
        kind: K,
        handle: string,
    ): Promise<Extract<InAppSurfaceSession, { kind: K }> | null> {
        if (!handle.startsWith(HANDLE_PREFIX)) return null;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = (await redis.eval(CONSUME_SCRIPT, { keys: [handleKey(handle)] })) as
            | string
            | null;

        const record = this.parse(raw);
        if (!record || record.kind !== kind || !unexpired(record.expiresAt)) return null;
        return record as Extract<InAppSurfaceSession, { kind: K }>;
    }

    /**
     * Extend a session's life without re-minting it.
     *
     * ⚠ **Refuses `co` outright.** Sliding a checkout credential's expiry defeats the whole
     * reason it has a short one — a page left open would keep an order-placing handle alive
     * indefinitely. A listing, by contrast, is worth keeping while somebody scrolls.
     *
     * ⚠ **Moves the Redis TTL and the recorded expiry TOGETHER**, unlike
     * `ProductDisplayStore.advance`, which deliberately refreshes only the TTL because paging
     * a held list must not extend the prices it quotes. Here there are no held prices — the
     * screen re-reads live on every page — so the two may move as one, and leaving them to
     * disagree would make `expiresAt` the thing that silently kills a live session.
     */
    /**
     * ⚠ **`co`, `bk` and `bp` are excluded, and each for its own reason.** A checkout and a
     * booking payment are credentials that move money, so their ten minutes must be ten
     * minutes. A booking PICKER is excluded for a different reason that matters just as much:
     * a slot picker whose life renews while somebody stares at it is an open-ended hold on a
     * shop's calendar, and the expiry is what gives the time back to other customers.
     */
    async touch(kind: Exclude<InAppSurfaceKind, 'co' | 'bk' | 'bp'>, handle: string): Promise<boolean> {
        const record = await this.load(handle);
        if (!record || record.kind !== kind) return false;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const ttl = TTL_SECONDS[kind];
        const renewed = {
            ...record,
            expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        };
        await redis.set(handleKey(handle), JSON.stringify(renewed), { EX: ttl });
        return true;
    }

    /** Shared read path: prefix, fetch, parse, expiry. The kind check belongs to the caller. */
    private async load(handle: string): Promise<InAppSurfaceSession | null> {
        if (!handle.startsWith(HANDLE_PREFIX)) return null;

        const redis = await getRedisClient(BOT_SURFACE_DB);
        const record = this.parse(await redis.get(handleKey(handle)));
        if (!record || !unexpired(record.expiresAt)) return null;
        return record;
    }

    private parse(raw: string | null): InAppSurfaceSession | null {
        if (!raw) return null;
        try {
            return JSON.parse(raw) as InAppSurfaceSession;
        } catch {
            // A key we wrote that we cannot read is our bug, not a caller's. Logged rather
            // than thrown: the customer's remedy is to tap again either way.
            console.error('[BotSurface] malformed in-app surface session');
            return null;
        }
    }
}

export const inAppSurfaceStore = new InAppSurfaceStore();

/** ⚠ Exported for the suites, which assert the prefix against `bot-action-id.ts`'s surfaces. */
export const __IN_APP_HANDLE_PREFIX = HANDLE_PREFIX;
