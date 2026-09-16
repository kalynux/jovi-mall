/**
 * Test: STREAM B — the product listing and product detail screens.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 * Five sessions build this surface in **one working tree with no branching**. Two sessions
 * appending to one shared suite is a read-then-write race on disk, not a merge conflict — one
 * session's work simply disappears. So `test-bot-surface.ts` is touched by **nobody**, and
 * this file is **Stream B's alone**.
 *
 * § 1 is Stream 0's and pins what Stream B inherits. § 2 is where Stream B's own assertions go.
 *
 * Run: npm run test:inapp-catalog
 */
import fs from 'fs';
import path from 'path';
import { __SCREEN_KINDS } from '../../src/modules/bot-surface/miniapp/inapp-page.controller';
import { __IN_APP_COPY, assertInAppCopyComplete, inAppCopy } from '../../src/modules/bot-surface/miniapp/inapp-copy';
import { TTL_SECONDS, __IN_APP_HANDLE_PREFIX } from '../../src/modules/bot-surface/services/inapp-surface.store';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { BOT_DISPLAY_MAX_PRODUCTS } from '../../src/modules/bot-surface/services/product-display.service';
import { __LISTING_PAGE_SIZE } from '../../src/modules/bot-surface/miniapp/surfaces/product-listing.controller';

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
const readPage = (kind: string): string => fs.readFileSync(path.join(PUBLIC_DIR, `${kind}.html`), 'utf8');

/** The screens Stream B owns. The other three belong to Streams D and E. */
const MINE = ['pl', 'pd'];

function main(): void {
    console.log('\n══ § 1 · The contract Stream 0 froze (do not edit) ══');

    console.log('\n── The screens exist and are routable ──');

    /**
     * ⚠ **The filename IS the route.** `inapp-page.controller.ts` sends `public/<kind>.html`,
     * so renaming a file silently turns its screen into a 503 — "not available yet" — with
     * nothing failing anywhere else.
     */
    assert('every screen Stream B owns has its page, named for its kind', () =>
        MINE.every((kind) => fs.existsSync(path.join(PUBLIC_DIR, `${kind}.html`))));

    assert('the page controller\'s kind allowlist covers both', () =>
        MINE.every((kind) => (__SCREEN_KINDS as readonly string[]).includes(kind)));

    /**
     * ⚠ **An allowlist, never a sanitiser.** `:kind` is a URL segment interpolated into a
     * filename, which without a closed set is a path-traversal primitive. Express decodes the
     * segment for us, so this check is the whole defence.
     */
    assert('⛔ the allowlist is closed — no traversal segment can pass it', () =>
        !(__SCREEN_KINDS as readonly string[]).some((k) => k.includes('.') || k.includes('/') || k.includes('\\')));

    console.log('\n── The shared shell ──');

    /**
     * ⚠ `shell.css` loads only because the route's CSP carries `style-src 'self'` AND the
     * router serves the file. Break either half and the browser refuses the request with **no
     * error on this side** — the customer gets an unstyled page, which is reported as "the
     * shop is broken" rather than as a misconfiguration.
     */
    assert('every page links the shared stylesheet', () =>
        MINE.every((kind) => readPage(kind).includes('/api/bot/miniapp/shell.css')));

    assert('the stylesheet is served by the miniapp router', () => {
        const routes = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/miniapp/miniapp.routes.ts'), 'utf8');
        return routes.includes("router.get('/shell.css'");
    });

    assert('⛔ the CSP that permits it is still in place', () => {
        const controller = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/miniapp/inapp-page.controller.ts'), 'utf8');
        return controller.includes("style-src 'self' 'unsafe-inline'");
    });

    assert('the stylesheet exists and uses logical properties, so Arabic flips', () => {
        const css = fs.readFileSync(path.join(PUBLIC_DIR, 'shell.css'), 'utf8');
        return css.includes('inset-inline-start') && css.includes('padding-inline');
    });

    /**
     * ⚠ **No shared browser `.js` under `src/`.** `npm run lint` is
     * `eslint src scripts --max-warnings 0`, and a shared script here would be linted as Node
     * code with `window` and `document` undefined. CSS is not linted. So: styles shared,
     * scripts inline per page.
     */
    assert('⛔ no shared browser script has appeared beside the pages', () =>
        !fs.readdirSync(PUBLIC_DIR).some((f) => f.endsWith('.js')));

    console.log('\n── Words ──');

    assert('every in-app copy key resolves in all five languages', () => {
        assertInAppCopyComplete();
        return BOT_COPY_LANGUAGES.every((lang) =>
            Object.keys(__IN_APP_COPY).every((k) => (inAppCopy(lang) as Record<string, string>)[k]?.length > 0));
    });

    /**
     * A page reading `copy.somethingMisspelled` renders the string "undefined" to a customer,
     * and nothing anywhere fails. This is the only check that catches it.
     */
    assert('every copy key a page reads actually exists', () => {
        const known = Object.keys(__IN_APP_COPY);
        return MINE.every((kind) => {
            const used = [...new Set([...readPage(kind).matchAll(/\bcopy\.([a-zA-Z]+)/g)].map((m) => m[1]))];
            const unknown = used.filter((k) => !known.includes(k));
            if (unknown.length > 0) console.error(`      ${kind}.html reads unknown keys: ${unknown.join(', ')}`);
            return unknown.length === 0;
        });
    });

    console.log('\n── ⚠ The B/C seam: the button is rendered here and DECIDED on the server ──');

    /**
     * ⚠ **The single most important rule in this file.** `resolvePurchaseAffordance()` is the
     * one source of truth for which of the four rungs a product is on, and the data endpoint
     * returns its result verbatim, already translated. If Stream B hardcodes a label, Stream B
     * and Stream C both own the button and neither can finish — and a customer sees one word
     * on the chat card and a different one on the screen for the same product.
     */
    const RUNG_WORDS = ['Add to cart', 'Buy now', 'Bargain', 'Book'];

    assert('⛔ no screen hardcodes a purchase-ladder label', () =>
        MINE.every((kind) => {
            const html = readPage(kind);
            // Comments are where the rule is explained, so they are stripped before the scan.
            const code = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const hits = RUNG_WORDS.filter((w) => code.includes(w));
            if (hits.length > 0) console.error(`      ${kind}.html hardcodes: ${hits.join(', ')}`);
            return hits.length === 0;
        }));

    assert('the detail screen reads the label off the affordance the server sent', () =>
        readPage('pd').includes('affordance.label') && readPage('pd').includes('affordance.enabled'));

    /**
     * ⚠ What the page posts is a variant id, never a verb. A page is a thing a customer can
     * edit; one that could name its own rung could ask to "buy now" something negotiable, or
     * add a service the cart refuses.
     */
    assert('⛔ the detail screen sends a variantId, never a verb', () => {
        const code = readPage('pd').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        return code.includes('variantId: v.variantId') && !/body:\s*JSON\.stringify\([^)]*verb/.test(code);
    });

    console.log('\n── Money ──');

    /**
     * ⚠ A WebView that computes money is a second implementation of delivery fees, discounts
     * and the negotiated price lock, in the one place nothing tests. Prices arrive formatted.
     */
    assert('⛔ no screen does money arithmetic', () =>
        MINE.every((kind) => {
            const code = readPage(kind).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
            return !code.includes('toFixed') && !code.includes('parseFloat') && !code.includes('Intl.NumberFormat');
        }));

    console.log('\n── Sessions ──');

    assert('listing and detail sessions live 30 minutes', () =>
        TTL_SECONDS.pl === 1800 && TTL_SECONDS.pd === 1800);

    assert('the handle prefix is the in-app one, not the old rail\'s', () =>
        __IN_APP_HANDLE_PREFIX === 'ia_');

    console.log('\n══ § 2 · Stream B\'s own assertions ══');

    /**
     * ⚠ **Comments are stripped before every scan below, and it matters in BOTH directions.**
     *
     * Stream 0 hit the first direction already: its `GETDEL` guard failed on the very file
     * whose docstring *names* `GETDEL` to explain why it is unusable — a correct guard that
     * teaches the next reader to delete the comment making the code legible.
     *
     * The second direction is the dangerous one and is why this helper is used for the
     * positive assertions too: a scan satisfied by a **comment** mentioning
     * `resolvePurchaseAffordance` would pass on a controller that never calls it, and the
     * customer would get a button labelled "undefined".
     */
    const codeOf = (file: string): string =>
        fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/[^\n]*$/gm, '');

    const SURFACES = path.join(__dirname, '../../src/modules/bot-surface/miniapp/surfaces');
    const LISTING = codeOf(path.join(SURFACES, 'product-listing.controller.ts'));
    const DETAIL = codeOf(path.join(SURFACES, 'product-detail.controller.ts'));

    console.log('\n── The grid pages past ten ──');

    /**
     * ⚠ **The single most likely way this screen gets quietly ruined later.**
     * `BOT_DISPLAY_MAX_PRODUCTS` (10) bounds what a *chat* answer may carry, and a listing
     * that inherits it looks broken at row eleven: the customer taps "Load more" after nine
     * products and reads it as the shop having nothing else. `inapp-surface.store.ts` argues
     * both doctrines at length — the chat path holds *ids* so page two cannot re-run a search,
     * this path holds the *query* precisely so it can page. Do not unify them.
     */
    assert('⛔ a page of the grid is larger than the chat rail\'s whole set', () =>
        __LISTING_PAGE_SIZE > BOT_DISPLAY_MAX_PRODUCTS);

    assert('the page size fills a row evenly at 2, 3 and 4 columns', () =>
        __LISTING_PAGE_SIZE % 2 === 0 && __LISTING_PAGE_SIZE % 3 === 0 && __LISTING_PAGE_SIZE % 4 === 0);

    /**
     * `LimitSchema` caps a public catalogue read at 100. A page size above it would not fail
     * loudly — the query is built as a literal here rather than parsed — it would just ask for
     * more than the contract allows.
     */
    assert('the page size stays inside the public catalogue\'s own limit', () =>
        __LISTING_PAGE_SIZE <= 100);

    /**
     * ⚠ **The last "Load more" must be an ENDING, not an ERROR.** The cursor is bounded, so a
     * grid that emitted `MAX_PAGE + 1` would hand the page a value its own validator refuses —
     * the page sends it straight back, gets a 400, and renders "something went wrong". A
     * customer who has scrolled to the bottom of a large catalogue would be told the shop is
     * broken at the moment it merely ran out of products. A null cursor hides the button.
     */
    assert('⛔ the grid stops emitting a cursor at its own ceiling', () =>
        LISTING.includes('page < MAX_PAGE'));

    console.log('\n── The listing pages the QUERY, not a held list of ids ──');

    assert('the listing reads its session as a query and pages it server-side', () =>
        LISTING.includes('publicCatalogService.listProducts') && LISTING.includes('page,'));

    /**
     * ⚠ A card quotes a price a customer can hold us to, and a listing lives thirty minutes.
     * Page two must say what the product costs NOW, so nothing catalogue-shaped may be written
     * back onto the session — the session holds the question and the catalogue answers it on
     * every read.
     *
     * The listing mints exactly once, and it is the DETAIL session `open` hands out; the detail
     * screen mints nothing at all.
     */
    assert('⛔ neither screen writes catalogue data back onto a session', () => {
        const mints = [...LISTING.matchAll(/inAppSurfaceStore\.mint\(/g)].length;
        return mints === 1 && LISTING.includes("kind: 'pd'") && !DETAIL.includes('.mint(');
    });

    console.log('\n── The handle is kind-checked on every read ──');

    /**
     * ⚠ A `pd` handle replayed against `/s/pl/…` must read as absent. Naming the kind at the
     * call site is what makes that true by construction rather than by a guard somebody can
     * forget — `read` refuses a mismatch and returns the narrowed session with no cast.
     */
    assert('the listing names its kind on read', () => LISTING.includes("read('pl'"));
    assert('the detail names its kind on read', () => DETAIL.includes("read('pd'"));

    /**
     * ⚠ **`consume` is the checkout's posture and must not appear here.** These two screens are
     * read repeatedly — every open, every retry, every page — and a single-use handle would
     * die on the customer's first scroll.
     */
    assert('⛔ neither screen spends its handle', () =>
        !LISTING.includes('.consume(') && !DETAIL.includes('.consume('));

    console.log('\n── ⚠ The membership check on /open ──');

    /**
     * ⚠ The old rail's rule: the session is the authority on what the page was allowed to
     * offer. A pinned session (a wishlist, or a grid the model chose) is checked exactly
     * against the ids it holds; a query session has no membership set without re-running the
     * query, so it is bounded by publishability instead — the same bound the query has.
     * The residual is stated in `assertOfferable`'s docstring rather than hidden.
     */
    assert('/open checks a pinned session against the ids it holds', () =>
        LISTING.includes('pinned.includes(productId)'));

    assert('/open refuses with the not-in-list code, never the expiry one', () =>
        LISTING.includes('BOT_PRODUCT_NOT_IN_LIST'));

    /**
     * ⚠ **The `open` route mints a session and is NOT a purchase.** Nothing on it may touch a
     * cart, a price or an order — the purchase button lives one screen later and its write
     * belongs to another stream entirely.
     */
    assert('⛔ /open touches no cart and no order', () =>
        !LISTING.includes('cartService') && !LISTING.includes('CartService') && !LISTING.includes('OrderService'));

    console.log('\n── ⚠ The B/C seam, from the server\'s side ──');

    /**
     * ⚠ **The detail screen must return `resolvePurchaseAffordance()`'s result verbatim.**
     * § 1 proves the *page* hardcodes no label; this proves the *server* actually resolves one
     * rather than the page simply never being handed anything. Both halves are needed — a page
     * that reads `affordance.label` off a field nothing sets renders the string "undefined".
     */
    assert('the detail resolves the affordance through the one shared ladder', () =>
        DETAIL.includes('resolvePurchaseAffordance(') && DETAIL.includes('affordance.verb'));

    assert('the label is translated server-side through the chat\'s own chrome table', () =>
        DETAIL.includes('botChrome(affordance.labelKey'));

    /**
     * ⚠ **Per VARIANT, not per product — the whole reason this screen exists.** A product may
     * sell one variant at a fixed price and another with a bargaining window open, so the list
     * row's answer (which reports its *default* variant) cannot be applied across the picker.
     */
    assert('⛔ the affordance is resolved from the VARIANT\'s negotiable flag', () =>
        DETAIL.includes('negotiable: variant.negotiable'));

    /**
     * ⚠ Nothing here may narrow the ladder. A second opinion about the rung on this surface is
     * how a customer sees one word on the chat card and a different one on the screen.
     */
    assert('⛔ the detail hardcodes no rung label of its own', () => {
        const hits = RUNG_WORDS.filter((w) => DETAIL.includes(w));
        if (hits.length > 0) console.error(`      product-detail.controller.ts hardcodes: ${hits.join(', ')}`);
        return hits.length === 0;
    });

    /** ⚠ The write is another stream's. This file renders; it must not act. */
    assert('⛔ the detail controller does not implement the write', () =>
        !DETAIL.includes('/act') && !DETAIL.includes('executePurchase'));

    console.log('\n── A simple-mode product needs no taps ──');

    /**
     * A `simple` product has zero options and exactly one variant, so the picker draws nothing
     * and the button is live on arrival. That is the common case and it must stay the quiet
     * one — the page returns `product.variants[0]` when `options` is empty, which only works
     * because this projection emits every variant rather than only matched ones.
     */
    assert('the detail emits every variant, so a one-variant product resolves with no picker', () =>
        DETAIL.includes('product.variants.map('));

    assert('the page takes the lone variant when there are no options', () =>
        readPage('pd').includes('if (!product.options.length) return product.variants[0];'));

    console.log('\n── Money stays on the server ──');

    /**
     * ⚠ A **service** variant's `price` is a UNIT RATE, not a total. The DTO ships `priceFrom`
     * and `priceUnit` beside it for exactly that, and the documented rendering is
     * "from {priceFrom} · {priceUnit}". Printing `price` alone quotes a 60-minute rate to
     * somebody booking 90 minutes — a misquote the customer only discovers at the invoice.
     */
    assert('⛔ a service variant is priced from priceFrom and priceUnit, never its unit rate alone', () =>
        DETAIL.includes('variant.service.priceFrom') && DETAIL.includes('variant.service.priceUnit'));

    assert('both controllers format money through the platform\'s one formatter', () =>
        LISTING.includes('formatBotPrice') && DETAIL.includes('formatBotPrice'));

    /**
     * ⚠ ICU is refused on this path for the reason `product-card.ts` records: it renders XAF
     * with a narrow no-break space whose code point differs between Node builds, and its
     * grouping character would disagree with every other price this platform prints.
     */
    assert('⛔ neither controller reaches for ICU', () =>
        !LISTING.includes('Intl.NumberFormat') && !DETAIL.includes('Intl.NumberFormat'));

    console.log('\n── ⚠ A ship-from address stays private ──');

    /**
     * ⚠ `business_addresses[]` are the places a vendor ships from — a home or a warehouse,
     * with a street line and exact coordinates. The public DTO publishes the city and nothing
     * else; this projection must not reach past it.
     */
    assert('⛔ the detail publishes the store city and no other address component', () =>
        DETAIL.includes('storeCity: product.store.city')
        && !DETAIL.includes('business_addresses')
        && !DETAIL.includes('store.country'));

    console.log('\n── ⚠ THE RETIREMENT — the old rail is replaced, not left beside the new one ──');

    /**
     * ⚠ **This assertion is written to FAIL LOUDLY the day the swap happens, and that is its
     * job.** R10: the new listing is built beside the old rail, the chat card's button is
     * repointed at it, the old page is proven dark on a real handset, and only then are
     * `miniapp.controller.ts` and `public/page.html` deleted.
     *
     * ⚠ **The deletion is a TWO-SESSION action.** `test-bot-surface.ts` § 18 reads
     * `public/page.html` off disk, and that file is off limits to every stream — so deleting
     * the page turns another suite red for reasons its owner cannot see. The coordinator
     * removes § 18 first, then the files go, then both suites are confirmed green.
     *
     * Until then this records that the rail is still standing, so nobody mistakes "still
     * there" for "nobody got round to it".
     */
    const OLD_RAIL = [
        path.join(__dirname, '../../src/modules/bot-surface/miniapp/miniapp.controller.ts'),
        path.join(PUBLIC_DIR, 'page.html'),
    ];
    const railStanding = OLD_RAIL.filter((f) => fs.existsSync(f));

    assert('the old rail is either wholly present or wholly gone — never half-deleted', () =>
        railStanding.length === 0 || railStanding.length === OLD_RAIL.length);

    if (railStanding.length > 0) {
        console.log('     ⏳ the old rail is still standing — repoint, prove on a handset, then');
        console.log('        ask the coordinator to drop test-bot-surface § 18 BEFORE deleting');
    } else {
        /**
         * Once the files are gone, nothing may still point at them. `/p/:handle` and
         * `/api/:handle` are the old rail's routes; a surviving mount is a route with no
         * controller, which fails at import rather than at request time.
         */
        const routes = fs.readFileSync(
            path.join(__dirname, '../../src/modules/bot-surface/miniapp/miniapp.routes.ts'), 'utf8');
        assert('⛔ the retired rail leaves no route behind it', () =>
            !routes.includes('MiniAppController'));
        assert('⛔ nothing still builds the old rail\'s Mini App URL', () => {
            const svc = fs.readFileSync(
                path.join(__dirname, '../../src/modules/bot-surface/services/product-display.service.ts'), 'utf8');
            return !svc.includes('/api/bot/miniapp/p/');
        });
    }

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
