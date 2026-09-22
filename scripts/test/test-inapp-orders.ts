/**
 * Test: STREAM E — the order listing and store listing screens.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 * Five sessions build this surface in **one working tree with no branching**. Two sessions
 * appending to one shared suite is a read-then-write race on disk, not a merge conflict — one
 * session's work simply disappears. So `test-bot-surface.ts` is touched by **nobody**, and
 * this file is **Stream E's alone**.
 *
 * ── ⚠ THIS STREAM IS A LATER MILESTONE, AND THAT IS WHY THE FILE EXISTS NOW ─
 * `inAppOrderListing` and `inAppStoreListing` are deliberately **not** in milestone 1 — they
 * are not on the buying path. Their whole contract is frozen by Stream 0 anyway (the kinds,
 * the sessions, the copy, the verbs, the routes), so starting Stream E later costs nothing.
 *
 * What it does cost is a live consequence that has to be designed around rather than
 * forgotten: **milestone 1's store browse and "load more orders" point at screens that do not
 * exist yet.** § 1 pins the degradation that keeps that honest. The screens must never be dead
 * buttons in the meantime.
 *
 * § 3 (chat-surfaces, 2026-09-22) drives the REAL `orders_list_groups` handler with the repository
 * replaced: "show my orders" is answered IN THE CHAT as five rows plus Load more, which is the shape
 * the assistant must reach for before it ever opens the order screen.
 *
 * Run: npm run test:inapp-orders
 */
import fs from 'fs';
import path from 'path';
import { TTL_SECONDS } from '../../src/modules/bot-surface/services/inapp-surface.store';
import { __SCREEN_KINDS } from '../../src/modules/bot-surface/miniapp/inapp-page.controller';
import { __IN_APP_COPY, inAppCopy } from '../../src/modules/bot-surface/miniapp/inapp-copy';
import { openSurfaceActionId, parseBotActionId, __CALLBACK_DATA_BYTES } from '../../src/modules/bot-surface/domain/bot-action-id';
import { botChrome } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { __ORDER_LISTING } from '../../src/modules/bot-surface/miniapp/surfaces/order-listing.controller';
import { __STORE_LISTING } from '../../src/modules/bot-surface/miniapp/surfaces/store-listing.controller';
import { CustomerOrderGroup, OrderRepository } from '../../src/modules/orders/order.repository';
import { BotOrderController } from '../../src/modules/bot-surface/controllers/bot-order.controller';
import { BotReplyIntent, renderBotReplies } from '../../src/modules/bot-surface/domain/channel-reply';
import type { Request, Response } from 'express';
import {
    ORDER_CASH_ON_DELIVERY_COPY,
    ORDER_PAYMENT_COPY,
    ORDER_PROGRESS_COPY,
    ORDER_PROGRESS_OF,
    ORDER_STATUS_UNAVAILABLE_COPY,
    botFulfillmentStateLabel,
    botOrderCopy,
    botPaymentStateLabel,
} from '../../src/modules/bot-surface/domain/bot-order-status-copy';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const PUBLIC_DIR = path.join(__dirname, '../../src/modules/bot-surface/miniapp/public');

/**
 * Every source file of the bot surface, concatenated, for the one question that needs it: does
 * anything actually DRAW a button for this screen?
 *
 * ⚠ **Read once and searched as text.** Several of these files reach `orders/` and `payments/` and
 * cannot be imported under bare `ts-node` at all — and the question is about a call site's existence,
 * which text answers exactly.
 */
const SRC = (function readBotSurface(): string {
    const root = path.join(__dirname, '../../src/modules/bot-surface');
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const at = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(at);
            else if (entry.name.endsWith('.ts')) out.push(fs.readFileSync(at, 'utf8'));
        }
    };
    walk(root);
    return out.join('\n').replace(/\r\n/g, '\n');
}());
/**
 * ⚠ `as const` rather than `InAppSurfaceKind[]`, and the difference is load-bearing:
 * `openSurfaceActionId` takes `BotInAppSurface`, which is now all FIVE screen kinds. `co`
 * was added on 2026-09-16 — see the assertion below for why that is safe and what replaced
 * the membership check that used to stand in for it.
 */
const MINE = ['ol', 'sl'] as const;

async function main(): Promise<void> {
    await runOrderLists();

    console.log('\n══ § 1 · The contract Stream 0 froze (do not edit) ══');

    console.log('\n── The kinds exist, so nothing has to be added later ──');

    assert('both kinds are on the page controller\'s allowlist', () =>
        MINE.every((kind) => (__SCREEN_KINDS as readonly string[]).includes(kind)));

    assert('both have a session lifetime', () =>
        MINE.every((kind) => TTL_SECONDS[kind] === 1800));

    assert('both have a heading, in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const c = inAppCopy(lang) as Record<string, string>;
            return c.ordersHeading?.trim().length > 0 && c.storesHeading?.trim().length > 0;
        }));

    assert('both have a tap-code that fits Telegram\'s 64 bytes', () =>
        MINE.every((surface) => {
            const id = openSurfaceActionId(surface);
            return parseBotActionId(id)?.verb === 'open'
                && Buffer.byteLength(id, 'utf8') <= __CALLBACK_DATA_BYTES;
        }));

    /**
     * ⚠ **THIS ASSERTION CHANGED ITS MIND ON 2026-09-16, AND THE HISTORY IS THE LESSON.**
     *
     * It used to read *"no tap-code can open CHECKOUT"* and pin `BotInAppSurface` to exactly
     * `pd·pl·ol·sl`. That was written to protect a real danger — a forwardable chat button that
     * starts a payment — and it protected the wrong thing. It failed the moment `co` was added,
     * which is exactly what a source-pinned assertion is for: the widening could not happen
     * quietly, and had to be argued for.
     *
     * The argument that won: `open:co` carries **no reference**, so nothing is baked into the
     * button. The session is minted **on the tap**, by the server, for whoever tapped. A
     * pre-minted checkout handle in a chat message would also be dead on arrival — they live
     * ten minutes and a message does not. So the danger was never the verb; it was a handle
     * travelling inside one.
     *
     * ⚠ So what is pinned now is the property that actually protects checkout, not the
     * membership that stood in for it: **`open:co` must carry no reference.** A future change
     * that makes it take one re-opens the original hole, and this fails.
     */
    assert('⛔ `open:co` carries NO reference — a checkout handle never travels in a button', () => {
        const bare = openSurfaceActionId('co');
        const withRef = openSurfaceActionId('co', 'ia_somehandle');
        const parsed = parseBotActionId(bare);
        return parsed?.verb === 'open'
            && parsed.argument === 'co'
            // The builder CAN carry one; the rule is that no caller may, so the two must differ.
            && withRef !== bare
            && Buffer.byteLength(bare, 'utf8') <= __CALLBACK_DATA_BYTES;
    });

    /**
     * ⚠ **This asserted a hand-typed list of FIVE, and there are NINE screen kinds now** (corrected
     * 2026-09-20). The literal was defended as an explicit-decision gate — "adding a sixth openable
     * surface must fail here" — and that argument is sound about a *count* and wrong about this list:
     * a pin somebody has to retype is a guard that goes green by being edited, and four kinds were
     * added by three streams in one day.
     *
     * What replaces it is the invariant the literal was standing in for, derived and therefore never
     * stale: **every surface a tap can OPEN must be a real screen kind, with a lifetime and a page.**
     * That is the wiring which actually breaks — `flows.config.ts` was broken twice today by a kind
     * added in one place and not another — and no count appears in it.
     *
     * ⚠ **The check is deliberately ONE-DIRECTIONAL.** Not every kind is openable by a tap: the
     * support form (`tf`) is reached through `tkt:new`, and a booking payment screen is reached from a
     * booking, not from a verb. Asserting the reverse would fail on screens that are correct.
     *
     * ⚠ **A scan that matches nothing must FAIL**, which is why the emptiness check is first: an
     * `every` over an empty list is vacuously true, and that is how this kind of guard stops working
     * silently.
     */
    assert('every openable surface is a real screen kind, with a lifetime and a page', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/domain/bot-action-id.ts'), 'utf8');
        const m = src.match(/export type BotInAppSurface\s*=\s*([^;]+);/);
        if (!m) return false;

        const openable = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
        if (openable.length === 0) return false;

        const kinds = (__SCREEN_KINDS as readonly string[]).slice();
        const notAKind = openable.filter((kind) => !kinds.includes(kind));
        const noLifetime = openable.filter(
            (kind) => !(typeof TTL_SECONDS[kind as keyof typeof TTL_SECONDS] === 'number'),
        );

        if (notAKind.length) console.error(`     ↳ openable but not a screen kind: ${notAKind.join(', ')}`);
        if (noLifetime.length) console.error(`     ↳ openable with no TTL: ${noLifetime.join(', ')}`);

        /**
         * ⚠ **A missing PAGE is only a fault for a surface something actually DRAWS**, and getting
         * this wrong is how a guard starts failing on correct code — which teaches the next person to
         * weaken it. Declaring a kind and its token ahead of its page is the established pattern
         * here: `ol` and `sl` shipped that way for a whole milestone, `inapp-page.controller.ts`
         * answers a missing file with a deliberate 503, and `bp` is dark today by the bookings
         * stream's own decision. What is NOT acceptable is a button a customer can press that opens
         * that 503 — so the gate is "drawn, and no page", found by looking for the draw site.
         */
        /**
         * ⚠ **A screen is reached two ways, and both count as "drawn".** A tap-code carries
         * `openSurfaceActionId('<kind>')`; a route mints a session directly with `kind: '<kind>',` in
         * an `openInAppScreen` payload — which is how the store directory and the order history are
         * opened, and how the support form is. The comma is what separates a payload from the store's
         * own type union (`kind: 'sl';`), and without that distinction every declared kind would count
         * as drawn and this gate would assert nothing.
         */
        const drawn = openable.filter(
            (kind) => SRC.includes(`openSurfaceActionId('${kind}'`) || SRC.includes(`kind: '${kind}',`),
        );
        const drawnWithNoPage = drawn.filter(
            (kind) => !fs.existsSync(path.join(PUBLIC_DIR, `${kind}.html`)),
        );
        if (drawnWithNoPage.length) {
            console.error(`     ↳ a button opens it and there is no page: ${drawnWithNoPage.join(', ')}`);
        }

        // Reported, never asserted: both of these are legitimate states — see the notes above.
        const notDrawnYet = openable.filter((kind) => !drawn.includes(kind));
        if (notDrawnYet.length) console.log(`     ↳ openable, nothing draws it yet: ${notDrawnYet.join(', ')}`);
        const unopenable = kinds.filter((kind) => !openable.includes(kind));
        if (unopenable.length) console.log(`     ↳ reached without a verb: ${unopenable.join(', ')}`);

        return notAKind.length === 0 && noLifetime.length === 0 && drawnWithNoPage.length === 0;
    });

    /**
     * ⚠ **This heading said "The screens are NOT built, and the honest answer is a 503" and the
     * assertion under it asserted their ABSENCE.** Stream E built them on 2026-09-16, deleted
     * that assertion as instructed, and reworded the heading in the same edit — a section title
     * left describing the opposite of what the file now asserts is how a reader trusts the
     * wrong half. The 503 branch itself is unchanged and still pinned below, because it is what
     * any *future* screen kind gets before its HTML lands. Its replacement — that both pages
     * now exist — is the first assertion of § 2.
     */
    console.log('\n── ⚠ The 503 path stays, for whatever screen is unbuilt next ──');

    assert('the controller has that 503 path and does not sendFile blindly', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/miniapp/inapp-page.controller.ts'), 'utf8');
        return src.includes('existsSync(file)') && src.includes('503');
    });

    console.log('\n── ⚠ Until they exist, chat must degrade to something REAL ──');

    /**
     * ⚠ **A dead button is the one outcome that is not allowed.** Store browse opens
     * `inAppStoreListing` in the finished design — there are more than a hundred stores, so a
     * chat picker was never an option — and "load more orders" opens `inAppOrderListing`.
     * Neither exists in milestone 1, so both fall back to the storefront link the chat window
     * already knows how to build (`botStorefrontLink`), and to no reply at all when the
     * deployment has neither.
     *
     * `bot-inapp.controller.ts`'s `respondWithScreen` is where that ladder lives; this pins
     * that the labels it needs are real and translated.
     */
    assert('the fallback labels exist in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            ['viewStoresButton', 'browseAllButton', 'openButton', 'loadMoreRow'].every(
                (key) => botChrome(key as never, lang).trim().length > 0)));

    assert('⛔ the storefront fallback is still wired into the in-app doors', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-inapp.controller.ts'), 'utf8');
        return src.includes('botStorefrontLink') && src.includes("kind: 'link'");
    });

    /**
     * ⚠ The third case is the one that gets forgotten: a deployment with **neither** a screen
     * nor a storefront URL must set no reply at all and let the model speak. What it must
     * never do is render a control with an empty target.
     */
    assert('⛔ with neither a screen nor a storefront, NO control is rendered', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-inapp.controller.ts'), 'utf8');
        return src.includes('setBotReply(req, fallbackUrl ?');
    });

    console.log('\n── Store screens show a CITY and never an address ──');

    /**
     * ⚠ **Owner decision, and it is a privacy rule rather than a layout one.** A store's
     * ship-from address is not public; the city is what a customer needs to judge delivery.
     * The projection Stream E writes must not be able to carry the rest.
     */
    assert('the store heading exists and no address word has crept into the copy table', () => {
        const table = JSON.stringify(__IN_APP_COPY).toLowerCase();
        return Object.prototype.hasOwnProperty.call(__IN_APP_COPY, 'storesHeading')
            && !table.includes('ship-from')
            && !table.includes('street');
    });

    console.log('\n══ § 2 · Stream E\'s own assertions ══');

    /**
     * ⚠ **Comments are stripped before every scan below, and it matters in BOTH directions.**
     *
     * Stream 0 hit the first direction already: its `GETDEL` guard failed on the very file whose
     * docstring *names* `GETDEL` to explain why it is unusable — a correct guard that teaches
     * the next reader to delete the comment making the code legible. This file has the same
     * shape in an even more dangerous place: `order-listing.controller.ts`'s header explains at
     * length why it never touches `codCollections` or `cashCollectionService`, and a naive scan
     * for those names would fail on the explanation of their absence.
     *
     * The second direction is why the helper is used for the positive scans too: an assertion
     * satisfied by a **comment** mentioning `inAppSurfaceStore.read` would pass on a controller
     * that never calls it.
     */
    const codeOf = (file: string): string =>
        fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/[^\n]*$/gm, '');

    /** An HTML page is a comment style of its own, plus the two JavaScript ones inside it. */
    const pageOf = (kind: string): string =>
        fs.readFileSync(path.join(PUBLIC_DIR, `${kind}.html`), 'utf8')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/[^\n]*$/gm, '');

    const SURFACES = path.join(__dirname, '../../src/modules/bot-surface/miniapp/surfaces');
    const ORDER_SRC = codeOf(path.join(SURFACES, 'order-listing.controller.ts'));
    const STORE_SRC = codeOf(path.join(SURFACES, 'store-listing.controller.ts'));

    console.log('\n── The two pages exist now, and the filename IS the route ──');

    /**
     * ⚠ **The replacement for § 1's deleted assertion.** It asserted the pages' ABSENCE while
     * the honest answer to opening them was a 503; this asserts their presence, at the exact
     * two filenames `inapp-page.controller.ts` derives from the screen kind. Renaming either to
     * something more readable — `orders.html`, `stores.html` — turns its screen into a 503 with
     * nothing failing anywhere else, which is why this is pinned rather than assumed.
     */
    assert('⛔ `ol.html` and `sl.html` exist, at exactly those names', () =>
        MINE.every((kind) => fs.existsSync(path.join(PUBLIC_DIR, `${kind}.html`))));

    assert('each page fetches its own data and its own copy', () =>
        MINE.every((kind) => {
            const page = pageOf(kind);
            return page.includes('"/data"') && page.includes('"/copy?lang="');
        }));

    /**
     * ⚠ **No shared browser `.js` beside the pages.** `npm run lint` is `eslint src scripts`,
     * so a browser script under `src/` would be linted as Node code — which is why the shell is
     * a stylesheet (CSS is not linted) and every page's script stays inline.
     */
    assert('no browser JavaScript file has appeared beside the pages', () =>
        fs.readdirSync(PUBLIC_DIR).every((f) => !f.endsWith('.js')));

    console.log('\n── ⛔ A COD delivery code cannot reach the order screen ──');

    /**
     * ⚠ **The one deliberate divergence from the customer API, arriving from a new direction.**
     *
     * `stripDeliveryCodes` exists because `customerOrderViewService.toDtos` resolves COD blocks
     * **with** the code in them — it is the secret a customer hands the agent to prove payment —
     * and the chat surface strips it on every read because a transcript is forwarded,
     * screenshotted and fed to a model. A code rendered on a *screen* is the same leak.
     *
     * ⚠ **What is pinned is that the code is never LOADED, which is stronger than pinning that
     * it is stripped.** A projection you must remember to apply is one somebody eventually
     * forgets; a query that cannot reach the field is not. The controller builds its rows from
     * the order aggregate, one `items.title` projection and one store-name lookup, and the
     * delivery code lives in a different collection reached only through `cashCollectionService`.
     *
     * So the correct future change, if this screen ever does need a richer order view, is NOT
     * to delete this assertion: it is to go through `customerOrderViewService` **and**
     * `stripDeliveryCodes` together, and to rewrite this into the strip-side check.
     */
    assert('⛔ the order screen never reads a COD block, a code, or the view service', () =>
        !/cashCollectionService|customerOrderViewService|codCollections|deliveryCode|getCodBlocksForOrders/
            .test(ORDER_SRC));

    assert('⛔ neither page renders anything code-shaped', () =>
        MINE.every((kind) => !/deliveryCode|codCollections|cod-code/i.test(pageOf(kind))));

    /**
     * ⚠ **"Cash on delivery" is a payment METHOD and must stay one.** It is the one
     * COD-adjacent string this screen is allowed to show, and it exists because a COD order
     * sits at `pending` until the agent collects — so the honest aggregate reads "awaiting
     * payment", which tells a customer who owes nothing yet that they are behind.
     */
    assert('cash on delivery is shown as a method, in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) => ORDER_CASH_ON_DELIVERY_COPY[lang].trim().length > 0));

    /**
     * ⚠ Run against a real checkout rather than against the copy table, so it checks the WIRING —
     * that this screen decides the checkout qualifies and hands that to the shared label — and not
     * merely that the shared table has a string in it.
     */
    assert('an all-COD checkout awaiting collection shows the method, not a debt', () => {
        const group = codGroup();
        return BOT_COPY_LANGUAGES.every((lang) =>
            __ORDER_LISTING.paymentTextOf(group, lang) === ORDER_CASH_ON_DELIVERY_COPY[lang]);
    });

    /** The other half: one prepaid order in the checkout and it is a payment state again. */
    assert('a checkout that is not all cash on delivery is not described as one', () => {
        const group = codGroup();
        group.orders[1] = { ...group.orders[1], paymentMethod: 'online' };
        return __ORDER_LISTING.paymentTextOf(group, 'en') !== ORDER_CASH_ON_DELIVERY_COPY.en;
    });

    console.log('\n── ⛔ A shop shows a CITY and never an address ──');

    /**
     * ⚠ **The card's key set IS the privacy rule, and it is asserted EXACTLY rather than as a
     * denylist.** A check for the absence of `address`, `street` and `coordinates` agrees with
     * any field added to it later — `pickupPoint`, `warehouse`, `geo`. Six named keys cannot.
     *
     * The mapper is fed a store DTO carrying every field `PublicStoreDto` actually has plus
     * three it does not, so the assertion fails both for a spread that republishes the DTO and
     * for a hand-added line.
     */
    assert('⛔ a shop card has exactly six fields, and `city` is the only location', () => {
        const card = __STORE_LISTING.toShopCard(noisyStore() as never) as unknown as Record<string, unknown>;
        return JSON.stringify(Object.keys(card).sort())
            === JSON.stringify(['city', 'imageUrl', 'name', 'open', 'slug', 'verified']);
    });

    /**
     * ⚠ The belt to that braces: even if the key set were widened, nothing address-shaped may
     * appear in the rendered payload. Run against a store whose every text field is poisoned
     * with a recognisable address, so a spread shows up as a value rather than as a key.
     */
    assert('⛔ no address, street or support contact survives the projection', () => {
        const card = JSON.stringify(__STORE_LISTING.toShopCard(noisyStore() as never)).toLowerCase();
        return !card.includes('rue-de-la-fuite')
            && !card.includes('support@')
            && !card.includes('ship-from');
    });

    assert('⛔ the shop page has no address vocabulary of its own', () => {
        const page = pageOf('sl').toLowerCase();
        return !page.includes('address') && !page.includes('street') && !page.includes('ship-from');
    });

    console.log('\n── Chat decides, the app displays ──');

    /**
     * ⚠ **The order screen has NO write path, and that is the architecture rather than a gap.**
     * Cancelling an order, fetching a COD code, tracking a parcel and asking for help all stay
     * in chat, where a decision is one tap and the model can explain what happened. A write
     * appearing here would also need the `consume` posture and a single-use handle, neither of
     * which a thirty-minute listing session has.
     *
     * The store screen's one POST is the exception and is pinned separately below: it mints a
     * session and touches nothing else.
     */
    assert('⛔ the order screen exposes only a read', () =>
        /static\s+data\s*=/.test(ORDER_SRC)
        && !/static\s+(?!data)[a-zA-Z]+\s*=\s*asyncHandler/.test(ORDER_SRC)
        && !ORDER_SRC.includes('.consume(')
        && !ORDER_SRC.includes('.mint('));

    /**
     * ⚠ **The shop tap mints a PRODUCT GRID session and could never mint a checkout.** `read`
     * is kind-checked, so a directory handle cannot be replayed elsewhere; this pins the other
     * direction — what this endpoint is allowed to hand out.
     */
    assert('⛔ the shop tap mints a `pl` session and nothing money-bearing', () =>
        STORE_SRC.includes("kind: 'pl'")
        && !STORE_SRC.includes("kind: 'co'")
        && !STORE_SRC.includes('.consume('));

    /**
     * ⚠ **The owner binding is carried from the session, never read from the request.** It is
     * the security property of the whole surface: a session can only be addressed at the
     * conversation that asked for it. A `req.body` or a header reaching `owner` here would let
     * one customer's page mint a handle onto another's basket.
     */
    assert('⛔ the minted session inherits its owner from the session it came from', () =>
        STORE_SRC.includes('owner: session.owner')
        && STORE_SRC.includes('customerId: session.customerId')
        && !/owner:\s*(req|input|body)/.test(STORE_SRC));

    assert('both screens name the kind they expect when reading a handle', () =>
        ORDER_SRC.includes("read('ol'") && STORE_SRC.includes("read('sl'"));

    /**
     * ⚠ `touch` refuses `co` outright — sliding a checkout credential's expiry defeats the
     * reason it has a short one. These two are listings, where extending on a read is right:
     * somebody scrolling is using the screen.
     */
    assert('both extend their session on a read, and neither touches checkout', () =>
        ORDER_SRC.includes("touch('ol'")
        && STORE_SRC.includes("touch('sl'")
        && !/touch\('co'/.test(ORDER_SRC + STORE_SRC));

    console.log('\n── No money maths and no vocabulary mapping in a WebView ──');

    /**
     * ⚠ **The rule the catalogue and checkout suites already enforce, extended to STATUS
     * WORDS.** A second money implementation in a WebView is a second set of rounding bugs in
     * the one place nothing tests; a second status vocabulary is a screen that contradicts the
     * chat about the same order. Both arrive from the server already rendered.
     */
    assert('⛔ neither page computes money', () =>
        MINE.every((kind) => !/toFixed|parseFloat|Intl\.NumberFormat/.test(pageOf(kind))));

    assert('⛔ neither page maps a raw status to a word', () =>
        MINE.every((kind) => !/partially_shipped|out_for_delivery|AWAITING_PAYMENT/.test(pageOf(kind))));

    assert('the order page renders the server\'s strings verbatim', () => {
        const page = pageOf('ol');
        return page.includes('dateText')
            && page.includes('totalText')
            && page.includes('statusText')
            && page.includes('paymentText');
    });

    console.log('\n── ONE status vocabulary, shared with the chat — and the guards cannot pass vacuously ──');

    /**
     * ⚠ **THE GUARD AGAINST A VACUOUS PASS COMES FIRST, and it is the reason this section was
     * rewritten rather than repointed.**
     *
     * Until 2026-09-16 this screen held its own status tables and these assertions read them.
     * Those tables were deleted in favour of the one in `domain/bot-order-status-copy.ts`, which the
     * chat reads too. The hazard in that move is specific and already bit another stream today:
     * a guard that scans a file for a rule passes FOREVER once the rule has left the file, because
     * there is nothing left to find wrong. backend-fc's three "must not" scans stayed green for
     * exactly that reason.
     *
     * So three things are pinned before any wording is: the shared module resolves and holds what
     * this screen uses; this screen's CODE (comments stripped) actually calls it; and this screen
     * holds no status table of its own that could quietly start disagreeing again.
     */
    assert('⛔ the shared status table is in scope — the import resolves and holds its exports', () =>
        typeof botFulfillmentStateLabel === 'function'
        && typeof botPaymentStateLabel === 'function'
        && typeof ORDER_PROGRESS_OF === 'object'
        && ORDER_PROGRESS_OF !== null
        && Object.keys(ORDER_PROGRESS_OF).length === 9);

    assert('⛔ this screen is wired to the shared labels and holds no status words of its own', () =>
        ORDER_SRC.includes("from '../../domain/bot-order-status-copy'")
        && /botFulfillmentStateLabel\(/.test(ORDER_SRC)
        && /botPaymentStateLabel\(/.test(ORDER_SRC)
        && !/Record<\s*FulfillmentStatus/.test(ORDER_SRC)
        && !/'Order received'|'Preparing'|'On its way'|'Awaiting payment'/.test(ORDER_SRC));

    /**
     * ⚠ **Behavioural, not a scan, and it is the one that proves the point.** For every fulfilment
     * status in every language, the row this screen builds says exactly what the chat says. The
     * chat order list is the first five rows of the list this screen continues; a customer who taps
     * "Load more" must not watch the same order change state, which is the defect that forced the
     * single table in the first place.
     */
    assert('⛔ for every status in every language, this screen says exactly what the chat says', () => {
        const statuses = Object.keys(ORDER_PROGRESS_OF);
        return statuses.length === 9 && BOT_COPY_LANGUAGES.every((lang) =>
            statuses.every((status) => {
                const group = codGroup();
                group.orders[0] = { ...group.orders[0], fulfillmentStatus: status };
                const card = __ORDER_LISTING.toGroupCard(group, lang, new Map(), []);
                return card.orders[0].statusText === botFulfillmentStateLabel(status, lang);
            }));
    });

    console.log('\n── The status vocabulary is total, and neutral where it is not ──');

    /**
     * ⚠ **Read from the SOURCE rather than re-derived from the type**, the rule § 1 states about
     * `BotInAppSurface`: a check that re-derives the list agrees with any change ever made to it.
     * A tenth fulfilment status added to the order model with no customer word must fail here.
     *
     * TypeScript catches this too (`ORDER_PROGRESS_OF` is a total `Record`), which is why this is
     * the belt rather than the braces. It is here because the codebase records `'contract'` and the
     * agent `aggregateType` enum each having drifted past a hand-written literal once already.
     */
    assert('⛔ every fulfilment status in the order model has a customer word', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/orders/order.model.ts'), 'utf8');
        const m = src.match(/export type FulfillmentStatus\s*=\s*([^;]+);/);
        if (!m) return false;
        const members = [...m[1].matchAll(/'([a-zA-Z_]+)'/g)].map((x) => x[1]);
        return members.length === 9
            && members.every((s) => Object.prototype.hasOwnProperty.call(ORDER_PROGRESS_OF, s));
    });

    /**
     * ⚠ **Every verdict the checkout-group aggregate can return has a word, except `unknown`**,
     * which reads as the shared neutral label instead. The aggregate is read from source for the
     * same reason as above.
     */
    assert('⛔ every payment verdict the aggregate can return has copy, bar `unknown`', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-order.controller.ts'), 'utf8');
        const fn = src.match(/export function aggregatePaymentStatus[\s\S]*?\n}/);
        if (!fn) return false;
        const verdicts = [...fn[0].matchAll(/return '([a-z_]+)'/g)].map((x) => x[1]);
        return verdicts.includes('unknown')
            && verdicts
                .filter((v) => v !== 'unknown')
                .every((v) => Object.prototype.hasOwnProperty.call(ORDER_PAYMENT_COPY, v));
    });

    assert('every status, payment and fallback word is present in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            Object.values(ORDER_PROGRESS_COPY).every((c) => c[lang].trim().length > 0)
            && Object.values(ORDER_PAYMENT_COPY).every((c) => c[lang].trim().length > 0)
            && ORDER_STATUS_UNAVAILABLE_COPY[lang].trim().length > 0));

    assert('the shop badges and both empty states are present in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            [__STORE_LISTING.VERIFIED, __STORE_LISTING.CLOSED, __STORE_LISTING.SHOPS_EMPTY,
                __ORDER_LISTING.ORDERS_EMPTY].every((c) => c[lang].trim().length > 0)));

    /**
     * ⚠ **An unrecognised status reads as ONE neutral label, shared with the chat — never the raw
     * internal word and never silence.** Both were in the tree until 2026-09-16: the chat showed
     * the raw token (a customer reading "partially_shipped"), and this screen showed nothing. The
     * coordinator decided the floor, and this pins it on THIS screen's row rather than only on the
     * shared function, so a future local override is caught.
     *
     * The default a person reaches for while adding a status is "Preparing" — which would tell a
     * customer with a cancelled order that their parcel is being packed.
     */
    assert('⛔ an unrecognised status reads as the shared neutral label — never the raw word, never silence', () => {
        const group = codGroup();
        group.orders[0] = { ...group.orders[0], fulfillmentStatus: 'quantum_superposition' };
        const status = __ORDER_LISTING.toGroupCard(group, 'en', new Map(), []).orders[0].statusText;
        return status === ORDER_STATUS_UNAVAILABLE_COPY.en
            && !status.includes('quantum')
            && botFulfillmentStateLabel('delivered', 'en') === 'Delivered';
    });

    /**
     * ⚠ **`pending` and `processing` are two buckets, and this pins the SPLIT, not a wording.**
     *
     * They shared one `preparing` bucket until 2026-09-16, which told a customer whose order nobody
     * had touched that it was being prepared — on `pending`, the state every new order starts in and
     * where a cash-on-delivery order can sit for days. The first fix proposed was to rename the
     * shared bucket to "Order received", which would only have moved the false statement onto
     * `processing`, the one state that does mean somebody has started.
     *
     * ⚠ **It is proven to bite** against two collapsed copies of the real table, so the check
     * cannot pass because it has stopped checking anything.
     */
    const splitHolds = (map: Readonly<Record<string, string>>): boolean =>
        map.pending === 'received' && map.processing === 'preparing';

    assert('⛔ an untouched order says it was received, and only a started one says preparing', () =>
        splitHolds(ORDER_PROGRESS_OF)
        && !splitHolds({ ...ORDER_PROGRESS_OF, processing: 'received' })
        && !splitHolds({ ...ORDER_PROGRESS_OF, pending: 'preparing' })
        && botFulfillmentStateLabel('pending', 'en') === 'Order received'
        && botFulfillmentStateLabel('processing', 'en') === 'Preparing'
        && botFulfillmentStateLabel('pending', 'fr') === 'Commande reçue');

    /**
     * ⚠ **`partially_delivered` keeps its own word rather than collapsing into "on its way".** A
     * customer who has already received half of a multi-vendor checkout must not be told nothing
     * has arrived.
     */
    assert('⛔ a partly delivered checkout is not described as still travelling', () =>
        ORDER_PROGRESS_OF.partially_delivered === 'partly_delivered'
        && ORDER_PROGRESS_OF.partially_shipped === 'shipped');

    console.log('\n── The screens page past what a chat answer can carry ──');

    /**
     * ⚠ **The whole reason these screens exist.** Chat is capped at five rows and
     * `BOT_DISPLAY_MAX_PRODUCTS` at ten; a screen that inherited either would ask a customer to
     * "load more" after nine rows, which is showing them the seams of an implementation.
     */
    assert('both pages hold more than a chat answer, and stay inside the public limit', () =>
        __ORDER_LISTING.PAGE_SIZE > 10
        && __STORE_LISTING.PAGE_SIZE > 10
        && __ORDER_LISTING.PAGE_SIZE <= 100
        && __STORE_LISTING.PAGE_SIZE <= 100);

    assert('the shop page size fills a row evenly at 2, 3 and 4 columns', () =>
        __STORE_LISTING.PAGE_SIZE % 2 === 0
        && __STORE_LISTING.PAGE_SIZE % 3 === 0
        && __STORE_LISTING.PAGE_SIZE % 4 === 0);

    /** A bound on a deep `$skip`, not a product decision — but an unbounded one is a scan. */
    assert('both cursors are bounded rather than open-ended', () =>
        __ORDER_LISTING.MAX_PAGE > 0 && __STORE_LISTING.MAX_PAGE > 0
        && ORDER_SRC.includes('.max(MAX_PAGE)') && STORE_SRC.includes('.max(MAX_PAGE)'));

    /**
     * ⚠ **THE CEILING MUST BE ON THE OFFERING SIDE AS WELL AS THE REFUSING SIDE.** Found on
     * 2026-09-16, after the screens had already shipped.
     *
     * The first version advertised `page + 1` whenever more rows existed, and the cursor schema
     * refuses anything above `MAX_PAGE`. So at the last page the customer is shown "Load more",
     * the tap is rejected as a validation error, and the page renders "Something went wrong" —
     * a customer told the screen is broken when they have merely reached the end of it.
     *
     * Reaching it needs four thousand checkouts or four thousand eight hundred shops, which is
     * why it survived review: it is invisible until the one customer who has that much history
     * meets it, and they meet it as a fault. Both bounds are pinned here because the two answer
     * different questions — what may be ASKED FOR, and what may be OFFERED — and a bound that
     * exists only on the refusing side turns a natural end into an error.
     */
    assert('⛔ neither screen offers a page its own schema would refuse', () =>
        [__ORDER_LISTING, __STORE_LISTING].every((s) => {
            const huge = s.PAGE_SIZE * (s.MAX_PAGE + 50);
            return s.nextCursor(s.MAX_PAGE, huge) === null
                && s.nextCursor(s.MAX_PAGE - 1, huge) === String(s.MAX_PAGE)
                && s.nextCursor(1, s.PAGE_SIZE) === null
                && s.nextCursor(1, s.PAGE_SIZE + 1) === '2';
        }));

    /**
     * ⚠ **A vanished shop must not read as a dead screen.** Also found after shipping.
     *
     * `sl.html`'s `explain()` maps every 404 to "This page is no longer available — ask me again
     * in the chat", because on every other path a 404 means the handle has lapsed. Letting
     * `getStoreBySlug`'s own 404 through therefore told a customer whose screen was working
     * perfectly to close it, because one shop had been unpublished since the page rendered.
     *
     * 422 is the grid's posture for "that item is not on this list", and it is the only thing
     * that makes the two 404-shaped faults distinguishable to a page that can see a status code
     * and nothing else.
     */
    assert('⛔ a shop that has gone is refused as 422, never as the screen having lapsed', () =>
        /catch\s*\{[\s\S]*?BOT_PRODUCT_NOT_IN_LIST[\s\S]*?422/.test(STORE_SRC)
        && STORE_SRC.includes('getStoreBySlug'));

    console.log('\n── The row a customer actually reads ──');

    /**
     * Three titles and a count rather than a sentence: `+2` needs no translation and no plural
     * rule, and Arabic alone has six of those. Duplicates collapse because two lines of the
     * same product read as two different things.
     */
    assert('a checkout summary dedupes, caps at three, and counts the rest', () =>
        __ORDER_LISTING.summarise([]) === null
        && __ORDER_LISTING.summarise(['  ', '']) === null
        && __ORDER_LISTING.summarise(['Shoes', 'Shoes']) === 'Shoes'
        && __ORDER_LISTING.summarise(['a', 'b', 'c', 'd', 'e']) === 'a · b · c +2');

    /**
     * ⚠ The whole card, end to end: every value a named string, nothing spread, and the totals
     * already formatted. `store-listing`'s equivalent is the six-key assertion above.
     */
    assert('an order card is built from named fields and carries no raw amounts', () => {
        const card = __ORDER_LISTING.toGroupCard(
            codGroup(), 'en', new Map([['v1', { name: 'Chez Mado' }]]), ['Shoes'],
        ) as unknown as Record<string, unknown>;
        return JSON.stringify(Object.keys(card).sort())
            === JSON.stringify(['cartId', 'dateText', 'orders', 'paymentText', 'summaryText', 'totalText'])
            && typeof card.totalText === 'string'
            && (card.totalText as string).includes('XAF')
            && JSON.stringify(Object.keys((card.orders as Record<string, unknown>[])[0]).sort())
                === JSON.stringify(['orderNumber', 'statusText', 'storeName']);
    });

    console.log('\n══ § 3 · "Show my orders", answered in the chat (chat-surfaces, 2026-09-22) ══');

    /**
     * ⭐ **The owner's rule: the assistant must survive without buttons, and "show my orders" is
     * answered IN THE CHAT** — up to five orders as a list the customer can pick from, plus a Load
     * more row that opens the rest on the order screen. It is not answered by jumping straight to
     * the screen, which is what the model did on 2026-09-22 (core exec 1942).
     *
     * These drive the REAL `orders_list_groups` handler with the repository replaced, and render
     * what it set through the REAL WhatsApp renderer — the shape the customer reads.
     */
    console.log('\n── The designed shape ──');

    const seven = lists.seven;
    assert('seven orders → five order rows plus the Load more row, as ONE WhatsApp list', () => {
        const wa = whatsappListOf(seven.intent);
        return seven.error === null
            && seven.intent?.kind === 'choice'
            && wa !== null
            && wa.rows.length === 6
            && wa.rows.slice(0, 5).every((row) => row.id.startsWith('ord:'))
            && wa.rows[5].id === openSurfaceActionId('ol')
            && wa.rows[5].title === botChrome('loadMoreRow', 'en');
    });

    assert('the list asks which order, in the customer\'s language', () =>
        lists.sevenFr.intent?.kind === 'choice'
        && lists.sevenFr.intent.text === botOrderCopy('whichOrder', 'fr')
        && whatsappListOf(lists.sevenFr.intent)?.rows[5].title === botChrome('loadMoreRow', 'fr'));

    assert('three orders → three rows and NO Load more row', () => {
        const wa = whatsappListOf(lists.three.intent);
        return wa !== null && wa.rows.length === 3 && wa.rows.every((row) => row.id.startsWith('ord:'));
    });

    /**
     * ⚠ A basket split across sellers is SEVERAL orders in one group. Three groups of two is six
     * orders on the first page of groups; the list shows five and must still offer the rest, even
     * though the GROUP window says nothing is left.
     */
    assert('three baskets of two sellers each → five rows and the Load more row, though no group is left', () => {
        const wa = whatsappListOf(lists.split.intent);
        return wa !== null && wa.rows.length === 6 && wa.rows[5].id === openSurfaceActionId('ol');
    });

    assert('no orders → no list at all, and the turn is the model\'s to word', () =>
        lists.none.error === null && lists.none.intent === null);

    assert('the data keeps its group shape, so the model can still answer about one order', () =>
        Array.isArray(seven.body?.data) && (seven.body?.data as unknown[]).length === 5);

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
//  § 3's harness — the real order-list handler, with the repository replaced
// ─────────────────────────────────────────────────────────────────────────────

interface ListRun {
    intent: BotReplyIntent | null | undefined;
    body: Record<string, unknown> | null;
    error: unknown;
}

/** `n` one-seller checkouts, newest first, or `groups` baskets of `perGroup` sellers each. */
function groupsOf(groups: number, perGroup: number): CustomerOrderGroup[] {
    return Array.from({ length: groups }, (_, g) => ({
        cartId: `cart-${g}`,
        createdAt: new Date(Date.UTC(2026, 8, 20 - g)),
        currency: 'XAF',
        totalAmount: 5000 * perGroup,
        orderCount: perGroup,
        paymentStatuses: Array.from({ length: perGroup }, () => 'paid'),
        orders: Array.from({ length: perGroup }, (_, o) => ({
            id: `${String(g).padStart(12, '0')}${String(o).padStart(12, '0')}`,
            orderNumber: `ORD-2026-${String(g * 10 + o).padStart(6, '0')}`,
            vendorId: `v${o}`,
            orderType: 'physical',
            total: 5000,
            currency: 'XAF',
            paymentMethod: 'online',
            paymentStatus: 'paid',
            fulfillmentStatus: 'processing',
            itemCount: 1,
            createdAt: new Date(Date.UTC(2026, 8, 20 - g)),
        })),
    }));
}

/**
 * Call `POST /orders/list` as the router would, with `findGroupsByCustomer` answering from
 * `all` — windowed exactly as Mongo would window it (page, limit, total).
 */
async function runOrderList(all: CustomerOrderGroup[], language: string): Promise<ListRun> {
    const proto = OrderRepository.prototype as unknown as {
        findGroupsByCustomer: (customerId: string, pagination: { page?: number; limit?: number }) => Promise<unknown>;
    };
    const real = proto.findGroupsByCustomer;
    proto.findGroupsByCustomer = async (_customerId, { page = 1, limit = 20 }) => ({
        data: all.slice((page - 1) * limit, page * limit),
        meta: { total: all.length, page, limit, pages: Math.max(1, Math.ceil(all.length / limit)) },
    });
    const req = {
        body: {},
        params: {},
        bot: {
            caller: { userId: 'u-test', customerId: 'c-test', channel: 'whatsapp', externalIdentity: '237600000001' },
            envelope: { channel: 'whatsapp', externalId: '237600000001' },
            tool: 'orders_list_groups',
            anonymous: false,
            language,
        },
    } as unknown as Request;
    try {
        return await new Promise<ListRun>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the order list neither answered nor failed')), 5000);
            const res = {
                status: () => res,
                json: (body: Record<string, unknown>) => {
                    clearTimeout(timer);
                    resolve({ intent: req.bot?.replyIntent, body, error: null });
                    return res;
                },
            } as unknown as Response;
            BotOrderController.list(req, res, (error?: unknown) => {
                clearTimeout(timer);
                resolve({ intent: req.bot?.replyIntent, body: null, error: error ?? null });
            });
        });
    } finally {
        proto.findGroupsByCustomer = real;
    }
}

/** The rows of the WhatsApp list a reply renders to, or null when it is not a list. */
function whatsappListOf(intent: BotReplyIntent | null | undefined): { rows: { id: string; title: string }[] } | null {
    if (!intent) return null;
    const [reply] = renderBotReplies(intent, 'whatsapp', '237600000001');
    const interactive = (reply?.body as { interactive?: { type?: string; action?: { sections?: { rows?: { id: string; title: string }[] }[] } } })
        .interactive;
    if (interactive?.type !== 'list') return null;
    return { rows: (interactive.action?.sections ?? []).flatMap((section) => section.rows ?? []) };
}

let lists: Record<'seven' | 'sevenFr' | 'three' | 'split' | 'none', ListRun>;

async function runOrderLists(): Promise<void> {
    lists = {
        seven: await runOrderList(groupsOf(7, 1), 'en'),
        sevenFr: await runOrderList(groupsOf(7, 1), 'fr'),
        three: await runOrderList(groupsOf(3, 1), 'en'),
        split: await runOrderList(groupsOf(3, 2), 'en'),
        none: await runOrderList([], 'en'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fixtures — § 2's own, DB-free
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A two-vendor checkout paid in cash on delivery, with nothing collected yet.
 *
 * ⚠ **This is the shape the COD assertion turns on.** Both orders sit at `pending`, so
 * `aggregatePaymentStatus` honestly answers `awaiting_payment` — which on a screen would tell a
 * customer who owes nothing yet that they are behind on a payment. The method is the truer
 * thing to show, and only when EVERY order in the checkout is COD.
 */
function codGroup(): CustomerOrderGroup {
    const order = (id: string, vendorId: string) => ({
        id,
        orderNumber: `ORD-2026-${id}`,
        vendorId,
        orderType: 'physical',
        total: 6000,
        currency: 'XAF',
        paymentMethod: 'cash_on_delivery',
        paymentStatus: 'pending',
        fulfillmentStatus: 'processing',
        itemCount: 1,
        createdAt: new Date('2026-09-16T10:00:00Z'),
    });

    return {
        cartId: 'cart-1',
        createdAt: new Date('2026-09-16T10:00:00Z'),
        currency: 'XAF',
        totalAmount: 12000,
        orderCount: 2,
        paymentStatuses: ['pending', 'pending'],
        orders: [order('0001', 'v1'), order('0002', 'v2')],
    };
}

/**
 * A store DTO with every field `PublicStoreDto` really has, each poisoned with a recognisable
 * string, **plus three fields it does not have**.
 *
 * ⚠ **The three extras are the point.** `toShopCard` is asserted to produce exactly six keys, so
 * a spread of the DTO fails on the real fields; these catch the other mistake — somebody adding
 * a line to the mapper for a field that appears on the DTO later. The address strings are
 * distinctive so a leak shows up as a *value* in the rendered JSON, not only as a key.
 */
function noisyStore(): Record<string, unknown> {
    return {
        slug: 'chez-mado',
        name: 'Chez Mado',
        description: 'Warehouse at 12 rue-de-la-fuite',
        logo: { id: 'f1', key: 'by-type/logos/f1.png', url: 'https://cdn.example/f1.png', visibility: 'public' },
        banner: { id: 'f2', key: 'by-type/banners/f2.png', url: 'https://cdn.example/f2.png', visibility: 'public' },
        isOpen: true,
        supportEmail: 'support@chez-mado.example',
        supportPhone: '+237600000000',
        supportWhatsapp: '+237600000000',
        country: 'CM',
        city: 'Douala',
        verified: true,
        productCount: 42,
        memberSince: '2025-01-01T00:00:00.000Z',
        // Not on the DTO today. Here so that adding them later cannot pass this file unread.
        shipFromAddress: '12 rue-de-la-fuite, Akwa',
        street: 'rue-de-la-fuite',
        coordinates: { lat: 4.05, lng: 9.7 },
    };
}

main().catch((error: unknown) => {
    console.error(`  ❌ THROW: the suite itself — ${(error as Error).message}`);
    process.exit(1);
});
