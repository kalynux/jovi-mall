/**
 * Live verification of the curated bot surface — NEEDS Redis and Mongo.
 *
 * The DB-free `test:bot-surface` pins the route table to the catalogue, drives both Redis
 * stores against a fake, and scans the structural invariants. Six things it structurally
 * cannot cover, and they are the ones that bite:
 *
 *   1. **The two guards are really wired, in the right order, on the real mount.** A source
 *      scan proves the `router.use` lines are in the file; only a real request proves the
 *      router is reachable at `/api/internal/bot` and that a missing credential is a 401
 *      rather than a 404 from an unmounted path.
 *   2. **The Express route table really resolves literals before parameters.** The pure
 *      matcher agrees with itself by construction. Express is the thing that actually
 *      dispatches, and `/orders/list` arriving at `orders_get_order` would be invisible to
 *      every DB-free assertion — this service has been bitten by route order twice.
 *   3. **The resolver runs against a REAL `users` collection**, so the bare-digits E.164
 *      repair genuinely runs `findByPhone`. Without it the surface answers "no account" to
 *      everybody while looking perfectly implemented.
 *   4. **The idempotency claim is atomic against a REAL Redis.** A fake `eval` and a fake
 *      `SET NX` are promises about semantics; this is the check that caught `GETDEL` being
 *      unavailable on Redis 3.0 for the connection codes, which no source scan could have.
 *   5. **A retried checkout really does not create a second set of orders.** That is the
 *      whole reason GAP-001 makes idempotency mandatory, and it is only true end to end.
 *   6. **A DELETE really carries its body through Express**, which is the one route shape
 *      on this surface that some HTTP stacks drop.
 *
 * Read-mostly: it writes its own `verify-bot-*` fixtures and removes them, pass or fail, in
 * the same shape as `verify:messaging-login` and `verify:connections`.
 *
 * Run: npm run verify:bot-surface
 */
import http from 'http';
import { randomBytes } from 'crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// `getJwtSecret()` fails closed, and the module graph asserts signing secrets at import of
// some paths. A developer running this against a local stack should not need a fully
// populated `.env` for the HTTP leg to work.
process.env.JWT_SECRET ||= 'verify-secret-for-bot-surface-suite';
process.env.JWT_REFRESH_SECRET ||= 'verify-refresh-secret-for-bot-surface-suite';

/**
 * Both credentials, forced to known values BEFORE the module graph loads.
 *
 * `requireServiceToken` reads `AGENT_CONFIG.INTERNAL_SERVICE_TOKEN`, which is captured at
 * import. Setting these after the import would leave the guard comparing against whatever
 * the developer's `.env` holds — and the suite would pass or fail on their configuration
 * rather than on this code.
 */
process.env.INTERNAL_SERVICE_TOKEN ||= 'verify-bot-surface-service-token';
process.env.BOT_WEBHOOK_SECRET = 'verify-bot-surface-webhook-secret';
const SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const WEBHOOK_SECRET = process.env.BOT_WEBHOOK_SECRET;

import { app } from '../src/app';
import { UserModel } from '../src/modules/users/user.model';
import { CustomerModel } from '../src/modules/customers/customer.model';
import { ChannelConnectionModel } from '../src/modules/channel-connections/channel-connection.model';
import { OrderModel } from '../src/modules/orders/order.model';
import { StoreModel } from '../src/modules/store/models/store.model';
import { AgencyMagazinModel } from '../src/modules/magazin/models/magazin.model';
import { ShipmentModel } from '../src/modules/shipments/shipment.model';
import { PaymentTransactionModel } from '../src/modules/payments/models/payment-transaction.model';
import { WhatsappService } from '../src/modules/whatsapp/whatsapp.service';
import { CustomerNotificationModel } from '../src/modules/notifications/models/customer-notification.model';
import { TicketModel } from '../src/modules/tickets/models/ticket.model';
import { TicketAttachmentModel } from '../src/modules/tickets/models/ticket-attachment.model';
import { TicketFollowerModel } from '../src/modules/tickets/models/ticket-follower.model';
import { FileModel } from '../src/modules/catalog/models/file.model';
import { FileReferenceModel } from '../src/modules/catalog/models/file-reference.model';
import { geoCandidateStore } from '../src/modules/bot-surface/services/geo-candidate.store';
import { botIdempotencyStore } from '../src/modules/bot-surface/services/bot-idempotency.store';
import { BOT_ROUTES } from '../src/modules/bot-surface/domain/bot-route-table';
import {
    closeRedisClients,
    getRedisClient,
    BOT_SURFACE_DB,
    WA_WINDOW_DB,
} from '../src/infra/redis/redis.factory';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
    try {
        const ok = await fn();
        if (ok) {
            console.log(`  ✅ ${name}`);
            passed++;
        } else {
            console.error(`  ❌ FAIL: ${name}`);
            failed++;
        }
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
    }
}

function section(title: string): void {
    console.log(`\n▶ ${title}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Stored in strict E.164, exactly as a real registration writes it …
const STORED_PHONE = '+237600000287';
// … and delivered by Meta as bare digits. The gap between these two lines IS assertion 3.
const WA_PHONE_ID = '237600000287';
/** A vendor: an account with no customer role, for the `not_customer` refusal. */
const VENDOR_PHONE = '+237600000286';
const VENDOR_WA_PHONE_ID = '237600000286';
/** Belongs to nobody. */
const UNKNOWN_WA_PHONE_ID = '237600000285';
const TELEGRAM_CHAT_ID = 'verify-bot-tg-80001';

/**
 * FIXED ids, not fresh ones.
 *
 * A run that is interrupted — Ctrl-C, a timeout, a crash before the `finally` — leaves its
 * fixtures behind, and fresh ids make the leftovers unreachable by the next run's cleanup:
 * it deletes ids nobody wrote and then collides on the unique `login_phone` index. Fixed
 * ids make cleanup idempotent across runs, which is the property that matters for a suite
 * people will interrupt. The phones are deleted too, so a row written by an older version
 * of this file is still swept.
 */
const USER_ID = new mongoose.Types.ObjectId('60700000000000000000b287');
const CUSTOMER_ID = new mongoose.Types.ObjectId('60700000000000000000c287');
const VENDOR_USER_ID = new mongoose.Types.ObjectId('60700000000000000000b286');

/** GAP-004's fixtures: one order with one parcel, its seller and its delivery company. */
const SUPPORT_VENDOR_ID = new mongoose.Types.ObjectId('60700000000000000000d287');
const SUPPORT_STORE_ID = new mongoose.Types.ObjectId('60700000000000000000d288');
const SUPPORT_AGENCY_ID = new mongoose.Types.ObjectId('60700000000000000000d289');
const SUPPORT_MAGAZIN_ID = new mongoose.Types.ObjectId('60700000000000000000d28a');
const SUPPORT_ORDER_ID = new mongoose.Types.ObjectId('60700000000000000000d28b');
const SUPPORT_SHIPMENT_ID = new mongoose.Types.ObjectId('60700000000000000000d28c');
const SUPPORT_ORDER_NUMBER = 'ORD-VERIFY-BOT-000287';
const SUPPORT_STORE_SLUG = 'verify-bot-maison';

// The hosted card page (GAP-008). Two transactions: one card, one mobile money, so the
// gateway refusal is exercised against a real row rather than asserted about the predicate.
const CARD_TX_ID = new mongoose.Types.ObjectId('60700000000000000000e287');
const MOMO_TX_ID = new mongoose.Types.ObjectId('60700000000000000000e288');
const CARD_CLIENT_SECRET = 'pi_verify_bot_secret_287';

let server: http.Server | null = null;
let base = '';

/**
 * ⚠ **Every idempotency key this run spends is namespaced to THIS RUN**, and that is a
 * correctness requirement rather than tidiness.
 *
 * The keys were fixed literals (`verify-address-1`) at first, and the second run of the suite
 * failed on five assertions with `BOT_IDEMPOTENCY_KEY_REUSED` — correctly. A completed record
 * lives 24 hours and is keyed on `(scope, key, request FINGERPRINT)`, and the fingerprint moves
 * between runs because half these calls carry a freshly minted `geoCandidateRef`. So run two
 * presented run one's key with a different body, which is exactly the caller bug that refusal
 * exists to catch.
 *
 * A per-run nonce removes the collision at the source. The records left behind expire on their
 * own, which is why this is better than reproducing the middleware's scope rule in `cleanup`:
 * that rule is `botIdempotencyScopeOf`'s to own, it has already changed once, and a test that
 * copies it is a test that goes quietly stale when it changes again.
 */
const RUN = randomBytes(4).toString('hex');
const idem = (name: string): string => `verify-${RUN}-${name}`;

type Json = Record<string, unknown>;

interface BotResponse {
    status: number;
    body: Json;
    replayed: boolean;
}

/**
 * One call on the bot surface, with both credentials attached.
 *
 * `identity` is merged into the body here rather than by each caller, because that is what
 * the transport does in production — the automation layer derives it from the inbound
 * webhook and never from anything the customer typed.
 */
async function call(
    method: string,
    path: string,
    args: Json = {},
    options: {
        identity?: Json | null;
        idempotencyKey?: string;
        serviceToken?: string | null;
        webhookSecret?: string | null;
    } = {},
): Promise<BotResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const token = options.serviceToken === undefined ? SERVICE_TOKEN : options.serviceToken;
    if (token !== null) headers.Authorization = `Bearer ${token}`;

    const secret = options.webhookSecret === undefined ? WEBHOOK_SECRET : options.webhookSecret;
    if (secret !== null) headers['X-Webhook-Secret'] = secret;

    if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const identity = options.identity === undefined
        ? { channel: 'whatsapp', externalId: WA_PHONE_ID }
        : options.identity;

    const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: JSON.stringify(identity === null ? args : { identity, ...args }),
    });

    return {
        status: res.status,
        body: (await res.json().catch(() => ({}))) as Json,
        replayed: res.headers.get('Idempotency-Replayed') === 'true',
    };
}

function errorCode(response: BotResponse): string | null {
    const error = response.body.error as { code?: string } | undefined;
    return error?.code ?? null;
}

function errorDetails(response: BotResponse): Json {
    const error = response.body.error as { details?: Json } | undefined;
    return error?.details ?? {};
}

async function seed(): Promise<void> {
    await UserModel.create({
        _id: USER_ID,
        login_phone: STORED_PHONE,
        password_hash: 'verify-bot-surface-not-a-real-hash',
        roles: ['customer'],
        status: 'active',
    });
    await CustomerModel.create({
        _id: CUSTOMER_ID,
        user_id: USER_ID,
        name: 'Verify BotSurface',
        phone: STORED_PHONE,
        preferences: { language: 'en', currency: 'XAF' },
    });
    await UserModel.create({
        _id: VENDOR_USER_ID,
        login_phone: VENDOR_PHONE,
        password_hash: 'verify-bot-surface-not-a-real-hash',
        roles: ['vendor'],
        status: 'active',
    });
}

async function cleanup(): Promise<void> {
    // By id AND by phone. The id sweep is precise; the phone sweep catches a row an older
    // version of this file wrote under a different id, which is what a unique index turns
    // into a crash on the next run rather than a stale document nobody notices.
    await Promise.allSettled([
        UserModel.deleteMany({
            $or: [
                { _id: { $in: [USER_ID, VENDOR_USER_ID] } },
                { login_phone: { $in: [STORED_PHONE, VENDOR_PHONE] } },
            ],
        }),
        CustomerModel.deleteMany({ $or: [{ _id: CUSTOMER_ID }, { phone: STORED_PHONE }] }),
        // The resolver BINDS on success, so this run writes connection rows it must remove.
        ChannelConnectionModel.deleteMany({
            $or: [
                { user_id: { $in: [USER_ID, VENDOR_USER_ID] } },
                { external_id: { $in: [WA_PHONE_ID, VENDOR_WA_PHONE_ID, TELEGRAM_CHAT_ID] } },
            ],
        }),
        OrderModel.deleteMany({ customer_id: CUSTOMER_ID }),
        // GAP-004's world. By id AND by the natural key, for the same reason as above: an
        // interrupted run that wrote a row under an older id must still be swept, or the
        // unique `slug` on stores turns it into a crash on the next run.
        StoreModel.deleteMany({ $or: [{ _id: SUPPORT_STORE_ID }, { slug: SUPPORT_STORE_SLUG }] }),
        AgencyMagazinModel.deleteMany({ $or: [{ _id: SUPPORT_MAGAZIN_ID }, { agency_id: SUPPORT_AGENCY_ID }] }),
        OrderModel.deleteMany({ order_number: SUPPORT_ORDER_NUMBER }),
        ShipmentModel.deleteMany({ $or: [{ _id: SUPPORT_SHIPMENT_ID }, { order_id: SUPPORT_ORDER_ID }] }),
        // GAP-008's two transactions. Also by `userId`, so a row an interrupted run wrote
        // under a different id is swept too — `idempotencyKey` is UNIQUE on this collection,
        // so a survivor is a crash on the next run rather than a stale document.
        PaymentTransactionModel.deleteMany({
            $or: [{ _id: { $in: [CARD_TX_ID, MOMO_TX_ID] } }, { userId: CUSTOMER_ID }],
        }),
        // GAP-012's hand-off leaves a durable in-app row — the thing § 11 reads back to
        // prove the situation actually reached the notification stack.
        CustomerNotificationModel.deleteMany({ customerId: CUSTOMER_ID }),
        // Step 7b's world. The ticket is created THROUGH the API rather than planted, so
        // its id is not known here — sweep by the author, which is this run's customer.
        // The attachment rows, the follower rows and the `file_references` are children of
        // that ticket and are swept with it; the `files` rows are swept by their owner.
        TicketModel.deleteMany({ created_by_user_id: USER_ID }),
        TicketFollowerModel.deleteMany({ user_id: USER_ID }),
        TicketAttachmentModel.deleteMany({ uploaded_by_user_id: USER_ID }),
        FileReferenceModel.deleteMany({ entityType: 'ticket', ownerId: CUSTOMER_ID.toString() }),
        FileModel.deleteMany({ ownerType: 'customer', ownerId: CUSTOMER_ID }),
    ]);

    // Idempotency records are NOT swept here. They are namespaced to this run (see RUN
    // above), so they can never collide with another one, and they expire on their own.
    // A sweep would have to reproduce the middleware's scope rule — which has already
    // changed once and is not this file's to know.

    /**
     * ⚠ **The WhatsApp service-window key IS swept, unlike the idempotency records**, and the
     * difference is its lifetime: 23 hours, under ONE fixed key derived from the fixture
     * phone. § 11 asserts that a sender with no inbound traffic reports the window CLOSED,
     * and § 11's own next assertion opens it — so without this sweep the suite passes on its
     * first run of the day and fails on every one after, for a leftover this file wrote.
     * (Measured: that is exactly how it failed.)
     */
    await getRedisClient(WA_WINDOW_DB)
        .then((redis) => redis.del(`open_chat_window:${WA_PHONE_ID}`))
        .catch(() => undefined);
}

async function main(): Promise<void> {
    console.log('\n═══ verify:bot-surface (NEEDS Mongo + Redis) ═══════════════════════════════\n');

    await mongoose.connect(process.env.MONGO_URI as string);
    await cleanup();
    await seed();

    const listening = app.listen(0);
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;

    try {
        // ═════════════════════════════════════════════════════════════════════
        section('1 · The mount, and the two credentials');
        // ═════════════════════════════════════════════════════════════════════

        await assert('the surface is REACHABLE — a good call is not a 404', async () => {
            const res = await call('POST', '/api/internal/bot/identity/resolve');
            return res.status === 200;
        });

        await assert('no service token → 401, and the customer surface stays shut', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, { serviceToken: null });
            return res.status === 401;
        });

        await assert('a WRONG service token → 401', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, { serviceToken: 'not-the-token' });
            return res.status === 401;
        });

        await assert('⚠ the service token ALONE is not enough — the webhook secret is required too', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, { webhookSecret: null });
            return res.status === 401 && errorCode(res) === 'WEBHOOK_SECRET_INVALID';
        });

        await assert('a WRONG webhook secret → 401', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, { webhookSecret: 'wrong' });
            return res.status === 401 && errorCode(res) === 'WEBHOOK_SECRET_INVALID';
        });

        await assert('the credentials are checked BEFORE the identity — an anonymous caller learns nothing', async () => {
            // No token AND an identity that would resolve. The answer must be the token
            // refusal, not anything about whether that account exists.
            const res = await call('POST', '/api/internal/bot/cart/get', {}, { serviceToken: null });
            return res.status === 401 && errorCode(res) !== 'BOT_IDENTITY_UNRESOLVED';
        });

        // ═════════════════════════════════════════════════════════════════════
        section('2 · Identity resolution against a REAL users collection');
        // ═════════════════════════════════════════════════════════════════════

        await assert('⚠ a BARE-DIGITS wa_phone_id resolves an account stored as +237…', async () => {
            const res = await call('POST', '/api/internal/bot/identity/resolve');
            const data = res.body.data as Json | undefined;
            return res.status === 200
                && data?.isCustomer === true
                && data?.displayName === 'Verify BotSurface'
                && data?.state === 'customer';
        });

        await assert('the resolve answer carries the HINT and never the identity', async () => {
            const res = await call('POST', '/api/internal/bot/identity/resolve');
            const json = JSON.stringify(res.body);
            return json.includes('••••0287') && !json.includes(WA_PHONE_ID);
        });

        await assert('the connection was PERSISTED, so the fast path serves the next call', async () => {
            const row = await ChannelConnectionModel.findOne({ channel: 'whatsapp', external_id: WA_PHONE_ID });
            return row !== null && row.user_id.toString() === USER_ID.toString();
        });

        await assert('an unknown number → 404 BOT_IDENTITY_UNRESOLVED, state anonymous', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, {
                identity: { channel: 'whatsapp', externalId: UNKNOWN_WA_PHONE_ID },
            });
            return res.status === 404
                && errorCode(res) === 'BOT_IDENTITY_UNRESOLVED'
                && errorDetails(res).state === 'anonymous';
        });

        /**
         * ⚠ `details` is deliberately ABSENT here, and asserting so is the point.
         *
         * The service writes `{ state, reason }` on every identity refusal, and Phase 16's
         * boundary filters by category: `BOT_IDENTITY_NOT_CUSTOMER` is `authorization`, whose
         * allowlist admits `required` / `requiredAny` / `resource` / `hint` and nothing else —
         * because an authorization failure that echoes facts about the caller is the leak that
         * allowlist exists to close. Nothing is lost: the CODE is the whole signal here, and
         * `reason` is precisely the field the refusal table refuses to disclose anyway
         * (`not_customer` and `identity_taken` collapse on purpose). The 404 and the 409 DO
         * carry `state`, which is what the registration flow reads — asserted above.
         */
        await assert('⚠ a VENDOR is refused — a customer role is never auto-provisioned', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, {
                identity: { channel: 'whatsapp', externalId: VENDOR_WA_PHONE_ID },
            });
            return res.status === 403
                && errorCode(res) === 'BOT_IDENTITY_NOT_CUSTOMER'
                && Object.keys(errorDetails(res)).length === 0;
        });

        await assert('a refused vendor is NOT bound — a refusal writes no durable claim', async () => {
            const row = await ChannelConnectionModel.findOne({ channel: 'whatsapp', external_id: VENDOR_WA_PHONE_ID });
            return row === null;
        });

        await assert('an unbound TELEGRAM chat → 409 BOT_IDENTITY_NEEDS_CONTACT', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, {
                identity: { channel: 'telegram', externalId: TELEGRAM_CHAT_ID },
            });
            return res.status === 409 && errorCode(res) === 'BOT_IDENTITY_NEEDS_CONTACT';
        });

        await assert('⚠ a caller-supplied customerId is a 400, never an impersonation', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, {
                identity: { channel: 'whatsapp', externalId: WA_PHONE_ID, customerId: '68f0000000000000000000aa' },
            });
            return res.status === 400;
        });

        await assert('a missing envelope is a 400, not a 500', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get', {}, { identity: null });
            return res.status === 400;
        });

        // ═════════════════════════════════════════════════════════════════════
        section('3 · Express really dispatches the table — literals before parameters');
        // ═════════════════════════════════════════════════════════════════════

        await assert('POST /orders/list is the LIST, not an order whose id is "list"', async () => {
            const res = await call('POST', '/api/internal/bot/orders/list', { limit: 5 });
            return res.status === 200 && Array.isArray(res.body.data);
        });

        await assert('the chat page default is 5, not the customer API\'s 20', async () => {
            const res = await call('POST', '/api/internal/bot/orders/list');
            const meta = res.body.meta as { limit?: number } | undefined;
            return res.status === 200 && meta?.limit === 5;
        });

        await assert('POST /orders/<unknown id> reaches the DETAIL route and 404s honestly', async () => {
            const res = await call('POST', '/api/internal/bot/orders/68f0000000000000000000aa');
            return res.status === 404 && errorCode(res) === 'ORDER_NOT_FOUND';
        });

        await assert('POST /tickets/list is the LIST, not a ticket id', async () => {
            const res = await call('POST', '/api/internal/bot/tickets/list');
            return res.status === 200 && Array.isArray(res.body.data);
        });

        /**
         * ⚠ **This asserted `meta === undefined` until 2026-09-06, and the change that broke
         * it was an ADDITION rather than the tidy-up it was written to catch.**
         *
         * What it exists to pin is the documented deviation: the three ticket tools answer
         * `{ success, data, pagination }` because that is the ticket module's shape on every
         * role's mount, and renaming that key would silently break a caller reading it.
         * That still holds and is asserted below.
         *
         * What changed is that every list now carries the chat window (`shown` / `hasMore` /
         * `moreUrl`), and it goes under `meta` on all of them — so a client never has to know
         * which tool puts it where. Both keys are present here; `data` is untouched.
         *
         * So the assertion is now BOTH facts rather than an exclusion, which is strictly
         * stronger: a future tidy-up that dropped `pagination` would still fail it.
         */
        await assert('tickets keep `pagination` AND carry the chat window in `meta`', async () => {
            const res = await call('POST', '/api/internal/bot/tickets/list');
            const meta = res.body.meta as { hasMore?: unknown; shown?: unknown } | undefined;
            return res.body.pagination !== undefined
                && meta !== undefined
                && typeof meta.hasMore === 'boolean'
                && typeof meta.shown === 'number';
        });

        await assert('POST /bookings/list is the LIST, not a booking id', async () => {
            const res = await call('POST', '/api/internal/bot/bookings/list');
            return res.status === 200 && Array.isArray(res.body.data);
        });

        /**
         * ⚠ **`/bookings/availability` is a LITERAL sitting among the `:bookingId` rows**,
         * and it is the real shadowing case rather than the habitual one: both it and
         * `/bookings/:bookingId` are two segments under the same prefix, so whichever is
         * declared first wins. Reaching the wrong one does not error in a way anybody would
         * notice from a table — `bookings_get` would refuse the literal `availability` as a
         * malformed ObjectId with a `400`, which reads as "the model sent a bad argument".
         * A `404 CATALOG_BOOKING_PRODUCT_NOT_FOUND` is proof the availability handler ran.
         */
        await assert('⚠ POST /bookings/availability is the LITERAL, not a booking id', async () => {
            const res = await call('POST', '/api/internal/bot/bookings/availability', {
                productId: '68f0000000000000000000aa',
            });
            return res.status === 404 && errorCode(res) === 'CATALOG_BOOKING_PRODUCT_NOT_FOUND';
        });

        await assert('availability defaults its window rather than demanding two ISO dates', async () => {
            // The customer API 400s without fromDate and toDate. Reaching the product lookup
            // at all — a 404 rather than a validation error — is what proves the default ran.
            const res = await call('POST', '/api/internal/bot/bookings/availability', {
                productId: '68f0000000000000000000aa',
            });
            return res.status === 404;
        });

        /**
         * ⚠ **`POST /bookings` is the CREATE and `POST /bookings/list` is the list.** One
         * segment against two, so they cannot collide — but a create reached by mistake
         * writes an appointment, which is the one dispatch error on this surface with a
         * consequence in somebody's calendar. Pinned by its own failure mode.
         */
        await assert('⚠ POST /bookings reaches CREATE, not the list', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/bookings',
                { productId: '68f0000000000000000000aa', slotId: 'slot_1757494800000_1757498400000' },
                { idempotencyKey: idem('booking-create-404') },
            );
            // The list would answer 200 with an array. Create takes the slot hold, fails to
            // find the product, and releases it.
            return res.status === 404 && errorCode(res) === 'CATALOG_BOOKING_PRODUCT_NOT_FOUND';
        });

        /**
         * ⚠ **The hold must not survive a failed create.** The customer API releases only on
         * its success path, so a failure there leaves a dead hold on the slot for the rest of
         * its fifteen minutes. This surface releases in a `finally` — and the proof is that
         * the SAME slot can be attempted again immediately: a surviving hold would answer
         * `409 BOOKING_SLOT_LOCKED` on the second call instead of the same 404.
         */
        await assert('⚠ a failed create RELEASES the slot hold — the next attempt is not 409', async () => {
            const body = {
                productId: '68f0000000000000000000aa',
                slotId: 'slot_1757581200000_1757584800000',
            };
            const first = await call('POST', '/api/internal/bot/bookings', body, {
                idempotencyKey: idem('booking-release-1'),
            });
            const second = await call('POST', '/api/internal/bot/bookings', body, {
                idempotencyKey: idem('booking-release-2'),
            });
            return first.status === 404
                && second.status === 404
                && errorCode(second) !== 'BOOKING_SLOT_LOCKED';
        });

        await assert('POST /bookings/<unknown>/balance reaches the balance route', async () => {
            const res = await call('POST', '/api/internal/bot/bookings/68f0000000000000000000aa/balance');
            return res.status === 404 && errorCode(res) === 'BOOKING_NOT_FOUND';
        });

        await assert('POST /bookings/<unknown>/payment-status reaches its own route', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/bookings/68f0000000000000000000aa/payment-status',
            );
            return res.status === 404 && errorCode(res) === 'BOOKING_NOT_FOUND';
        });

        /**
         * Ownership is checked BEFORE a gateway is touched, so an unknown booking is a 404
         * rather than a payment error — which is what keeps a stranger's id from reaching
         * NotchPay at all.
         */
        await assert('⚠ POST /bookings/<unknown>/pay 404s before any gateway is called', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/bookings/68f0000000000000000000aa/pay',
                { gateway: 'NOTCHPAY', phoneNumber: '+237600124417', phoneOperator: 'MTN' },
                { idempotencyKey: idem('booking-pay-404') },
            );
            return res.status === 404 && errorCode(res) === 'BOOKING_NOT_FOUND';
        });

        await assert('POST /bookings/<unknown>/pay-balance is its own route, not /pay', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/bookings/68f0000000000000000000aa/pay-balance',
                { gateway: 'NOTCHPAY', phoneNumber: '+237600124417', phoneOperator: 'MTN' },
                { idempotencyKey: idem('booking-pay-balance-404') },
            );
            return res.status === 404 && errorCode(res) === 'BOOKING_NOT_FOUND';
        });

        /**
         * ⚠ **Ownership before the hold.** Rescheduling a stranger's booking is a 404 either
         * way — but taking a slot hold before finding that out would let any unrelated id
         * lock somebody else's appointment time for fifteen minutes. A 404 with no
         * `BOOKING_SLOT_*` code anywhere is what says the ownership read ran first.
         */
        await assert('⚠ PATCH /bookings/<unknown>/reschedule 404s BEFORE taking a hold', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/bookings/68f0000000000000000000aa/reschedule',
                { slotId: 'slot_1757667600000_1757671200000' },
                { idempotencyKey: idem('booking-reschedule-404') },
            );
            return res.status === 404 && errorCode(res) === 'BOOKING_NOT_FOUND';
        });

        await assert('a booking payment refuses mobile money with no number, at the door', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/bookings/68f0000000000000000000aa/pay',
                { gateway: 'NOTCHPAY' },
                { idempotencyKey: idem('booking-pay-nonumber') },
            );
            // 400 rather than the 404 above: the body is refused before the booking is read.
            return res.status === 400;
        });

        await assert('POST /bookings/list still carries the chat window after the projection', async () => {
            const res = await call('POST', '/api/internal/bot/bookings/list');
            const meta = res.body.meta as { shown?: unknown; hasMore?: unknown } | undefined;
            return res.status === 200
                && Array.isArray(res.body.data)
                && typeof meta?.shown === 'number'
                && typeof meta?.hasMore === 'boolean';
        });

        /**
         * ⚠ **The two route families added by the MCP parity plan, and both are the shape
         * this suite exists for.** A DB-free assertion sees the table; only Express can say
         * which handler a path actually reaches, and this service has been bitten by route
         * order twice — `/articles/index` behind `/articles/:slug`, `/orders/groups/:cartId`
         * behind `/orders/:id`.
         *
         *   `/addresses/:addressId`          beside `/addresses/:addressId/default`
         *   `/notifications/read-all`        beside `/notifications/:notificationId/read`
         *                                    and `/notifications/preferences`
         *
         * Each is asserted by its OWN failure mode: a route that reached the wrong handler
         * would answer a different code, not an error at all.
         */
        await assert('PATCH /addresses/<unknown id> reaches the EDIT route, not /default', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/addresses/68f0000000000000000000aa',
                { label: 'Nowhere' },
                { idempotencyKey: idem('addr-edit-404') },
            );
            // The edit route parses a body and then 404s on the id. `/default` takes no body
            // and would have refused `label` as an unknown key with a 400 instead.
            return res.status === 404 && errorCode(res) === 'CUSTOMER_ADDRESS_NOT_FOUND';
        });

        await assert('DELETE /addresses/<unknown id> reaches the REMOVE route and 404s', async () => {
            const res = await call(
                'DELETE',
                '/api/internal/bot/addresses/68f0000000000000000000aa',
                {},
                { idempotencyKey: idem('addr-del-404') },
            );
            return res.status === 404 && errorCode(res) === 'CUSTOMER_ADDRESS_NOT_FOUND';
        });

        await assert('⚠ PATCH /notifications/read-all is the LITERAL, not an id', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/notifications/read-all',
                {},
                { idempotencyKey: idem('notif-read-all') },
            );
            // Reaching `/:notificationId/read` instead would 404 on the id `read-all`; a
            // 200 carrying `updated` is proof the literal won.
            return res.status === 200 && typeof (res.body.data as { updated?: unknown })?.updated === 'number';
        });

        await assert('PATCH /notifications/<unknown id>/read reaches the mark-read route', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/notifications/68f0000000000000000000aa/read',
                {},
                { idempotencyKey: idem('notif-read-404') },
            );
            return res.status === 404 && errorCode(res) === 'CUSTOMER_NOTIFICATION_NOT_FOUND';
        });

        await assert('POST /notifications/list carries the chat window', async () => {
            const res = await call('POST', '/api/internal/bot/notifications/list');
            const meta = res.body.meta as { shown?: unknown; hasMore?: unknown } | undefined;
            return res.status === 200
                && Array.isArray(res.body.data)
                && typeof meta?.shown === 'number'
                && typeof meta?.hasMore === 'boolean';
        });

        /**
         * ⚠ **The leak this step's projection exists to prevent, asserted against a REAL
         * row.** `deliveryErrors[]` carries raw SMTP and Meta rejection strings and
         * `idempotencyKey` is an internal dedup handle; both are on the stored document and
         * a spread would have shipped them into a model's context window.
         */
        await assert('⚠ a real notification row leaks no operational field', async () => {
            const res = await call('POST', '/api/internal/bot/notifications/list');
            const raw = JSON.stringify(res.body);
            return res.status === 200
                && !raw.includes('idempotencyKey')
                && !raw.includes('deliveryErrors')
                && !raw.includes('deliveredVia')
                && !raw.includes('customerId');
        });

        /**
         * ⚠ **`/reviews/list` is a LITERAL beside the bare `POST /reviews`, which is the
         * write.** A DB-free assertion cannot tell them apart — both are `POST` under the
         * same prefix — and reaching the wrong one here does not 404: `reviews_create`
         * would parse `{}` against `BotReviewCreateSchema` and refuse it as a `400` for a
         * missing `subjectType`. So a `200` carrying an array is the proof, and it is
         * proof of the dispatch specifically.
         */
        await assert('POST /reviews/list is the LIST, not the bare create route', async () => {
            const res = await call('POST', '/api/internal/bot/reviews/list');
            const meta = res.body.meta as { shown?: unknown; hasMore?: unknown } | undefined;
            return res.status === 200
                && Array.isArray(res.body.data)
                && typeof meta?.shown === 'number'
                && typeof meta?.hasMore === 'boolean';
        });

        await assert('the review list is a READ — no Idempotency-Key is demanded', async () => {
            const res = await call('POST', '/api/internal/bot/reviews/list', { status: 'published' });
            return res.status === 200;
        });

        await assert('a review status outside the three is a 400, not an empty list', async () => {
            const res = await call('POST', '/api/internal/bot/reviews/list', { status: 'held' });
            return res.status === 400;
        });

        /**
         * ⚠ **`POST /payment-methods` is the SAVE and `POST /payment-methods/list` is the
         * list**, one segment against two. They cannot collide, but a save reached by mistake
         * writes a payment instrument onto somebody's account, so it is pinned by its own
         * failure mode: the list answers 200 with an array, the save 400s on a missing body.
         */
        await assert('POST /payment-methods/list is the LIST, not the save', async () => {
            const res = await call('POST', '/api/internal/bot/payment-methods/list');
            const meta = res.body.meta as { shown?: unknown; hasMore?: unknown } | undefined;
            return res.status === 200
                && Array.isArray(res.body.data)
                && typeof meta?.shown === 'number'
                && typeof meta?.hasMore === 'boolean';
        });

        await assert('⚠ POST /payment-methods reaches SAVE and refuses an empty body', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/payment-methods',
                {},
                { idempotencyKey: idem('pm-add-empty') },
            );
            return res.status === 400;
        });

        /**
         * ⚠ The stored number is what a gateway will later be asked to debit, so a locally
         * formatted one saved today is a payment that fails at checkout weeks later with
         * nothing to point at. Refused at the door, by the platform's own phone schema.
         */
        await assert('⚠ a wallet number that is not E.164 is refused before it is stored', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/payment-methods',
                { provider: 'mtn_momo', phoneNumber: '600124417' },
                { idempotencyKey: idem('pm-add-local') },
            );
            return res.status === 400;
        });

        await assert('⚠ a card cannot be saved from a chat — the fields do not exist', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/payment-methods',
                {
                    provider: 'stripe',
                    phoneNumber: '+237600124417',
                    gateway_instrument_id: 'pm_card_visa',
                },
                { idempotencyKey: idem('pm-add-card') },
            );
            return res.status === 400;
        });

        await assert('PATCH /payment-methods/<unknown>/default 404s on its own route', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/payment-methods/68f0000000000000000000aa/default',
                {},
                { idempotencyKey: idem('pm-default-404') },
            );
            return res.status === 404 && errorCode(res) === 'PAYMENT_METHOD_NOT_FOUND';
        });

        /**
         * ⚠ **The SIXTH `DELETE` with a body on this surface.** Express parses one without
         * complaint and some HTTP stacks drop it, so reaching the handler at all — a 404 on
         * the id rather than an identity refusal — is what proves the envelope survived.
         */
        await assert('⚠ DELETE /payment-methods/<unknown> carries its identity body', async () => {
            const res = await call(
                'DELETE',
                '/api/internal/bot/payment-methods/68f0000000000000000000aa',
                {},
                { idempotencyKey: idem('pm-remove-404') },
            );
            return res.status === 404 && errorCode(res) === 'PAYMENT_METHOD_NOT_FOUND';
        });

        await assert('POST /cart/get answers a cart for a customer who has none', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get');
            return res.status === 200 && res.body.data !== undefined;
        });

        await assert('POST /profile answers MASKED — the raw phone never appears', async () => {
            const res = await call('POST', '/api/internal/bot/profile');
            const data = res.body.data as Json | undefined;
            const json = JSON.stringify(res.body);
            return res.status === 200
                && data?.savedAddressCount === 0
                && !json.includes(STORED_PHONE)
                && String(data?.phoneMasked ?? '').includes('••••');
        });

        await assert('POST /addresses/list answers an empty list rather than 404', async () => {
            const res = await call('POST', '/api/internal/bot/addresses/list');
            return res.status === 200 && Array.isArray(res.body.data) && (res.body.data as unknown[]).length === 0;
        });

        /**
         * ⚠ **The contact family (MCP parity step 6), and it is the shape this suite exists
         * for.** `/contact/email` and `/contact/email/pending` are two and three segments
         * under one prefix, and neither is a `:param` — so a DB-free assertion sees a table
         * that cannot shadow, while only Express can say which handler a path actually
         * reaches. Each is pinned by its OWN failure code.
         *
         * ⚠ **None of these writes anything, deliberately.** `PATCH /contact/email` with a
         * real address would SEND MAIL (the service awaits the send), so the door is what is
         * asserted; the phone half is exercised end to end below, where it is reversible.
         */
        await assert('POST /contact answers the state read, MASKED', async () => {
            const res = await call('POST', '/api/internal/bot/contact');
            const data = res.body.data as Json | undefined;
            const json = JSON.stringify(res.body);
            return res.status === 200
                && !json.includes(STORED_PHONE)
                && String(data?.phoneMasked ?? '').includes('••••')
                && data?.pendingEmail === null
                && data?.pendingPhone === null
                && data?.phoneChangeProved === null;
        });

        await assert('PATCH /contact/email reaches the EMAIL route and refuses a non-address', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/contact/email',
                { email: 'not an address' },
                { idempotencyKey: idem('contact-email-bad') },
            );
            // A 400 from the schema is proof the email handler ran: the cancel below is a
            // DELETE, and `/contact` itself takes no arguments and would 400 on `email` too —
            // but only after `BotNoArgsSchema`, which is why the phone case is asserted apart.
            return res.status === 400;
        });

        await assert('DELETE /contact/email/pending is its own route — 409 with nothing pending', async () => {
            const res = await call(
                'DELETE',
                '/api/internal/bot/contact/email/pending',
                {},
                { idempotencyKey: idem('contact-email-cancel') },
            );
            return res.status === 409 && errorCode(res) === 'CONTACT_CHANGE_NOT_PENDING';
        });

        await assert('POST /contact/phone/confirm is its own route — 409 with nothing pending', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/contact/phone/confirm',
                {},
                { idempotencyKey: idem('contact-phone-confirm-empty') },
            );
            return res.status === 409 && errorCode(res) === 'CONTACT_CHANGE_NOT_PENDING';
        });

        await assert('⚠ PATCH /contact/phone refuses the number already on the account', async () => {
            const res = await call(
                'PATCH',
                '/api/internal/bot/contact/phone',
                { phone: STORED_PHONE },
                { idempotencyKey: idem('contact-phone-same') },
            );
            return res.status === 422 && errorCode(res) === 'CONTACT_CHANGE_SAME_IDENTIFIER';
        });

        /**
         * ⭐ **`phoneChangeProved` against REAL data, which is the one thing the DB-free
         * suite cannot do.** The proof is a WhatsApp connection whose identity IS the pending
         * number — and `external_id` arrives as bare digits (`237600000287`) while a login
         * phone is strict E.164 (`+237600000287`). A comparison that skipped that repair
         * would read `false` for **every customer, always**, while looking perfectly
         * implemented; only a live run with a real connection row can tell the difference.
         *
         * So both verdicts are exercised: a number that is NOT the connected one reports
         * `false`, and the connected one — which is the account's current number, so it can
         * never actually be pending — is asserted through the service's own predicate in the
         * DB-free suite instead. Reversible: the pending block is cancelled at the end.
         */
        await assert('⭐ a pending phone change reports `phoneChangeProved: false` truthfully', async () => {
            const opened = await call(
                'PATCH',
                '/api/internal/bot/contact/phone',
                { phone: '+237600000999' },
                { idempotencyKey: idem('contact-phone-open') },
            );
            const state = await call('POST', '/api/internal/bot/contact');
            const data = state.body.data as Json | undefined;
            const pending = data?.pendingPhone as Json | undefined;

            const cancelled = await call(
                'DELETE',
                '/api/internal/bot/contact/phone/pending',
                {},
                { idempotencyKey: idem('contact-phone-cancel') },
            );
            const after = await call('POST', '/api/internal/bot/contact');

            return opened.status === 200
                // The target comes back VERBATIM — masking it would defeat the read.
                && pending?.target === '+237600000999'
                && data?.phoneChangeProved === false
                && cancelled.status === 200
                && (after.body.data as Json | undefined)?.pendingPhone === null;
        });

        /**
         * ⚠ **Connections and closure (MCP parity step 7).** `connections_disconnect` is the
         * only route on this surface that refuses on a property of the CALLER rather than of
         * its argument, and both sides of that rule are asserted: the current channel is
         * refused, the other one is not.
         */
        await assert('POST /connections/list reports both channels and marks the current one', async () => {
            const res = await call('POST', '/api/internal/bot/connections/list');
            const rows = res.body.data as Array<Json> | undefined;
            const wa = rows?.find((r) => r.channel === 'whatsapp');
            const tg = rows?.find((r) => r.channel === 'telegram');
            const json = JSON.stringify(res.body);
            return res.status === 200
                && rows?.length === 2
                && wa?.isCurrentChannel === true
                && tg?.isCurrentChannel === false
                // The resolver BINDS on success, so this run's own WhatsApp row is here.
                && wa?.connected === true
                // ⚠ The leak assertion, against a REAL row: the raw identity never leaves.
                && !json.includes(WA_PHONE_ID)
                && !json.includes('howToConnect');
        });

        await assert('⛔ DELETE /connections/whatsapp is REFUSED — it is the current channel', async () => {
            const res = await call(
                'DELETE',
                '/api/internal/bot/connections/whatsapp',
                {},
                { idempotencyKey: idem('conn-disconnect-self') },
            );
            const still = await call('POST', '/api/internal/bot/connections/list');
            const wa = (still.body.data as Array<Json> | undefined)?.find((r) => r.channel === 'whatsapp');
            return res.status === 409
                && errorCode(res) === 'BOT_CONNECTION_ACTIVE_CHANNEL'
                // The refusal changed nothing — it runs BEFORE the unbind, and there is no
                // re-bind verb, so an unbind followed by a refusal would be unrecoverable.
                && wa?.connected === true;
        });

        await assert('the OTHER channel is not refused — it is simply not connected', async () => {
            const res = await call(
                'DELETE',
                '/api/internal/bot/connections/telegram',
                {},
                { idempotencyKey: idem('conn-disconnect-other') },
            );
            return res.status === 404 && errorCode(res) === 'MESSAGING_CONNECTION_NOT_FOUND';
        });

        await assert('a channel outside the two is refused at the door', async () => {
            const res = await call(
                'DELETE',
                '/api/internal/bot/connections/signal',
                {},
                { idempotencyKey: idem('conn-disconnect-unknown') },
            );
            return res.status === 400;
        });

        /**
         * ⚠ **The preview is exercised; the CLOSE deliberately is not.** This fixture is a
         * customer-only account with no orders in flight, so a valid `confirm` would close it
         * — and every assertion after this one reads it. What is proven instead is the
         * dispatch, by its own failure mode: `/account/close/preview` answers 200 to an empty
         * body and `/account/close` answers 400, so neither can be reaching the other.
         */
        await assert('POST /account/close/preview is a READ and carries the localised consequence', async () => {
            const res = await call('POST', '/api/internal/bot/account/close/preview');
            const data = res.body.data as Json | undefined;
            return res.status === 200
                && data?.canClose === true
                && Array.isArray(data?.blockingRoles)
                && (data?.blockingRoles as unknown[]).length === 0
                && data?.activeOrderCount === 0
                && data?.confirmWith === 'CLOSE MY ACCOUNT'
                && String(data?.consequence ?? '').includes('business records');
        });

        await assert('⛔ POST /account/close refuses a confirmation that is not the token', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/account/close',
                { confirm: 'close my account' },
                { idempotencyKey: idem('account-close-wrong-token') },
            );
            const still = await call('POST', '/api/internal/bot/contact');
            // A 400 here is proof the CLOSE handler ran — the preview takes no arguments and
            // would have refused `confirm` too, but with the account untouched either way,
            // so the account is re-read to prove nothing was anonymised.
            return res.status === 400 && still.status === 200;
        });

        await assert('every route in the table is MOUNTED — none answers 404 NOT_FOUND', async () => {
            // A concrete form per row, with ids that resolve to nothing. What matters is the
            // ROUTER's verdict: a mounted route answers its own error, an unmounted one falls
            // through to the catch-all `NOT_FOUND`.
            const unmounted: string[] = [];
            for (const route of BOT_ROUTES) {
                const concrete = route.path.replace(/:[A-Za-z0-9_]+/g, '68f0000000000000000000aa');
                const res = await call(route.method, `/api/internal/bot${concrete}`, {}, {
                    idempotencyKey: route.mutating ? idem(`mount-${route.tool}`) : undefined,
                });
                if (errorCode(res) === 'NOT_FOUND') unmounted.push(`${route.method} ${route.path}`);
            }
            if (unmounted.length) console.error('     ↳', unmounted.join(', '));
            return unmounted.length === 0;
        });

        // ═════════════════════════════════════════════════════════════════════
        section('4 · DELETE really carries its body through Express');
        // ═════════════════════════════════════════════════════════════════════

        await assert('DELETE /cart resolves the identity from a DELETE body', async () => {
            const res = await call('DELETE', '/api/internal/bot/cart', {}, { idempotencyKey: idem('del-cart-1') });
            return res.status === 200 && res.body.success === true;
        });

        await assert('DELETE /cart answers `body`, not `body.data` — the catalogue reads the message', async () => {
            const res = await call('DELETE', '/api/internal/bot/cart', {}, { idempotencyKey: idem('del-cart-2') });
            return res.body.message === 'Cart cleared' && res.body.data === null;
        });

        // ═════════════════════════════════════════════════════════════════════
        section('5 · Idempotency against a REAL Redis');
        // ═════════════════════════════════════════════════════════════════════

        await assert('⚠ a mutating route with NO key is refused', async () => {
            const res = await call('POST', '/api/internal/bot/recently-viewed', {
                productId: '68f0000000000000000000aa',
            });
            return res.status === 400 && errorCode(res) === 'BOT_IDEMPOTENCY_KEY_REQUIRED';
        });

        await assert('a READ needs no key', async () => {
            const res = await call('POST', '/api/internal/bot/cart/get');
            return res.status === 200;
        });

        await assert('a failure RELEASES the key, so the same one may be retried', async () => {
            // The product does not exist, so this 404s — and a 404 must not poison the key.
            const key = idem('idem-release-1');
            const first = await call('POST', '/api/internal/bot/recently-viewed', {
                productId: '68f0000000000000000000aa',
            }, { idempotencyKey: key });
            const second = await call('POST', '/api/internal/bot/recently-viewed', {
                productId: '68f0000000000000000000aa',
            }, { idempotencyKey: key });
            return first.status >= 400 && second.status === first.status && !second.replayed;
        });

        await assert('⚠ the SAME key with a DIFFERENT request is refused, never answered', async () => {
            const key = idem('idem-reuse-1');
            await call('DELETE', '/api/internal/bot/cart', {}, { idempotencyKey: key });
            const reused = await call('POST', '/api/internal/bot/wishlist', {
                productId: '68f0000000000000000000aa',
            }, { idempotencyKey: key });
            return reused.status === 409 && errorCode(reused) === 'BOT_IDEMPOTENCY_KEY_REUSED';
        });

        await assert('⚠ a REPLAY answers the stored response and says so in a header', async () => {
            const key = idem('idem-replay-1');
            const first = await call('DELETE', '/api/internal/bot/cart', {}, { idempotencyKey: key });
            const second = await call('DELETE', '/api/internal/bot/cart', {}, { idempotencyKey: key });
            return first.status === 200
                && second.status === 200
                && second.replayed === true
                && JSON.stringify(first.body) === JSON.stringify(second.body);
        });

        await assert('the idempotency record really lives in BOT_SURFACE_DB (10)', async () => {
            const redis = await getRedisClient(BOT_SURFACE_DB);
            const keys = await redis.keys('bot:idem:*');
            return keys.length > 0;
        });

        await assert('⚠ the raw identity is not in a listable key NAME', async () => {
            const redis = await getRedisClient(BOT_SURFACE_DB);
            const keys = await redis.keys('bot:idem:*');
            return keys.every((k) => !k.includes(WA_PHONE_ID) && !k.includes(STORED_PHONE));
        });

        // ═════════════════════════════════════════════════════════════════════
        section('6 · The geo candidate handle, end to end');
        // ═════════════════════════════════════════════════════════════════════

        // Minted directly rather than through `/geo/search`: that route calls a live
        // geocoding provider, and a suite that fails when somebody else's API is slow is a
        // suite people switch off. The HANDLE mechanics are what this section is for.
        const candidate = {
            formatted_address: 'Rue Njo-Njo, Bonapriso, Douala, Cameroon',
            coordinates: { type: 'Point' as const, coordinates: [9.7043, 4.0383] as [number, number] },
            provider: 'locationiq' as const,
            provider_place_id: 'verify-bot-osm-1',
            components: {
                street: 'Rue Njo-Njo',
                neighbourhood: 'Bonapriso',
                city: 'Douala',
                region: 'Littoral',
                country: 'Cameroon',
                country_code: 'CM',
                postal_code: null,
            },
        };

        let liveRef = '';

        await assert('the geo handle lands in the SAME database, under its own prefix', async () => {
            [liveRef] = await geoCandidateStore.mint(USER_ID.toString(), [candidate], 'njo njo');
            const redis = await getRedisClient(BOT_SURFACE_DB);
            const keys = await redis.keys('bot:geo:*');
            return liveRef.startsWith('gc_') && keys.length > 0;
        });

        await assert('⚠ POST /addresses saves from the handle and never from coordinates', async () => {
            const res = await call('POST', '/api/internal/bot/addresses', {
                label: 'Home',
                geoCandidateRef: liveRef,
                addressLine2: 'blue gate',
                isDefault: true,
            }, { idempotencyKey: idem('address-1') });

            const data = res.body.data as Json | undefined;
            return res.status === 201
                && data?.deliverable === true
                && data?.formattedAddress === candidate.formatted_address
                && !JSON.stringify(res.body).includes('9.7043');
        });

        await assert('the GeoAddress really persisted, coordinates and all', async () => {
            const customer = await CustomerModel.findById(CUSTOMER_ID);
            const saved = customer?.saved_addresses?.[0];
            return saved?.geo?.coordinates?.coordinates?.[0] === 9.7043
                && saved?.geo?.raw_input === 'njo njo'
                && saved?.city === 'Douala';
        });

        await assert('⚠ NO `location` key was written — a null there bricks the document', async () => {
            // Read through the raw driver: Mongoose would hydrate a missing path to
            // `undefined` and the distinction that matters here is ABSENT vs null.
            const raw = await mongoose.connection.db!
                .collection('customers')
                .findOne({ _id: CUSTOMER_ID });
            const saved = (raw?.saved_addresses ?? [])[0] as Json | undefined;
            return saved !== undefined && !('location' in saved);
        });

        await assert('a SECOND address can be added — the first did not brick the document', async () => {
            const [secondRef] = await geoCandidateStore.mint(USER_ID.toString(), [candidate], 'again');
            const res = await call('POST', '/api/internal/bot/addresses', {
                label: 'Work',
                geoCandidateRef: secondRef,
            }, { idempotencyKey: idem('address-2') });
            const customer = await CustomerModel.findById(CUSTOMER_ID);
            return res.status === 201 && (customer?.saved_addresses?.length ?? 0) === 2;
        });

        await assert('⚠ the handle is SPENT — replaying it is BOT_GEO_CANDIDATE_EXPIRED', async () => {
            const res = await call('POST', '/api/internal/bot/addresses', {
                label: 'Again',
                geoCandidateRef: liveRef,
            }, { idempotencyKey: idem('address-3') });
            return res.status === 400 && errorCode(res) === 'BOT_GEO_CANDIDATE_EXPIRED';
        });

        await assert('PATCH /addresses/:id/default returns the WHOLE list, re-flagged', async () => {
            const customer = await CustomerModel.findById(CUSTOMER_ID);
            const second = customer!.saved_addresses[1];
            const res = await call('PATCH', `/api/internal/bot/addresses/${second._id.toString()}/default`, {}, {
                idempotencyKey: idem('address-default-1'),
            });
            const list = res.body.data as Array<{ id: string; isDefault: boolean }>;
            return res.status === 200
                && list.length === 2
                && list.filter((a) => a.isDefault).length === 1
                && list.find((a) => a.isDefault)?.id === second._id.toString();
        });

        // ═════════════════════════════════════════════════════════════════════
        section('7 · Checkout — the route idempotency exists for');
        // ═════════════════════════════════════════════════════════════════════

        await assert('an empty cart refuses checkout, and does NOT create orders', async () => {
            const customer = await CustomerModel.findById(CUSTOMER_ID);
            const address = customer!.saved_addresses[0]._id.toString();
            const res = await call('POST', '/api/internal/bot/checkout', {
                paymentMethod: 'online',
                deliveryAddressId: address,
            }, { idempotencyKey: idem('checkout-empty-1') });

            const orders = await OrderModel.countDocuments({ customer_id: CUSTOMER_ID });
            return res.status >= 400 && orders === 0;
        });

        await assert('⚠ a retried checkout answers identically and creates nothing extra', async () => {
            const customer = await CustomerModel.findById(CUSTOMER_ID);
            const address = customer!.saved_addresses[0]._id.toString();
            const key = idem('checkout-retry-1');
            const args = { paymentMethod: 'online', deliveryAddressId: address };

            const first = await call('POST', '/api/internal/bot/checkout', args, { idempotencyKey: key });
            const second = await call('POST', '/api/internal/bot/checkout', args, { idempotencyKey: key });

            const orders = await OrderModel.countDocuments({ customer_id: CUSTOMER_ID });
            // With an empty cart both refuse, the key is released each time, and the count
            // stays zero. The assertion is the INVARIANT — a retry never doubles — which
            // holds on the refusal path as well as the success path, and this suite can
            // exercise the refusal path without seeding a whole vendor catalogue.
            return first.status === second.status && orders === 0;
        });

        await assert('checkout REFUSES to fall back to a default address', async () => {
            const res = await call('POST', '/api/internal/bot/checkout', {
                paymentMethod: 'online',
            }, { idempotencyKey: idem('checkout-noaddr-1') });
            return res.status === 400;
        });

        // ═════════════════════════════════════════════════════════════════════
        section('8 · Language, and the notification preferences translation');
        // ═════════════════════════════════════════════════════════════════════

        await assert('PATCH /profile/language writes the language and keeps the currency', async () => {
            const res = await call('PATCH', '/api/internal/bot/profile/language', { language: 'fr' }, {
                idempotencyKey: idem('language-1'),
            });
            const customer = await CustomerModel.findById(CUSTOMER_ID);
            return res.status === 200
                && customer?.preferences?.language === 'fr'
                && customer?.preferences?.currency === 'XAF';
        });

        await assert('a language outside the five is refused', async () => {
            const res = await call('PATCH', '/api/internal/bot/profile/language', { language: 'de' }, {
                idempotencyKey: idem('language-2'),
            });
            return res.status === 400;
        });

        await assert('POST /notifications/preferences reads live verification state', async () => {
            const res = await call('POST', '/api/internal/bot/notifications/preferences');
            const data = res.body.data as Json | undefined;
            return res.status === 200 && data?.preferences !== undefined;
        });

        await assert('⚠ an UNVERIFIED channel is refused rather than silently accepted', async () => {
            // The fixture has no email address, so `email` cannot be verified.
            const res = await call('PATCH', '/api/internal/bot/notifications/preferences', {
                channel: 'email',
            }, { idempotencyKey: idem('prefs-1') });
            return res.status === 400;
        });

        await assert('a progress-reporting toggle applies', async () => {
            const res = await call('PATCH', '/api/internal/bot/notifications/preferences', {
                orderUpdates: false,
            }, { idempotencyKey: idem('prefs-2') });
            return res.status === 200;
        });

        // ═════════════════════════════════════════════════════════════════════
        section('9 · Support routing against real collections (GAP-004)');
        // ═════════════════════════════════════════════════════════════════════

        /**
         * ⚠ **These fixtures are created HERE, not in `seed()`, and that is load-bearing.**
         * Section 7 asserts `countDocuments({ customer_id: CUSTOMER_ID }) === 0` to prove a
         * retried checkout creates nothing — seeding an order up front would make that
         * assertion fail for a reason that has nothing to do with idempotency.
         */
        await assert('the empty-context answer is the platform alone, not a 404', async () => {
            // Still true at this point: the fixtures below are not created yet.
            const res = await call('POST', '/api/internal/bot/support/context');
            const data = res.body.data as Json | undefined;
            return res.status === 200
                && data?.resolvedFrom === 'none'
                && data?.vendor === null
                && data?.agency === null
                && (data?.platform as Json | undefined)?.canOpenTicket === true;
        });

        await assert('⚠ a NAMED scope with nothing to route from is 404, and carries the customer sentence', async () => {
            const res = await call('POST', '/api/internal/bot/support/context', { scope: 'vendor' });
            const error = res.body.error as { code?: string; customerMessage?: string } | undefined;
            return res.status === 404
                && error?.code === 'BOT_SUPPORT_NO_CONTEXT'
                && typeof error?.customerMessage === 'string'
                && error.customerMessage.length > 0
                && !error.customerMessage.includes('BOT_SUPPORT');
        });

        await assert('a hint naming an order that is not theirs is refused, not fallen through', async () => {
            const res = await call('POST', '/api/internal/bot/support/context', {
                hintOrderId: 'ORD-DOES-NOT-EXIST',
            });
            return res.status === 404 && errorCode(res) === 'ORDER_NOT_FOUND';
        });

        // Now the world exists: a seller, a delivery company, an order and one parcel.
        await StoreModel.create({
            _id: SUPPORT_STORE_ID,
            vendor_id: SUPPORT_VENDOR_ID,
            name: 'Verify Bot Maison',
            slug: SUPPORT_STORE_SLUG,
            support_email: 'help@verify-bot.example',
            support_whatsapp: '+237600000288',
        });
        await AgencyMagazinModel.create({
            _id: SUPPORT_MAGAZIN_ID,
            agency_id: SUPPORT_AGENCY_ID,
            name: 'Verify Bot Express',
            support_phone: '+237600000289',
        });
        await OrderModel.create({
            _id: SUPPORT_ORDER_ID,
            order_number: SUPPORT_ORDER_NUMBER,
            order_type: 'physical',
            cart_id: new mongoose.Types.ObjectId(),
            vendor_id: SUPPORT_VENDOR_ID,
            customer_id: CUSTOMER_ID,
            items: [{
                variant_id: new mongoose.Types.ObjectId(),
                sku: 'VERIFY-BOT-SKU',
                options_snapshot: 'default',
                product_id: new mongoose.Types.ObjectId(),
                title: 'Verify Bot Dress',
                vendor_id: SUPPORT_VENDOR_ID,
                product_type: 'physical',
                quantity: 1,
                price: 24000,
                currency: 'XAF',
                delivery: { agency_id: SUPPORT_AGENCY_ID, status: 'assigned' },
            }],
            currency: 'XAF',
            price_breakdown: { base: 24000, tax: 0, discount: 0, total: 24000 },
            total_amount: 24000,
            payment_method: 'online',
        });

        await assert('an order with NO parcel yet answers with the seller and no delivery company', async () => {
            // The window between checkout and the first shipment row — where the catalogue's
            // "the agency only exists once an order has shipped" is literally true.
            const res = await call('POST', '/api/internal/bot/support/context');
            const data = res.body.data as Json | undefined;
            const vendor = data?.vendor as Json | undefined;
            return res.status === 200
                && data?.resolvedFrom === 'recent_order'
                && vendor?.storeSlug === SUPPORT_STORE_SLUG
                && vendor?.supportWhatsapp === '+237600000288'
                && data?.agency === null;
        });

        await assert('⚠ scope agency there is the 409, not a 404 and not an empty 200', async () => {
            const res = await call('POST', '/api/internal/bot/support/context', { scope: 'agency' });
            return res.status === 409 && errorCode(res) === 'BOT_SUPPORT_SCOPE_UNAVAILABLE';
        });

        await ShipmentModel.create({
            _id: SUPPORT_SHIPMENT_ID,
            order_id: SUPPORT_ORDER_ID,
            agency_id: SUPPORT_AGENCY_ID,
            status: 'assigned',
            items: [],
        });

        await assert('once a parcel exists, the delivery company resolves from the SHIPMENT', async () => {
            const res = await call('POST', '/api/internal/bot/support/context');
            const data = res.body.data as Json | undefined;
            const agency = data?.agency as Json | undefined;
            return res.status === 200
                && agency?.name === 'Verify Bot Express'
                && agency?.supportPhone === '+237600000289'
                && agency?.supportEmail === null;
        });

        await assert('the subject NAMES what it routed from — the order number and the seller', async () => {
            const res = await call('POST', '/api/internal/bot/support/context');
            const subject = (res.body.data as Json | undefined)?.subject as Json | undefined;
            return subject?.type === 'order'
                && subject?.id === SUPPORT_ORDER_ID.toString()
                && subject?.label === `${SUPPORT_ORDER_NUMBER} — Verify Bot Maison`;
        });

        await assert('⚠ a hint by ORDER NUMBER resolves — a chat quotes the number, not an id', async () => {
            // The `$regex`-anchored lookup, against real Mongo. A customer reads out
            // "ORD-…", never a 24-character id.
            const res = await call('POST', '/api/internal/bot/support/context', {
                hintOrderId: SUPPORT_ORDER_NUMBER.toLowerCase(),
            });
            const data = res.body.data as Json | undefined;
            return res.status === 200 && data?.resolvedFrom === 'hint_order';
        });

        await assert('scope vendor keeps the seller and the platform, and drops the agency', async () => {
            const res = await call('POST', '/api/internal/bot/support/context', { scope: 'vendor' });
            const data = res.body.data as Json | undefined;
            return res.status === 200
                && data?.vendor !== null
                && data?.agency === null
                && (data?.platform as Json | undefined)?.canOpenTicket === true;
        });

        await assert('⚠ no vendor id, no agent, no coordinates reach the wire', async () => {
            // The seller is addressed by store slug precisely so an internal id never
            // becomes a public identifier, and a chat window is as public as it gets.
            const res = await call('POST', '/api/internal/bot/support/context');
            const json = JSON.stringify(res.body);
            return !json.includes(SUPPORT_VENDOR_ID.toString())
                && !json.includes(SUPPORT_MAGAZIN_ID.toString())
                && !/coordinates|"lat"|"lng"/.test(json);
        });

        // ═════════════════════════════════════════════════════════════════════
        section('10 · The hosted card page, end to end (GAP-008)');
        // ═════════════════════════════════════════════════════════════════════

        /**
         * ⚠ **This section is the half of GAP-008 no source scan can reach.** Everything
         * `test:payments` § 9 asserts is pure — the state table, the disclosure gate, the
         * key refusal. What only a real boot proves is that the two routes are actually
         * mounted the way they were meant to be: that `GET /api/payments/session/:token`
         * answers with NO credentials at all (it is the one anonymous read this change
         * adds), that it is not shadowed by `GET /:transactionId` beside it, and that a
         * re-mint really does kill the earlier link.
         */
        const stripePublishableBefore = process.env.STRIPE_PUBLISHABLE_KEY;
        process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_verify_bot_287';

        await PaymentTransactionModel.create([
            {
                _id: CARD_TX_ID,
                orderId: SUPPORT_ORDER_ID,
                purpose: 'primary',
                userId: CUSTOMER_ID,
                gateway: 'STRIPE',
                method: 'CARD',
                gatewayRef: 'pi_verify_bot_287',
                status: 'PENDING',
                amountSnapshot: 24000,
                currencySnapshot: 'XAF',
                idempotencyKey: `verify-bot-card-${RUN}`,
                merchantRef: `jm_pt_verifybot${RUN}`,
                rawGatewayPayloads: [
                    {
                        instructions: {
                            clientSecret: CARD_CLIENT_SECRET,
                            chargedAmount: 40,
                            chargedCurrency: 'usd',
                        },
                    },
                ],
            },
            {
                _id: MOMO_TX_ID,
                orderId: SUPPORT_ORDER_ID,
                purpose: 'primary',
                userId: CUSTOMER_ID,
                gateway: 'NOTCHPAY',
                method: 'MOBILE',
                gatewayRef: 'np_verify_bot_287',
                status: 'PENDING',
                amountSnapshot: 24000,
                currencySnapshot: 'XAF',
                idempotencyKey: `verify-bot-momo-${RUN}`,
            },
        ]);

        let firstToken = '';

        await assert('the bot mints a card page link, and it points at the storefront', async () => {
            const res = await call(
                'POST',
                `/api/internal/bot/payments/${CARD_TX_ID.toString()}/pay-link`,
                {},
                { idempotencyKey: idem('pay-link-1') },
            );
            const data = res.body.data as Json | undefined;
            firstToken = String(data?.token ?? '');
            return res.status === 200
                && firstToken.startsWith('pl_')
                && typeof data?.url === 'string'
                && (data.url as string).endsWith(`/pay/${firstToken}`);
        });

        await assert('⚠ the page reads its session with NO credentials at all', async () => {
            // No Authorization, no X-Webhook-Secret, no cookie. A browser opening a link
            // from a chat has none of them, and this is the only route in the change that
            // is reachable that way.
            const res = await fetch(`${base}/api/payments/session/${firstToken}`);
            const body = (await res.json()) as Json;
            const data = body.data as Json | undefined;
            return res.status === 200
                && data?.state === 'payable'
                && data?.clientSecret === CARD_CLIENT_SECRET
                && data?.publishableKey === 'pk_test_verify_bot_287'
                && data?.amount === 24000
                && data?.chargedCurrency === 'usd';
        });

        await assert('⚠ the anonymous session carries no payer and no gateway reference', async () => {
            const res = await fetch(`${base}/api/payments/session/${firstToken}`);
            const json = JSON.stringify(await res.json());
            return !json.includes(CUSTOMER_ID.toString())
                && !json.includes('merchantRef')
                && !json.includes('idempotencyKey')
                && !json.includes('pi_verify_bot_287');
        });

        await assert('⚠ a RE-MINT revokes the first link — that is the only revocation', async () => {
            const res = await call(
                'POST',
                `/api/internal/bot/payments/${CARD_TX_ID.toString()}/pay-link`,
                {},
                { idempotencyKey: idem('pay-link-2') },
            );
            const second = String((res.body.data as Json | undefined)?.token ?? '');
            const oldOne = await fetch(`${base}/api/payments/session/${firstToken}`);
            const newOne = await fetch(`${base}/api/payments/session/${second}`);
            firstToken = second;
            return second !== '' && oldOne.status === 404 && newOne.status === 200;
        });

        await assert('an unknown and a malformed token are the SAME 404', async () => {
            const unknown = await fetch(`${base}/api/payments/session/pl_${'a'.repeat(64)}`);
            const malformed = await fetch(`${base}/api/payments/session/not-a-token`);
            const unknownBody = (await unknown.json()) as Json;
            const malformedBody = (await malformed.json()) as Json;
            // Indistinguishable on purpose: any difference is an oracle telling an anonymous
            // caller whether their guess had the right shape.
            return unknown.status === 404
                && malformed.status === 404
                && (unknownBody.error as Json)?.code === 'PAYMENT_LINK_NOT_FOUND'
                && (malformedBody.error as Json)?.code === 'PAYMENT_LINK_NOT_FOUND';
        });

        await assert('⚠ a SETTLED payment reads `settled` and hands out NO client secret', async () => {
            await PaymentTransactionModel.updateOne(
                { _id: CARD_TX_ID },
                { $set: { status: 'SUCCEEDED' } },
            );
            const res = await fetch(`${base}/api/payments/session/${firstToken}`);
            const data = ((await res.json()) as Json).data as Json | undefined;
            await PaymentTransactionModel.updateOne(
                { _id: CARD_TX_ID },
                { $set: { status: 'PENDING' } },
            );
            // The customer came back to a link that still resolves. They must be told they
            // PAID — not offered a way to pay again.
            return res.status === 200
                && data?.state === 'settled'
                && data?.clientSecret === null
                && data?.publishableKey === null;
        });

        await assert('mobile money is refused a page — it completes on the handset', async () => {
            const res = await call(
                'POST',
                `/api/internal/bot/payments/${MOMO_TX_ID.toString()}/pay-link`,
                {},
                { idempotencyKey: idem('pay-link-momo') },
            );
            return res.status === 422 && errorCode(res) === 'PAYMENT_LINK_NOT_APPLICABLE';
        });

        await assert("a transaction that is not the caller's 404s, and never 403s", async () => {
            const strangerTx = await PaymentTransactionModel.create({
                orderId: SUPPORT_ORDER_ID,
                purpose: 'primary',
                userId: new mongoose.Types.ObjectId(),
                gateway: 'STRIPE',
                method: 'CARD',
                gatewayRef: `pi_stranger_${RUN}`,
                status: 'PENDING',
                amountSnapshot: 100,
                currencySnapshot: 'XAF',
                idempotencyKey: `verify-bot-stranger-${RUN}`,
            });
            const res = await call(
                'POST',
                `/api/internal/bot/payments/${strangerTx._id.toString()}/pay-link`,
                {},
                { idempotencyKey: idem('pay-link-stranger') },
            );
            await PaymentTransactionModel.deleteOne({ _id: strangerTx._id });
            // A 403 would confirm the id exists, which is the disclosure the scoping is for.
            return res.status === 404 && errorCode(res) === 'PAYMENT_TRANSACTION_NOT_FOUND';
        });

        // ═════════════════════════════════════════════════════════════════════
        section('11 · The service window, and the proactive hand-off (GAP-012)');
        // ═════════════════════════════════════════════════════════════════════

        await assert('a WhatsApp sender with no inbound traffic reports the window CLOSED', async () => {
            const res = await call('POST', '/api/internal/bot/messaging/window');
            const data = res.body.data as Json | undefined;
            return res.status === 200
                && data?.applicable === true
                && data?.open === false
                && data?.expiresAt === null
                && data?.mustUseTemplate === true;
        });

        await assert('an inbound message opens it, and the deadline is reported', async () => {
            // What the webhook does on every inbound message. Going through the real service
            // rather than writing the key by hand is the point — this asserts the SAME key
            // the send path reads, which a hand-written one would not.
            await new WhatsappService().recordInbound(WA_PHONE_ID);
            const res = await call('POST', '/api/internal/bot/messaging/window');
            const data = res.body.data as Json | undefined;
            const expiresAt = data?.expiresAt ? new Date(String(data.expiresAt)).getTime() : 0;
            const hoursOut = (expiresAt - Date.now()) / 3_600_000;
            // 23 hours, not 24 — the platform stops a margin before Meta's real boundary.
            return res.status === 200
                && data?.open === true
                && data?.mustUseTemplate === false
                && hoursOut > 22.5 && hoursOut < 23.1;
        });

        await assert('⚠ Telegram has no window at all, and says so rather than lying `open`', async () => {
            /**
             * A bound Telegram identity, created here rather than in `seed()`: § 2 asserts
             * that an UNBOUND chat answers `409 BOT_IDENTITY_NEEDS_CONTACT`, and binding it
             * up front would make that assertion fail for a reason with nothing to do with
             * the contact handshake. Removed again immediately, so the ordering of these two
             * sections stays irrelevant.
             */
            await ChannelConnectionModel.create({
                user_id: USER_ID,
                channel: 'telegram',
                external_id: TELEGRAM_CHAT_ID,
            });
            try {
                const res = await call('POST', '/api/internal/bot/messaging/window', {}, {
                    identity: { channel: 'telegram', externalId: TELEGRAM_CHAT_ID },
                });
                const data = res.body.data as Json | undefined;
                // Two fields, not one. "The window is open" and "there is no window" are
                // different facts, and a caller that collapses them writes a Telegram flow
                // around a deadline that does not exist.
                return res.status === 200
                    && data?.applicable === false
                    && data?.open === true
                    && data?.expiresAt === null;
            } finally {
                await ChannelConnectionModel.deleteOne({
                    channel: 'telegram',
                    external_id: TELEGRAM_CHAT_ID,
                });
            }
        });

        await assert('the hand-off delivers a pay link and reports its expiry', async () => {
            const res = await call('POST', '/api/internal/bot/messaging/notify', {
                situation: 'order.payment_link',
                transactionId: CARD_TX_ID.toString(),
            }, { idempotencyKey: idem('notify-1') });
            const data = res.body.data as Json | undefined;
            return res.status === 200
                && data?.situation === 'order.payment_link'
                && typeof data?.expiresAt === 'string';
        });

        await assert('⚠ the hand-off left an IN-APP record, which is what proves it dispatched', async () => {
            // The secondary channels are best-effort and silent by design — `notify()` never
            // throws — so the durable in-app row is the only honest evidence the situation
            // actually reached the notification stack rather than being swallowed.
            const record = await CustomerNotificationModel.findOne({
                customerId: CUSTOMER_ID,
                type: 'order.payment_link',
            }).lean();
            await CustomerNotificationModel.deleteMany({ customerId: CUSTOMER_ID });
            return !!record
                && record.aggregateType === 'payment'
                && typeof record.action?.url === 'string'
                && record.action.url.includes('/pay/pl_');
        });

        await assert('an unknown situation is refused by the closed set', async () => {
            const res = await call('POST', '/api/internal/bot/messaging/notify', {
                situation: 'order.shipped',
                transactionId: CARD_TX_ID.toString(),
            }, { idempotencyKey: idem('notify-bad') });
            return res.status === 400;
        });

        await assert('⚠ the hand-off refuses a free-text message outright', async () => {
            // `.strict()` is what makes "this is not a send-a-message route" structural
            // rather than a convention somebody can talk their way past.
            const res = await call('POST', '/api/internal/bot/messaging/notify', {
                situation: 'order.payment_link',
                transactionId: CARD_TX_ID.toString(),
                message: 'Buy two, get one free',
            }, { idempotencyKey: idem('notify-text') });
            return res.status === 400;
        });

        // ═════════════════════════════════════════════════════════════════════
        section('12 · Files the customer sends, end to end (parity step 7b)');

        /**
         * ⚠ **A REAL PNG, eight bytes of header and all.** The upload pipeline SNIFFS the
         * magic bytes and refuses a file whose real type differs from the claimed one, so a
         * fixture of `Buffer.from('hello')` labelled `image/png` is refused — and refused for
         * the right reason, which would make this whole section pass while proving nothing.
         * This is a 1x1 transparent PNG.
         */
        const PNG_BASE64 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
            + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

        let fileRef = '';
        let ticketId = '';

        await assert('⭐ POST /files/inbound stores a real PNG and answers a handle', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/files/inbound',
                { fileName: 'damage.png', mimeType: 'image/png', contentBase64: PNG_BASE64 },
                { idempotencyKey: idem('file-1') },
            );
            const data = res.body.data as Json | undefined;
            fileRef = String(data?.ref ?? '');
            if (res.status !== 201) console.error('     ↳', JSON.stringify(res.body).slice(0, 300));
            return res.status === 201
                && fileRef.startsWith('att_')
                && data?.kind === 'image'
                && data?.fileName === 'damage.png'
                && typeof data?.size === 'number' && (data.size as number) > 0;
        });

        /**
         * ⚠ **A LEAK assertion against the REAL pipeline output**, not a hand-built DTO. The
         * pipeline returns a `File` carrying `id`, `key`, `provider` and an owner; publishing
         * any of it beside the handle would make the handle's three properties decorative,
         * because a caller would simply keep the id.
         */
        await assert('⛔ the stored file\'s id, key and provider never leave the backend', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/files/inbound',
                { fileName: 'leak.png', mimeType: 'image/png', contentBase64: PNG_BASE64 },
                { idempotencyKey: idem('file-leak') },
            );
            const serialised = JSON.stringify(res.body.data ?? {});
            return res.status === 201
                && !/fileId|"key"|"url"|"provider"|"ownerId"|storage/i.test(serialised);
        });

        /**
         * ⚠ Refused at the door rather than by the pipeline, and the DIFFERENCE matters: this
         * is the refusal that saves the automation layer a channel download it cannot get back.
         * A voice note is `audio/ogg` on both channels, and the pipeline would refuse it too —
         * after the bytes had already crossed the wire.
         */
        await assert('⛔ a voice note is refused — images and PDF only', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/files/inbound',
                { fileName: 'note.ogg', mimeType: 'audio/ogg', contentBase64: PNG_BASE64 },
                { idempotencyKey: idem('file-ogg') },
            );
            return res.status === 400 && errorCode(res) === 'UPLOAD_POLICY_VIOLATION';
        });

        /**
         * ⚠ **The 413 the CUSTOMER reads, not the body parser's.** `BOT_FILE_BODY_LIMIT`
         * (12mb) would also refuse this, with a bare status and no code to relay. This proves
         * the controller's own ceiling fires first — which is only true while it stays the
         * lower of the two.
         */
        await assert('⚠ over 8 MB decoded is refused with a CODE, not a bare 413', async () => {
            // 8.5 MB of zero bytes: above the 8 MB DECODED ceiling and, at ~11.3 MB of
            // base64, still under `BOT_FILE_BODY_LIMIT`. Both halves matter — a bigger
            // fixture is refused by the parser instead and proves nothing about this rule.
            const big = Buffer.alloc(Math.floor(8.5 * 1024 * 1024)).toString('base64');
            const res = await call(
                'POST',
                '/api/internal/bot/files/inbound',
                { fileName: 'big.png', mimeType: 'image/png', contentBase64: big },
                { idempotencyKey: idem('file-big') },
            );
            return res.status === 413 && errorCode(res) === 'UPLOAD_POLICY_VIOLATION';
        });

        await assert('a ticket to attach it to', async () => {
            const res = await call(
                'POST',
                '/api/internal/bot/tickets',
                {
                    subject: 'Verify bot attachment',
                    description: 'One item arrived cracked.',
                    type: 'order_issue',
                },
                { idempotencyKey: idem('ticket-1') },
            );
            const data = res.body.data as Json | undefined;
            ticketId = String(data?.id ?? '');
            if (res.status !== 201) console.error('     ↳', JSON.stringify(res.body).slice(0, 300));
            return res.status === 201 && ticketId.length === 24;
        });

        await assert('⭐ the handle attaches, and the answer reports the ceiling', async () => {
            const res = await call(
                'POST',
                `/api/internal/bot/tickets/${ticketId}/attachments`,
                { ref: fileRef },
                { idempotencyKey: idem('attach-1') },
            );
            const data = res.body.data as Json | undefined;
            if (res.status !== 201) console.error('     ↳', JSON.stringify(res.body).slice(0, 300));
            return res.status === 201
                && data?.fileName === 'damage.png'
                && data?.kind === 'image'
                && data?.attachmentCount === 1
                && data?.attachmentLimit === 5;
        });

        /**
         * ⚠ **Single-use, and this is the only place it is PROVEN.** The store's `consume` is
         * an atomic Lua read-and-delete precisely so two concurrent attaches cannot both write
         * an attachment row for one file; a `get` then a `del` would pass every DB-free
         * assertion and fail here.
         */
        await assert('⛔ the same handle cannot be spent twice', async () => {
            const res = await call(
                'POST',
                `/api/internal/bot/tickets/${ticketId}/attachments`,
                { ref: fileRef },
                { idempotencyKey: idem('attach-replay') },
            );
            return res.status === 404 && errorCode(res) === 'BOT_INBOUND_FILE_EXPIRED';
        });

        /**
         * ⭐ **THE ASSERTION THIS SECTION EXISTS FOR, and nothing DB-free can make it.**
         *
         * A failed attach must leave the handle live. The attach fails for reasons that are
         * the customer's to fix and not the file's, and burning the handle on those turns a
         * fixable refusal into "…and now send the photo again", for a file sitting in storage,
         * correct and unused. Proven the only honest way: fail an attach, then succeed with
         * the SAME handle.
         */
        await assert('⭐ a FAILED attach leaves the handle spendable', async () => {
            const second = await call(
                'POST',
                '/api/internal/bot/files/inbound',
                { fileName: 'second.png', mimeType: 'image/png', contentBase64: PNG_BASE64 },
                { idempotencyKey: idem('file-2') },
            );
            const ref2 = String((second.body.data as Json | undefined)?.ref ?? '');
            if (!ref2) return false;

            // A ticket that does not exist. The follower check never runs; the point is that
            // the request fails AFTER the handle has been named and BEFORE it is lost.
            const missed = await call(
                'POST',
                '/api/internal/bot/tickets/60700000000000000000f999/attachments',
                { ref: ref2 },
                { idempotencyKey: idem('attach-miss') },
            );
            if (missed.status !== 404 || errorCode(missed) !== 'TICKET_NOT_FOUND') {
                console.error('     ↳ expected TICKET_NOT_FOUND, got', missed.status, errorCode(missed));
                return false;
            }

            const retried = await call(
                'POST',
                `/api/internal/bot/tickets/${ticketId}/attachments`,
                { ref: ref2 },
                { idempotencyKey: idem('attach-2') },
            );
            if (retried.status !== 201) console.error('     ↳', JSON.stringify(retried.body).slice(0, 300));
            return retried.status === 201
                && (retried.body.data as Json | undefined)?.attachmentCount === 2;
        });

        /**
         * ⚠ **The ownership stamp, proven rather than source-scanned.** The upload writes
         * `ownerType: 'customer'` / `ownerId: caller.customerId`, and
         * `enforceFileAttachmentAuthorization` compares exactly those two fields against the
         * actor. A wrong stamp uploads perfectly and then 403s here, one route later — so a
         * successful attach above is the only thing that proves the two agree.
         */
        await assert('⛔ a handle minted for ANOTHER account is refused, not resolved', async () => {
            const res = await call(
                'POST',
                `/api/internal/bot/tickets/${ticketId}/attachments`,
                { ref: 'att_' + 'A'.repeat(43) },
                { idempotencyKey: idem('attach-forged') },
            );
            return res.status === 404 && errorCode(res) === 'BOT_INBOUND_FILE_EXPIRED';
        });

        if (stripePublishableBefore === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
        else process.env.STRIPE_PUBLISHABLE_KEY = stripePublishableBefore;
    } finally {
        console.log(`\n${'─'.repeat(76)}`);
        console.log(`  ${passed} passed, ${failed} failed`);
        console.log(`${'─'.repeat(76)}\n`);

        await cleanup();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await mongoose.disconnect();
        await closeRedisClients();
    }

    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(async (err) => {
    console.error('verify:bot-surface crashed:', err);
    await cleanup().catch(() => undefined);
    process.exit(1);
});
