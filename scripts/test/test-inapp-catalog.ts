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

    /**
     * ⚠ **Each screen is scanned as its controller AND its read, together — and the reason is
     * a vacuous pass, found by moving code.**
     *
     * The projections were extracted into `*.read.ts` so a WhatsApp Flow can call the same read.
     * Re-running this suite straight after the move failed 13 positive assertions, which was
     * expected. What was NOT expected is which ones still PASSED: "neither controller reaches for
     * ICU", "does NOT pay for a second catalogue read", "the detail hardcodes no rung label".
     * Every one of those passed **only because the logic it guards had left the file it scans.**
     * An absence check over a file that no longer holds the code is true of any code at all.
     *
     * So a screen's scanned surface is everything that decides it. A future split into a third
     * file must be added here, or these "must not" assertions go quietly green over code they no
     * longer see — which is why the next assertion pins that the reads are actually in scope.
     */
    const LISTING_CONTROLLER = codeOf(path.join(SURFACES, 'product-listing.controller.ts'));
    const LISTING_READ = codeOf(path.join(SURFACES, 'product-listing.read.ts'));
    const DETAIL_CONTROLLER = codeOf(path.join(SURFACES, 'product-detail.controller.ts'));
    const DETAIL_READ = codeOf(path.join(SURFACES, 'product-detail.read.ts'));
    const LISTING = `${LISTING_CONTROLLER}\n${LISTING_READ}`;
    const DETAIL = `${DETAIL_CONTROLLER}\n${DETAIL_READ}`;

    assert('both screens\' reads are actually in the scanned surface — a missing read makes every "must not" below vacuous',
        () => LISTING_READ.includes('export async function readListingPage')
            && DETAIL_READ.includes('export async function readProductDetail'));

    console.log('\n── ⚠ One read, two renderings — the reads stay channel-neutral ──');

    /**
     * ⚠ **The reads are imported by a WhatsApp Flow as well as by these controllers**, so
     * anything request- or session-shaped inside them is a Mini App behaviour leaking into
     * another channel. Two are specifically harmful:
     *
     *   - **`touch`** — a Flow fetching data would silently extend an `ia_` session's life;
     *   - **Express** — and more generally a controller import, which is the path by which some
     *     surface modules become unimportable under bare ts-node (they hang, producing no output).
     */
    assert('⛔ neither read touches Express, a handle, or the session store', () =>
        [LISTING_READ, DETAIL_READ].every((read) =>
            !read.includes("from 'express'")
            && !read.includes('asyncHandler')
            && !read.includes('inAppSurfaceStore')
            && !read.includes('.touch(')));

    assert('the Mini App controllers still extend their own sessions — it moved OUT of the read, not away', () =>
        LISTING_CONTROLLER.includes("touch('pl'") && DETAIL_CONTROLLER.includes("touch('pd'"));

    /**
     * ⚠ **The picture is deliberately NOT resolved in a read**, because the right rule depends
     * on who fetches it: a browser falls back to a raw URL a phone may reach, a platform needs a
     * reachable one, and a WhatsApp Flow takes base64 bytes and no URL at all. A read that applied
     * the browser's rule would hand a Flow a URL it cannot use.
     */
    assert('⛔ neither read applies an image-fetching rule', () =>
        [LISTING_READ, DETAIL_READ].every((read) =>
            !read.includes('toPublicMediaUrl') && !read.includes('browserImageUrl')));

    assert('both Mini App controllers apply the BROWSER image rule to the raw source', () =>
        LISTING_CONTROLLER.includes('browserImageUrl(') && DETAIL_CONTROLLER.includes('browserImageUrl('));

    /**
     * A Flow needs the picture's BYTES, which it reads through the storage provider by key —
     * fetching our own public URL over HTTP would fail on a machine whose URL is a carrier-NAT
     * address. So both reads also hand over the stored file's key, access, type and size.
     */
    assert('both reads hand over the picture as a stored file, not only a URL', () =>
        LISTING_READ.includes('toImageSource(') && DETAIL_READ.includes('toImageSource('));

    /**
     * ⚠ A `RadioButtonsGroup` holds at most 20 options and the grid's default page is 24, so a
     * Flow must be able to ask for fewer. A page size fixed inside the read would overflow it.
     */
    assert('the listing read takes the page size as a parameter, so a Flow can ask for 20', () =>
        /pageSize\?:\s*number/.test(LISTING_READ) && LISTING_READ.includes('options.pageSize'));

    /**
     * ⚠ **The detail controller projects `pd.html`'s contract field by field and never spreads
     * the read.** The read carries fields that exist for a Flow — `productId`, a per-variant
     * `label`, the picture as a stored file — and a spread is how a field meant for one renderer
     * ends up published to every browser.
     */
    assert('⛔ the detail controller does not spread the read into the browser response', () =>
        !/\.\.\.\s*detail\b/.test(DETAIL_CONTROLLER) && !/\.\.\.\s*variant\b/.test(DETAIL_CONTROLLER));

    assert('⛔ the stored-file image never reaches the browser — only the URL does', () =>
        !/image:\s*detail\.image\b/.test(DETAIL_CONTROLLER) && !/\bimage:\s*product\.image\b/.test(LISTING_CONTROLLER));

    /**
     * ⚠ **Read as TEXT rather than imported, and that is a deliberate reversal.**
     *
     * These two numbers were `import`ed until backend-2d found what importing a surface
     * controller costs: a controller that reaches `orders/` or `payments/` **cannot be
     * imported under bare ts-node at all** — those modules do work at import time and never
     * return, so the suite produces no output and reads as broken rather than as red.
     *
     * Neither of these two controllers reaches that far today, so the import worked. That is
     * precisely the fragility: the suite would keep working until some transitive dependency
     * grew an import nobody connected to this file, and then it would hang with no
     * explanation. A regex over the source cannot hang.
     */
    /**
     * ⚠ **The pattern is passed in as a LITERAL, never built from a string.** This repo bans
     * `new RegExp()` outright (`no-restricted-syntax`), because every search path here is
     * `$regex`-based and an unescaped term is injection plus ReDoS. The ban is a syntax rule
     * rather than a taint check, so it catches a constructed pattern even where the input is a
     * hardcoded name — which is correct, and cheaper to obey than to argue with.
     */
    const constant = (source: string, pattern: RegExp): number => {
        const hit = pattern.exec(source);
        return hit ? Number(hit[1]) : NaN;
    };
    const DISPLAY_SERVICE = codeOf(
        path.join(__dirname, '../../src/modules/bot-surface/services/product-display.service.ts'));

    /**
     * `DEFAULT_LISTING_PAGE_SIZE` now, and it lives in the READ. Renamed when it moved, because a
     * page size is a caller's parameter to that read — a WhatsApp Flow passes 20 — and this is only
     * the default the Mini App uses. The "found" guard below is what reported the rename, by name,
     * rather than four comparisons failing against NaN.
     */
    const PAGE_SIZE = constant(LISTING_READ, /\bDEFAULT_LISTING_PAGE_SIZE\s*=\s*(\d+)/);
    const CHAT_MAX = constant(DISPLAY_SERVICE, /\bBOT_DISPLAY_MAX_PRODUCTS\s*=\s*(\d+)/);

    /**
     * ⚠ **Without this the whole section is worthless.** A regex that stops matching answers
     * `NaN`, and every comparison below it — `>`, `<=`, `% 2 === 0` — is false for NaN, so the
     * section would go red rather than silently green. But it would go red for the WRONG
     * reason, pointing at a page size that never changed. This names the real fault.
     */
    assert('both constants were actually found in source — a NaN here would mislead every compare below',
        () => Number.isInteger(PAGE_SIZE) && Number.isInteger(CHAT_MAX));

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
        PAGE_SIZE > CHAT_MAX);

    assert('the page size fills a row evenly at 2, 3 and 4 columns', () =>
        PAGE_SIZE % 2 === 0 && PAGE_SIZE % 3 === 0 && PAGE_SIZE % 4 === 0);

    /**
     * `LimitSchema` caps a public catalogue read at 100. A page size above it would not fail
     * loudly — the query is built as a literal here rather than parsed — it would just ask for
     * more than the contract allows.
     */
    assert('the page size stays inside the public catalogue\'s own limit', () =>
        PAGE_SIZE <= 100);

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
     * onto a session — the session holds the question and the catalogue answers it on every read.
     *
     * ⚠ **This used to COUNT mints — "the listing mints exactly once, the detail screen mints
     * nothing" — and that was a stand-in for the rule, not the rule.** It went red the day the
     * detail screen gained Similar items, which mints a listing session pinning a set of product
     * IDS: exactly the shape `InAppListingQuery.productIds` exists for, and no price in sight. A
     * guard that fails on correct code teaches the next person to delete it.
     *
     * So it now checks what actually matters, per mint call: the object written carries **no
     * catalogue-shaped key** — no price, no title, no stock, no picture, no variants. Ids are fine;
     * figures are not. The call sites are extracted by brace-matching rather than a regex, because
     * a nested `query: { … }` would end a non-greedy match early and hide the rest of the object.
     */
    const mintCalls = (source: string): string[] => {
        const calls: string[] = [];
        const marker = 'inAppSurfaceStore.mint(';
        let from = source.indexOf(marker);
        while (from !== -1) {
            const open = source.indexOf('{', from);
            let depth = 0;
            let end = open;
            for (; end < source.length; end++) {
                if (source[end] === '{') depth++;
                else if (source[end] === '}' && --depth === 0) break;
            }
            calls.push(source.slice(open, end + 1));
            from = source.indexOf(marker, end);
        }
        return calls;
    };
    const CATALOGUE_KEY = /\b(price|priceText|compareAtPrice|title|stock|inStock|variants|imageUrl|image|description)\s*:/;

    assert('both screens actually mint — the scan below has calls to inspect (open, and similar items)', () =>
        mintCalls(LISTING).length >= 1 && mintCalls(DETAIL).length >= 1);

    assert('⛔ no session is ever written with catalogue data — ids only, never figures', () => {
        const offending = [...mintCalls(LISTING), ...mintCalls(DETAIL)].filter((call) => CATALOGUE_KEY.test(call));
        if (offending.length > 0) console.error(`      a mint writes catalogue data: ${offending[0].slice(0, 120)}`);
        return offending.length === 0;
    });

    /**
     * ⚠ A Similar-items shelf is PINNED at the moment of asking. A listing that re-ran "similar"
     * per page could reshuffle under the customer as the ranking cache expired.
     */
    assert('the similar-items listing is pinned by ids, not re-queried', () =>
        mintCalls(DETAIL).some((call) => call.includes("kind: 'pl'") && call.includes('productIds')));

    console.log('\n── ⚠ Similar items: one read, two opposite failure rules ──');

    const SIMILAR_READ = codeOf(path.join(SURFACES, 'similar-products.read.ts'));

    /**
     * ⚠ **The product page must never fail because "similar" could not be computed.** That check
     * only decides whether a button is drawn, and it reaches a ranking cache and an orders
     * aggregation in another module. A wobble there must cost one optional button, not the page.
     */
    assert('⛔ the product data read swallows a similar-items failure into "no button"', () =>
        /readSimilarProductIds\([^)]*\)\s*\.then\([\s\S]{0,120}?\)\s*\.catch\(\s*\(\)\s*=>\s*false\s*\)/.test(DETAIL_CONTROLLER));

    /**
     * ⚠ **…and the TAP must never swallow one.** There the customer pressed the button; a silent
     * nothing reads as a broken control. So the `similar` handler has no catch of its own.
     */
    assert('⛔ the similar-items tap surfaces its failures rather than answering nothing', () => {
        const start = DETAIL_CONTROLLER.indexOf('static similar');
        const body = start === -1 ? '' : DETAIL_CONTROLLER.slice(start, DETAIL_CONTROLLER.indexOf('async function readDetailSession'));
        return start !== -1 && body.includes('readSimilarProductIds(') && !body.includes('.catch(');
    });

    assert('an empty shelf answers a null url rather than opening an empty grid', () =>
        /productIds\.length\s*===\s*0[\s\S]{0,80}url:\s*null/.test(DETAIL_CONTROLLER));

    /**
     * "Similar" is `relatedProductsService`'s ranking and nobody else's. A read that re-ranked or
     * filtered on top would be a second definition of similar that the storefront does not share.
     */
    assert('the similar-items read defers entirely to the catalogue\'s own ranking', () =>
        SIMILAR_READ.includes('relatedProductsService.forProduct(')
        && !/\.(sort|filter)\(/.test(SIMILAR_READ));

    assert('⛔ the similar-items read stays channel-neutral too', () =>
        !SIMILAR_READ.includes("from 'express'") && !SIMILAR_READ.includes('inAppSurfaceStore'));

    console.log('\n── ⚠ The English FALLBACK covers every key the page reads ──');

    /**
     * ⚠ **The failure this catches lands at the WORST possible moment.** Each page falls back to
     * an English table when the `/copy` call fails, so that it can still say "ask me again"
     * rather than throwing while rendering the message explaining why it could not load. But
     * nothing checked that the fallback covers every key the page reads — so adding a key and
     * forgetting the fallback renders the string `undefined` as a label **on exactly the
     * request that was already failing**. Found by backend-2d in `co.html`; both of these pages
     * had the same exposure.
     *
     * ⚠ **TWO TRAPS IN WRITING THIS, both learned the expensive way:**
     *
     * 1. The obvious form is a `new RegExp` per key, and eslint refuses it repo-wide — a syntax
     *    ban, not a taint check, so it fires even on a pattern built from a constant. One
     *    static pattern collecting the declared keys is allowed and correct.
     * 2. ⛔ **A substring check is actively WRONG here and fails in the direction that HIDES the
     *    bug.** Searching the block for `retry` matches inside **`retryLater`** — any longer key
     *    sharing the prefix — so a genuinely missing `retry` reports as present. Measured, not
     *    assumed: `'retryLater: "x"'.includes('retry')` is `true`.
     *
     *    ⚠ Appending a colon narrows that particular case but does not fix the class, and it is
     *    the form somebody writes without it. Collect the declared keys and compare as a **SET**.
     *    (A related near-miss while writing this: `checkoutRetry` does *not* contain `retry` —
     *    the capital R breaks it — so an example chosen by eye can fail to demonstrate the very
     *    trap it is describing. The example above was run before it was written down.)
     *
     * Same family as the NaN trap above: a check that cannot tell whether it really ran is
     * indistinguishable from one that passes.
     */
    const FALLBACK_BLOCK = /var FALLBACK = \{([\s\S]*?)\};/;
    const DECLARED_KEY = /^\s*([a-zA-Z][a-zA-Z0-9]*)\s*:/gm;

    const fallbackKeysOf = (kind: string): Set<string> => {
        // Comments stripped first, so a key merely NAMED in prose cannot count as declared.
        const code = readPage(kind).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const block = FALLBACK_BLOCK.exec(code);
        if (!block) return new Set();
        return new Set([...block[1].matchAll(DECLARED_KEY)].map((m) => m[1]));
    };

    const copyKeysReadBy = (kind: string): string[] => {
        const code = readPage(kind).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        return [...new Set([...code.matchAll(/\bcopy\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]))];
    };

    /**
     * ⚠ Without this, an empty Set would satisfy "every read key is present" only if the page
     * also read nothing — but a FALLBACK the regex stopped finding yields an empty Set and a
     * loud failure below rather than a silent pass. This names the real fault instead.
     */
    assert('both pages actually declare a FALLBACK table the scan can find', () =>
        MINE.every((kind) => fallbackKeysOf(kind).size > 0));

    assert('⛔ every copy key a page reads has an English fallback', () =>
        MINE.every((kind) => {
            const declared = fallbackKeysOf(kind);
            const missing = copyKeysReadBy(kind).filter((k) => !declared.has(k));
            if (missing.length > 0) {
                console.error(`      ${kind}.html would render "undefined" for: ${missing.join(', ')}`);
            }
            return missing.length === 0;
        }));

    /**
     * The other direction is a smaller fault and still worth naming: a fallback key nothing
     * reads is dead copy that will drift out of step with `inapp-copy.ts` unnoticed.
     */
    assert('and no fallback key is dead — every one of them is read', () =>
        MINE.every((kind) => {
            const read = new Set(copyKeysReadBy(kind));
            const dead = [...fallbackKeysOf(kind)].filter((k) => !read.has(k));
            if (dead.length > 0) console.error(`      ${kind}.html declares unread fallback keys: ${dead.join(', ')}`);
            return dead.length === 0;
        }));

    console.log('\n── The shelf is named from what the customer asked for ──');

    /**
     * ⚠ **A shop is named from its PRODUCTS, never from its slug, and never by a lookup.**
     * `headingFor` used to answer null for a store-scoped session, on the ground that
     * `electro-shop-douala` is a database key rather than a shop's name. True — and it left a
     * customer who opened a shop from the directory looking at a page headed "Browse".
     *
     * A store-scoped query returns only that store's products, so every card already carries
     * the same `storeName`; taking it from the first row costs no extra read and cannot
     * disagree with the cards underneath it.
     */
    assert('a store-scoped listing is headed with the shop\'s real name', () =>
        LISTING.includes('products[0]?.storeName'));

    assert('⛔ and it does NOT pay for a second catalogue read to get it', () =>
        !LISTING.includes('getStoreBySlug') && !LISTING.includes('listStores'));

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
