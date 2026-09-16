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
import { CustomerOrderGroup } from '../../src/modules/orders/order.repository';

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
 * ⚠ `as const` rather than `InAppSurfaceKind[]`, and the difference is load-bearing:
 * `openSurfaceActionId` takes `BotInAppSurface`, which is now all FIVE screen kinds. `co`
 * was added on 2026-09-16 — see the assertion below for why that is safe and what replaced
 * the membership check that used to stand in for it.
 */
const MINE = ['ol', 'sl'] as const;

function main(): void {
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
     * ⚠ **Read from the SOURCE, not re-derived from the type**, for the reason
     * `test-notification-deeplinks.ts` gives about its own hardcoded literal: a check that
     * re-derives the list agrees with any change ever made to it. Adding a sixth openable
     * surface must fail here and be an explicit decision.
     */
    assert('the openable surfaces are exactly the five screen kinds', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/domain/bot-action-id.ts'), 'utf8');
        const m = src.match(/export type BotInAppSurface\s*=\s*([^;]+);/);
        if (!m) return false;
        const members = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
        return JSON.stringify(members) === JSON.stringify(['co', 'ol', 'pd', 'pl', 'sl']);
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
        BOT_COPY_LANGUAGES.every((lang) => __ORDER_LISTING.CASH_ON_DELIVERY[lang].trim().length > 0));

    assert('an all-COD checkout awaiting collection shows the method, not a debt', () => {
        const group = codGroup();
        return BOT_COPY_LANGUAGES.every((lang) =>
            __ORDER_LISTING.paymentTextOf(group, lang) === __ORDER_LISTING.CASH_ON_DELIVERY[lang]);
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

    console.log('\n── The status vocabulary is total, and silent where it is not ──');

    /**
     * ⚠ **Read from the SOURCE rather than re-derived from the type**, the rule § 1 states about
     * `BotInAppSurface`: a check that re-derives the list agrees with any change ever made to
     * it. A tenth fulfilment status added to the order model with no customer word here must
     * fail, because the alternative is an order row that silently says nothing about its
     * progress — or worse, inherits a default.
     *
     * TypeScript catches this too (`PROGRESS_OF` is a total `Record`), which is why this is the
     * belt rather than the braces. It is here because the same file records `'contract'` and the
     * agent `aggregateType` enum each having drifted past a hand-written literal once already.
     */
    assert('⛔ every fulfilment status in the order model has a customer word', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/modules/orders/order.model.ts'), 'utf8');
        const m = src.match(/export type FulfillmentStatus\s*=\s*([^;]+);/);
        if (!m) return false;
        const members = [...m[1].matchAll(/'([a-zA-Z_]+)'/g)].map((x) => x[1]);
        return members.length === 9
            && members.every((s) => Object.prototype.hasOwnProperty.call(__ORDER_LISTING.PROGRESS_OF, s));
    });

    /**
     * ⚠ **Every word the aggregate can produce has copy, EXCEPT `unknown`.** The payment label
     * is keyed on `aggregatePaymentStatus`'s output rather than on `PaymentStatus`, because a
     * checkout is several orders and they can disagree. `unknown` is returned only for an empty
     * group — impossible in practice — and deliberately renders no label at all.
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
                .every((v) => Object.prototype.hasOwnProperty.call(__ORDER_LISTING.PAYMENT_COPY, v));
    });

    assert('every status and payment word is present in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            Object.values(__ORDER_LISTING.PROGRESS_COPY).every((c) => c[lang].trim().length > 0)
            && Object.values(__ORDER_LISTING.PAYMENT_COPY).every((c) => c[lang].trim().length > 0)));

    assert('the shop badges and both empty states are present in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            [__STORE_LISTING.VERIFIED, __STORE_LISTING.CLOSED, __STORE_LISTING.SHOPS_EMPTY,
                __ORDER_LISTING.ORDERS_EMPTY].every((c) => c[lang].trim().length > 0)));

    /**
     * ⚠ **A status we do not publish renders NOTHING rather than a guess.** The aggregation
     * pipeline types this field as a plain `string`, so the map cannot be the only guard. The
     * default a person reaches for while adding a status is "Preparing" — which would tell a
     * customer with a cancelled order that their parcel is being packed.
     */
    assert('⛔ an unrecognised fulfilment status renders no word at all', () =>
        __ORDER_LISTING.fulfilmentTextOf('quantum_superposition', 'en') === null
        && __ORDER_LISTING.fulfilmentTextOf('', 'en') === null
        && __ORDER_LISTING.fulfilmentTextOf('delivered', 'en') === 'Delivered');

    /**
     * ⚠ **`partially_delivered` keeps its own word rather than collapsing into "on its way".**
     * Nine internal statuses become six customer words, and this is the one place the collapse
     * would state something false: a customer who has already received half of a multi-vendor
     * checkout must not be told nothing has arrived.
     */
    assert('⛔ a partly delivered checkout is not described as still travelling', () =>
        __ORDER_LISTING.PROGRESS_OF.partially_delivered === 'partly_delivered'
        && __ORDER_LISTING.PROGRESS_OF.partially_shipped === 'shipped');

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

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
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

main();
