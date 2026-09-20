/**
 * Test: STREAM C — the purchase ladder and the write path behind it.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 * Five sessions build this surface in **one working tree with no branching**. Two sessions
 * appending to one shared suite is a read-then-write race on disk, not a merge conflict — one
 * session's work simply disappears. So `test-bot-surface.ts` is touched by **nobody**, and
 * this file is **Stream C's alone**.
 *
 * § 1 is Stream 0's and pins what Stream C inherits. § 2 is where Stream C's own assertions go.
 *
 * Run: npm run test:inapp-purchase
 */
import fs from 'fs';
import path from 'path';
import {
    resolvePurchaseAffordance,
    __PURCHASE_LADDER_ORDER,
} from '../../src/modules/bot-surface/domain/purchase-affordance';
import { botChrome, __CHROME_TABLE, assertBotChromeCopyFits, BotChromeKey } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import {
    bargainActionId,
    bookActionId,
    addToCartActionId,
    buyNowActionId,
    openSurfaceActionId,
    cartViewActionId,
    categoryActionId,
    categoryDigest,
    parseBotActionId,
    __CALLBACK_DATA_BYTES,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
/**
 * ⚠ The routing rules are imported and CALLED; the dispatcher is only ever read as text. It
 * imports every stream's handlers, which reach `orders/` and `payments/`, and those hang bare
 * `ts-node` at import with no output at all.
 */
import {
    actionKeyOf,
    mergeActionHandlers,
    unknownBotAction,
} from '../../src/modules/bot-surface/domain/bot-action-dispatch';

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

/** A real 24-hex ObjectId, so the byte budget below is measured against the real worst case. */
const OID = 'a1b2c3d4e5f60718293a4b5c';

function main(): void {
    console.log('\n══ § 1 · The contract Stream 0 froze (do not edit) ══');

    console.log('\n── The four rungs ──');

    /**
     * The ladder in the owner's words: negotiable → Bargain · physical → Add to cart ·
     * digital → Buy now · service → Book. Five surfaces read it — the chat card, the chat
     * product list, the listing screen, the detail screen and the write path — which is
     * exactly why it is one function and not five `if` statements.
     */
    assert('physical, in stock → Add to cart', () =>
        resolvePurchaseAffordance({ type: 'physical', negotiable: false, inStock: true, variantId: OID })
            .verb === 'add');

    assert('digital, in stock → Buy now', () =>
        resolvePurchaseAffordance({ type: 'digital', negotiable: false, inStock: true, variantId: OID })
            .verb === 'buy');

    assert('negotiable physical → Bargain (negotiable outranks the type)', () =>
        resolvePurchaseAffordance({ type: 'physical', negotiable: true, inStock: true, variantId: OID })
            .verb === 'bargain');

    assert('negotiable digital → Bargain', () =>
        resolvePurchaseAffordance({ type: 'digital', negotiable: true, inStock: true, variantId: OID })
            .verb === 'bargain');

    assert('service → Book', () =>
        resolvePurchaseAffordance({ type: 'service', negotiable: false, inStock: true, variantId: null })
            .verb === 'book');

    /**
     * ⚠ **A negotiable SERVICE still says Book, not Bargain — and that is deliberate.** A won
     * bargain becomes a price lock that is redeemed by a **cart line**, and the cart refuses
     * services outright (`cart.service.ts`). So a haggle over a service would have nowhere to
     * land. Unreachable in practice today; it fails safe anyway.
     */
    assert('⛔ a NEGOTIABLE SERVICE still says Book — a won bargain has nowhere to land', () =>
        resolvePurchaseAffordance({ type: 'service', negotiable: true, inStock: true, variantId: OID })
            .verb === 'book');

    /**
     * ⚠ A service's availability is its slot calendar, which this function cannot see and must
     * not guess at. Reading `inStock` here would disable bookable classes at random.
     */
    assert('a service is enabled with no variant and no stock', () =>
        resolvePurchaseAffordance({ type: 'service', negotiable: false, inStock: false, variantId: null })
            .enabled === true);

    console.log('\n── Disabled is still an affordance ──');

    /**
     * ⚠ **Callers must not treat a disabled affordance as an absent one.** A chat renderer
     * drops the button — a control that answers an error is worse than no control. A screen
     * draws it greyed with the reason beside it, because a screen has room to explain and a
     * chat bubble does not. Returning the verb either way is what lets the two differ.
     */
    assert('out of stock keeps its verb and loses only `enabled`', () => {
        const a = resolvePurchaseAffordance({ type: 'physical', negotiable: false, inStock: false, variantId: OID });
        return a.verb === 'add' && a.enabled === false;
    });

    assert('no sellable variant keeps its verb and loses only `enabled`', () => {
        const a = resolvePurchaseAffordance({ type: 'digital', negotiable: false, inStock: true, variantId: null });
        return a.verb === 'buy' && a.enabled === false;
    });

    console.log('\n── The labels ──');

    assert('every rung names a chrome key that exists', () =>
        __PURCHASE_LADDER_ORDER.every((verb) => {
            const key = ({ bargain: 'bargainButton', add: 'addToCartButton', buy: 'buyNowButton', book: 'bookButton' } as const)[verb];
            return Object.prototype.hasOwnProperty.call(__CHROME_TABLE, key);
        }));

    assert('every rung\'s label resolves in all five languages', () =>
        __PURCHASE_LADDER_ORDER.every((verb) => {
            const key = ({ bargain: 'bargainButton', add: 'addToCartButton', buy: 'buyNowButton', book: 'bookButton' } as const)[verb];
            return BOT_COPY_LANGUAGES.every((lang) => botChrome(key as BotChromeKey, lang).trim().length > 0);
        }));

    /**
     * ⚠ **WhatsApp truncates a reply-button title over 20 characters with no error**, so an
     * over-long translation ships as a mangled word rather than as a failure.
     * `assertBotChromeCopyFits` runs at BOOT, which is why a miss stops the server for every
     * session rather than reaching a customer.
     */
    assert('⛔ every chrome label still fits its cap (this guard runs at boot)', () => {
        assertBotChromeCopyFits();
        return true;
    });

    console.log('\n── The tap-codes ──');

    /**
     * ⚠ **Telegram silently truncates `callback_data` past 64 BYTES.** Not an error — a
     * shorter string, which then parses as some other action or as none. Two ObjectIds plus a
     * verb is 53, which is the real worst case and the reason the budget is measured here.
     */
    assert('⛔ every purchase tap-code fits 64 bytes with two ObjectIds', () =>
        [
            addToCartActionId(OID, OID),
            buyNowActionId(OID, OID),
            bargainActionId(OID, OID),
            bookActionId(OID),
        ].every((id) => Buffer.byteLength(id, 'utf8') <= __CALLBACK_DATA_BYTES));

    assert('every purchase tap-code parses back to its verb', () =>
        parseBotActionId(addToCartActionId(OID, OID))?.verb === 'add'
        && parseBotActionId(buyNowActionId(OID, OID))?.verb === 'buy'
        && parseBotActionId(bargainActionId(OID, OID))?.verb === 'bargain'
        && parseBotActionId(bookActionId(OID))?.verb === 'book');

    /**
     * One verb serves all four screens, so the argument carries the surface. A fifth surface
     * costs no new verb and no new byte budget.
     */
    assert('one `open` verb serves every screen', () =>
        (['pl', 'pd', 'ol', 'sl'] as const).every((surface) => {
            const id = openSurfaceActionId(surface, OID);
            return parseBotActionId(id)?.verb === 'open'
                && Buffer.byteLength(id, 'utf8') <= __CALLBACK_DATA_BYTES;
        }));

    /**
     * ⚠ An unmapped token is a button that **fails silently** — Telegram reports no error for
     * an unhandled callback, so the customer taps and nothing whatsoever happens.
     */
    assert('an unknown token is refused rather than guessed at', () =>
        parseBotActionId('nosuchverb:whatever') === null);

    console.log('\n══ § 2 · Stream C\'s own assertions ══');

    /**
     * ── ⚠ WHY SO MUCH OF § 2 IS A SOURCE SCAN ───────────────────────────────
     * The write path needs a catalogue, a cart and Redis, and this suite is DB-free by
     * construction (§ 1's header). That is not a gap to apologise for: **every invariant
     * below is structural**, and a behavioural test would not see any of them break. A
     * controller that trusted the caller's verb still adds things to baskets; a second
     * opinion about WhatsApp's button cap still renders; a `bargain` that quietly wrote a
     * cart line still answers 200. Each one fails as a WRONG SUCCESS, which is exactly the
     * class of defect a scan catches and a happy-path test cannot.
     *
     * ⚠ **Comments are stripped before every scan**, in both directions. A scan satisfied by
     * a comment MENTIONING `resolvePurchaseAffordance` would pass on a controller that never
     * calls it; and a negative scan that read this file's own explanations as the offence
     * would teach the next author to delete the comment that makes the code legible. That
     * second failure has already happened once on this surface (`test:inapp-checkout`'s
     * `GETDEL` scan, against the docstring that explains why `GETDEL` is unusable).
     */
    /**
     * ⚠ **Line endings are normalised FIRST, once, before any scan sees the text.** This repo runs
     * with `core.autocrlf=true`, so a Windows developer's fresh clone holds every file as `\r\n`
     * while CI on Linux holds `\n`. A pattern that counts characters or anchors on `\n` then gives
     * two different verdicts on identical code — and it has: one guard here went red on correct
     * code under CRLF, because a 200-character window measured 196 with LF and 202 with CRLF. A
     * guard that fails on correct code is a guard somebody weakens, so the fix belongs here rather
     * than in each pattern. The CRLF proof is asserted below.
     */
    const normalise = (raw: string): string =>
        raw.replace(/\r\n/g, '\n')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/[^\n]*$/gm, '');

    const codeOf = (file: string): string => normalise(fs.readFileSync(file, 'utf8'));

    const CONTROLLERS = path.join(__dirname, '../../src/modules/bot-surface/controllers');
    const PURCHASE = codeOf(path.join(CONTROLLERS, 'bot-purchase.controller.ts'));
    const DISPATCHER = codeOf(path.join(CONTROLLERS, 'bot-action.controller.ts'));
    const CART = codeOf(path.join(CONTROLLERS, 'bot-cart.controller.ts'));
    /**
     * ⭐ **The subject MOVED on 2026-09-20, and that is why this constant exists.** The three
     * post-add buttons and the bargain/book question used to be built inside
     * `bot-purchase.controller.ts`; they now live in `domain/purchase-chat-copy.ts`, because a
     * suite cannot import a controller on this surface and the WhatsApp form completion needs
     * the same wording.
     *
     * Every guard below that used to scan the controller alone now scans **both**, and anchors
     * on the new module first — a "must NOT build these" check over a file that no longer
     * builds them is true of any file, which is the vacuous-green shape this suite's own header
     * warns about.
     */
    const CHAT_COPY = codeOf(
        path.join(__dirname, '../../src/modules/bot-surface/domain/purchase-chat-copy.ts'),
    );

    /**
     * ⛔ **WHY THE GUARDS BELOW SCAN SEVERAL FILES TOGETHER, AND PROVE THEY BITE.**
     *
     * A "must NOT" scan is an absence check, and an absence check over a file that no longer holds
     * the code it guards is true of ANY code. This suite's own subject moved: the token parse left
     * the purchase controller for the dispatcher, and the "added to cart" reply lives in two
     * controllers. Another stream's suite stayed green through exactly that kind of move this same
     * afternoon, with three guards protecting nothing.
     *
     * So every guard whose forbidden thing could live in more than one file is `guardBites`:
     *   1. the module it relies on is FOUND and holds the named thing (a positive anchor),
     *   2. the forbidden pattern is absent across ALL the files scanned together, and
     *   3. the same check CATCHES an in-memory mutant with the forbidden pattern injected.
     *
     * Step 3 is what a scan cannot fake: a guard that passes vacuously also passes the mutant, and
     * then fails here.
     */
    const guardBites = (
        name: string,
        input: {
            anchor: () => boolean;
            sources: readonly string[];
            forbidden: (source: string) => boolean;
            mutant: string;
        },
    ): void => {
        const joined = input.sources.join('\n');
        assert(name, () =>
            input.anchor()
            && !input.forbidden(joined)
            && input.forbidden(`${joined}\n${input.mutant}`));
    };

    /**
     * Does this source take a purchase RUNG from the request? Two shapes, because the realistic
     * mistake is the second one: property access (`req.body.verb`), and destructuring
     * (`const { verb } = Schema.parse(req.body)`), where `verb` appears BEFORE the request.
     */
    const readsVerbFromRequest = (src: string): boolean =>
        /req\.(body|query|params)[\s\S]{0,40}\.verb\b/.test(src)
        || /verb:\s*(req|input|body)\./.test(src)
        || /\{[^}]*\bverb\b[^}]*\}\s*=\s*[^;]*req\.(body|query|params)/.test(src);

    console.log('\n── The modules the guards below depend on are where they think ──');

    assert('the dispatcher module is found and holds the token door', () =>
        DISPATCHER.includes('class BotActionController') && DISPATCHER.includes('static dispatch'));

    assert('the purchase module is found and exports its handlers and the write core', () =>
        PURCHASE.includes('export const PURCHASE_ACTION_HANDLERS')
        && PURCHASE.includes('async function executePurchase('));

    assert('the cart module is found and holds the typed-path reply', () =>
        CART.includes('static addItem') && CART.includes('addedToCartActions('));

    /** Non-vacuity for every guard below that spans the extracted module. */
    assert('the purchase chat-copy module is found and is the one that DEFINES both pieces', () =>
        CHAT_COPY.includes('export function addedToCartActions(')
        && CHAT_COPY.includes('export function purchaseInvitePrompt('));

    /**
     * ⚠ **The extracted module must stay importable by a SUITE**, which is the whole reason it
     * exists: a controller here reaches `orders/` and `payments/`, whose imports do work and
     * never return under bare `ts-node`, so a suite importing one produces no output at all.
     * A service import creeping into this module would take that property away silently.
     */
    assert('⛔ the chat-copy module imports no service, no controller and no model', () =>
        !/from\s+['"][^'"]*\/(services|controllers|models)\//.test(CHAT_COPY)
        && !/from\s+['"][^'"]*\.(controller|service|model)['"]/.test(CHAT_COPY));

    /**
     * ⛔ **Every scan in this suite gives the SAME verdict on a Windows clone.** Rather than
     * re-running each guard twice, this proves the thing they all depend on: the text every guard
     * reads is byte-identical whether the file arrived as `\n` or as `\r\n`. If that holds, no
     * pattern below can tell the two apart — including one written next year by somebody who has
     * never heard of `core.autocrlf`.
     */
    assert('⛔ every scanned file reads identically as LF and as CRLF (a Windows clone stays green)', () =>
        ['bot-purchase.controller.ts', 'bot-action.controller.ts', 'bot-cart.controller.ts'].every((name) => {
            const lf = fs.readFileSync(path.join(CONTROLLERS, name), 'utf8').replace(/\r\n/g, '\n');
            const crlf = lf.replace(/\n/g, '\r\n');
            return crlf.includes('\r\n') && normalise(crlf) === normalise(lf);
        }));

    console.log('\n── ⛔ The server re-resolves the rung. The verb is never trusted ──');

    /**
     * ⭐ **The load-bearing assertion of this whole stream.** A chat callback payload is
     * whatever the client sent back and a Mini App page is a document with a console in it —
     * so a write that accepted a VERB would let a customer ask to "buy now" something
     * negotiable, or add a service the cart refuses with `CART_SERVICE_PRODUCT_NOT_ALLOWED`.
     * That refusal is the live defect `purchase-affordance.ts` was written after: a bookable
     * yoga class rendered a working-looking "Add to cart", and the customer read the error as
     * the shop being broken.
     */
    assert('⛔ the write path calls resolvePurchaseAffordance itself', () =>
        PURCHASE.includes('resolvePurchaseAffordance({'));

    assert('⛔ the screen POST accepts a variantId and NOTHING else', () =>
        /ScreenActSchema[\s\S]{0,200}variantId[\s\S]{0,120}\.strict\(\)/.test(PURCHASE));

    /**
     * ⚠ **The negative half, and it is the one that would rot first.** A `verb` read off a
     * body or a token argument compiles, runs, and produces a surface that looks identical
     * until somebody points it at a product whose rung has moved.
     */
    guardBites('⛔ no rung is read from a request, across the handlers AND the dispatcher — and the guard bites', {
        anchor: () => PURCHASE.includes('resolvePurchaseAffordance({') && DISPATCHER.includes('actionKeyOf('),
        sources: [PURCHASE, DISPATCHER],
        forbidden: readsVerbFromRequest,
        mutant: 'const rung = req.body.verb;',
    });

    /**
     * ⚠ **The destructuring shape is the realistic one, and a property-access regex misses it** —
     * `verb` comes BEFORE `req.body`. The original guard here could not see it at all.
     */
    assert('…and the same guard catches the DESTRUCTURING shape of that mistake', () =>
        readsVerbFromRequest('const { productId, verb } = req.body ?? {};')
        && readsVerbFromRequest('const { verb } = BotActSchema.parse(req.body);'));

    /**
     * ⚠ The token's verb may still decide HOW MANY IDS to expect — `book:<productId>` carries
     * one and the other three carry two — which is why the scan above targets the request
     * body rather than banning the word outright.
     */
    assert('a `book:` token is parsed as one id and the others as two', () =>
        PURCHASE.includes("verb === 'book'") && PURCHASE.includes('variantId: null'));

    console.log('\n── The three things a customer wants after adding something ──');

    /**
     * View cart · Checkout · Browse more. All three are TOKENS rather than typed words: the
     * label is translated, the id is not (`bot-action-id.ts`).
     */
    assert('"Added to cart" offers exactly three actions', () =>
        CHAT_COPY.includes('cartViewActionId()')
        && CHAT_COPY.includes("openSurfaceActionId('co')")
        && CHAT_COPY.includes("openSurfaceActionId('pl')"));

    assert('each of the three has a translated label', () =>
        CHAT_COPY.includes("botChrome('viewCartButton'")
        && CHAT_COPY.includes("botChrome('checkoutButton'")
        && CHAT_COPY.includes("botChrome('browseMoreButton'"));

    /**
     * ⭐ **BOTH doors offer the same three, and this is an OWNER DECISION (2026-09-16) rather
     * than a symmetry somebody liked.** A customer reaches a basket two ways — tapping
     * "Add to cart" under a product, or typing "add two of the blue ones" — and until this
     * change only the tap produced buttons, so the customer who typed had to type "checkout"
     * as well. That is the magic-word problem § 14.6 abolished, reached from the other side.
     *
     * ⚠ **The accepted cost is a repeated sentence.** On the typed path the model has already
     * written its own reply, and the platform adds "Added to your cart" underneath it. The
     * owner was offered a neutral line ("What next?") that would repeat nothing and chose the
     * extra sentence over the extra phrase. So a future reader finding the duplication clumsy
     * is looking at a decision, not an oversight — and removing either the reply or the buttons
     * reverses it silently. This assertion is what makes that loud instead.
     */
    assert('⭐ the TYPED path offers the same three buttons (owner-chosen, repeat and all)', () => {
        const cart = codeOf(
            path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-cart.controller.ts'),
        );
        return cart.includes('addedToCartActions(')
            && cart.includes("botChrome('addedToCart'")
            && /setBotReply\(req, \{[\s\S]{0,200}actions: addedToCartActions/.test(cart);
    });

    /**
     * ⚠ **One definition of the three, imported rather than rebuilt.** Two copies is how one
     * door quietly grows a fourth button — which the renderer then drops, on one door only —
     * or loses Checkout, with nothing failing anywhere.
     */
    guardBites('⛔ the three buttons are built in exactly ONE place — and the guard bites', {
        anchor: () =>
            CHAT_COPY.includes('export function addedToCartActions(')
            && CHAT_COPY.includes('cartViewActionId()')
            && CART.includes('addedToCartActions(')
            && PURCHASE.includes('addedToCartActions('),
        // ⚠ The controller that used to DEFINE these is now a source that must not rebuild
        // them. Leaving it out is what would make this guard vacuous after the extraction.
        sources: [PURCHASE, CART, DISPATCHER],
        forbidden: (src) => src.includes('cartViewActionId(') || src.includes("openSurfaceActionId('co')"),
        mutant: "const actions = [{ id: cartViewActionId(), label: 'View cart' }];",
    });

    /**
     * ⛔ **The cap is the RENDERER's, and this controller must hold no opinion about it.**
     * `channel-reply.ts` composes every channel-ready body in one place, where
     * `WA_MAX_BUTTONS` is 3 and a fourth action is dropped before it reaches Meta. A second
     * place that also trimmed would be two renderers disagreeing about what a customer saw —
     * and the disagreement would surface on the day one of them changed.
     */
    guardBites('⛔ no controller on either add path enforces a button cap of its own — and the guard bites', {
        anchor: () => PURCHASE.includes('actions: addedToCartActions(') && CART.includes('actions: addedToCartActions('),
        sources: [PURCHASE, CART, DISPATCHER],
        forbidden: (src) => src.includes('WA_MAX_BUTTONS') || /actions[\s\S]{0,40}\.slice\(/.test(src),
        mutant: 'setBotReply(req, { kind: "text", text, actions: addedToCartActions(language).slice(0, 3) });',
    });

    /**
     * ⚠ **A checkout token carries NO handle**, and that is not a truncation. A `co` session
     * is ten minutes and single-use, so baking one into a chat button produces a control that
     * is dead before most customers tap it. The server mints on the tap — the shape `open:ol`
     * and `open:sl` already use.
     */
    assert('⛔ the Checkout button carries no screen handle', () =>
        Buffer.byteLength(openSurfaceActionId('co'), 'utf8') <= __CALLBACK_DATA_BYTES
        && openSurfaceActionId('co') === 'open:co');

    assert('both new tap-codes parse back to a handled verb', () =>
        parseBotActionId(cartViewActionId())?.verb === 'cart'
        && parseBotActionId(openSurfaceActionId('co'))?.verb === 'open');

    console.log('\n── The checkout session this stream mints ──');

    /**
     * ⚠ **The checkout screen's own guard depends on this stamp.** Its `place` handler compares
     * `session.cartId` against the live basket and refuses with 410 when they differ. What that
     * catches is narrow and real: `clearCart` DELETES the cart document, so a basket emptied and
     * rebuilt inside the ten-minute window comes back with a NEW id — and without the stamp the
     * customer pays for a basket they never reviewed on that screen.
     *
     * ⚠ **Coalesced, never asserted.** `CartResponse.cartId` is declared optional and built from
     * `_id?.toString()`. A null skips a bonus guard; a GUESSED id refuses a customer at the
     * moment of payment, on a handle that is already spent. Those costs are nowhere near equal.
     */
    assert('⛔ the checkout session is stamped with the basket it was opened for', () =>
        /mintCheckoutUrl\(ctx, cart\.cartId \?\? null\)/.test(PURCHASE)
        && /cartId,?\s*\n/.test(PURCHASE.slice(PURCHASE.indexOf('kind: \'co\''))));

    guardBites('⛔ the cart id is never asserted or invented — and the guard bites', {
        anchor: () => PURCHASE.includes('mintCheckoutUrl(ctx, cart.cartId ?? null)'),
        sources: [PURCHASE, DISPATCHER],
        forbidden: (src) => /cartId!/.test(src) || /cartId:\s*['"`]/.test(src),
        mutant: "await mintCheckoutUrl(ctx, cart.cartId!);",
    });

    /**
     * ⚠ **The stamp is REQUIRED, not optional, so a third minter has to decide.** The frozen
     * session type permits null and the screen degrades correctly on one — which is exactly why
     * an optional parameter would be dangerous here: it is how a new call site silently skips a
     * guard it never knew existed. Same reasoning as `PickupLocationValidationService`'s
     * required fourth argument.
     */
    assert('the stamp is a required parameter rather than an optional one', () =>
        /mintCheckoutUrl\(\s*ctx: SessionOwner,\s*cartId: string \| null\s*\)/.test(PURCHASE));

    /**
     * ⭐ **The origin is checked BEFORE minting, and this is the assertion that keeps it there.**
     * A handle minted for a screen nobody can open is a ten-minute order-placing credential
     * sitting in Redis, handed to no one. Not a leak — nothing receives it — but it makes "how
     * many live checkout handles exist" a number that means nothing, which is the number
     * somebody reaches for first in an incident. In production today `BOT_MINIAPP_BASE_URL` is
     * unset, so mint-then-discover would do this on EVERY checkout.
     *
     * ⚠ **Asked through `inAppBaseUrl()`, never by reading the variable again.** That function
     * holds both rules that decide it — HTTPS, and an origin the platforms' servers can actually
     * reach — and a second reader of `BOT_MINIAPP_BASE_URL` is precisely the drift `inapp-url.ts`
     * was extracted to prevent. It also makes `test:env`'s source census still see one reader.
     */
    assert('⛔ no screen session is minted when there is nowhere to put it', () =>
        /if \(!inAppBaseUrl\(\)\) return null;[\s\S]{0,400}inAppSurfaceStore\.mint/.test(PURCHASE));

    assert('⛔ the origin is asked through the shared reader, never re-read from the env', () =>
        PURCHASE.includes('inAppBaseUrl()') && !PURCHASE.includes('BOT_MINIAPP_BASE_URL'));

    console.log('\n── ⛔ Bargain and Book start a conversation, and write nothing ──');

    /**
     * ⭐ **jovi-mall CANNOT start a bargain, and this is the assertion that records why.**
     * The whole negotiation surface (`/api/internal/negotiation/*`) is the n8n sub-agent
     * calling IN — there is no outbound path to it and nothing here drives a turn. The agent
     * wakes on an INBOUND customer message and on nothing else.
     *
     * So the message this rung produces must INVITE A REPLY. A message that merely announced
     * the haggle would reach the customer, engage nobody, and leave the conversation dead —
     * and it would look completely correct from this side, which is why it is pinned here.
     */
    guardBites('⛔ neither the write path nor the dispatcher reaches for the negotiation module — and the guard bites', {
        anchor: () =>
            PURCHASE.includes("case 'bargain':")
            && PURCHASE.includes('purchaseInvitePrompt(')
            && CHAT_COPY.includes('bargainInvitePrompt'),
        sources: [PURCHASE, DISPATCHER, CHAT_COPY],
        forbidden: (src) => /from\s+['"][^'"]*\/negotiation[/'"]/.test(src),
        mutant: "import { negotiationService } from '../../negotiation/services/negotiation.service';",
    });

    /**
     * ⚠ **Two halves, in two files, and both are asserted.** The controller must ASK through
     * the shared builder (so the chat tap and the WhatsApp form completion cannot drift), and
     * the builder must reach the two invite sentences. Checking only one half would pass while
     * the other quietly stopped asking anything.
     */
    assert('bargain and book ask a question rather than announcing anything', () =>
        PURCHASE.includes("purchaseInvitePrompt(product.title, 'bargain'")
        && PURCHASE.includes("purchaseInvitePrompt(product.title, 'book'")
        && CHAT_COPY.includes("'bargainInvitePrompt'")
        && CHAT_COPY.includes("'bookInvitePrompt'"));

    /**
     * ⚠ **Neither rung writes.** A haggle has no agreed price yet and a booking has no slot
     * yet; a cart line for either would be a line at a price nobody agreed to, or a service
     * the cart is about to refuse.
     */
    assert('⛔ neither bargain nor book reaches the cart', () => {
        /**
         * ⚠ **The LAST `case 'bargain':` is the one that matters.** The first is the token
         * door listing the four rungs it accepts; this one is the rung switch inside
         * `executePurchase`, where the work happens. An earlier draft of this assertion
         * anchored on the first and passed for the wrong reason — a scan that matches the
         * wrong region reports a guarantee it never checked.
         */
        const bargainAt = PURCHASE.lastIndexOf("case 'bargain':");
        const addAt = PURCHASE.indexOf("case 'add':", bargainAt);
        if (bargainAt === -1 || addAt <= bargainAt) return false;

        const conversational = PURCHASE.slice(bargainAt, addAt);
        return conversational.includes("case 'book':") && !conversational.includes('addToCart');
    });

    /**
     * ⚠ **A Mini App cannot write to the chat**, so the two conversational rungs are posted
     * into the thread by this service, which holds the bot token. `Telegram.WebApp.sendData()`
     * works only for an app launched from a REPLY keyboard, and ours is launched from an
     * inline `web_app` button — so the page has no way to say anything itself.
     */
    assert('the screen pushes the conversational rungs into the thread', () =>
        PURCHASE.includes('pushIntoConversation')
        && PURCHASE.includes('telegramBotService.sendMessage'));

    /**
     * ⚠ **Best-effort, and it must stay that way.** Turning a failed send into a 500 would
     * tell a customer their haggle failed when the only thing that failed was the
     * notification about it — and WhatsApp cannot be sent to from a Mini App path at all.
     */
    assert('the push is addressed to the conversation and to no parameter', () =>
        PURCHASE.includes('session.externalId') && !/externalId:\s*(req|input)\.body/.test(PURCHASE));

    console.log('\n── The cart rules stay in the cart ──');

    /**
     * ⚠ **The SAME `CartService.addToCart` the storefront and `cart_add_item` call.** The
     * digital quantity cap, the one-digital-per-cart rule and the never-mixed rule all live in
     * `cart.service.ts`, exercised by the storefront every day. A button that re-implemented
     * any of them would be a second door onto a basket that behaves differently from the first.
     */
    assert('⛔ the write path delegates to CartService and re-implements no cart rule', () =>
        PURCHASE.includes('cartService.addToCart(')
        && !PURCHASE.includes('CART_DIGITAL_QUANTITY_MUST_BE_ONE')
        && !PURCHASE.includes('CART_MIXED_PRODUCT_TYPES')
        && !PURCHASE.includes('CART_DIGITAL_LIMIT_REACHED'));

    /**
     * ⚠ **A button never presents a price lock.** A won bargain redeems as a lock on a cart
     * line, and that lock is bound to the conversation the model is having — a card tapped
     * three weeks later is not that conversation. `PriceResolverService` would peek it and
     * price the line at an agreement this customer never reached on this turn.
     */
    guardBites('⛔ no BUTTON path presents a negotiation lock — and the guard bites', {
        anchor: () => PURCHASE.includes('cartService.addToCart(') && DISPATCHER.includes('static dispatch'),
        sources: [PURCHASE, DISPATCHER],
        forbidden: (src) => src.includes('negotiationLockRef'),
        mutant: 'await cartService.addToCart(customerId, productId, variantId, 1, undefined, negotiationLockRef);',
    });

    /**
     * ⭐ **The other half of that rule, and it is the half that would rot silently.** A won
     * bargain is only worth anything if it can be SPENT, and the only way to spend it is a
     * cart line carrying its lock. So the TOOL path — the model adding an item during the
     * conversation it just negotiated in — must keep accepting one, and nobody tidying the
     * button rule above may take it with them.
     *
     * ⚠ The failure would be invisible from every other angle: the haggle still works, the
     * agreement still shows in the chat, the item still reaches the basket — at the SHELF
     * price. A customer reads that as the shop going back on its word, and nothing errors.
     * This platform has already shipped that exact defect once, from the other direction:
     * the resolver sat unregistered for a day and every haggled add-to-cart answered 500.
     */
    assert('⛔ the TOOL path still spends a price lock — a won bargain must be redeemable', () => {
        /**
         * ⚠ **Read the call's own argument list, never a character window.** This used to be
         * `addToCart\([\s\S]{0,200}negotiationLockRef`, and the real distance was 196: one more
         * argument, or CRLF line endings, pushed a correct call past 200 and turned the guard red
         * on code that was fine. Slicing from the call to its closing `);` asks the actual
         * question — is the lock among this call's arguments — however the call is formatted.
         */
        const start = CART.indexOf('cartService.addToCart(');
        if (start < 0) return false;
        const call = CART.slice(start, CART.indexOf(');', start));
        return call.includes('negotiationLockRef');
    });

    /**
     * ⚠ **A disabled affordance is refused rather than rendered.** The chat drops a disabled
     * button and the screen greys it, but neither is a guarantee: a card lives in a chat
     * history indefinitely and a variant can sell out between the drawing and the press.
     */
    assert('an out-of-stock press is refused before it reaches the cart', () =>
        /!affordance\.enabled[\s\S]{0,400}createAppError/.test(PURCHASE));

    console.log('\n── The screen handle, and what it is allowed to do ──');

    /**
     * ⚠ **`read`, not `consume`.** A customer may press the button, be refused by the cart,
     * change variant and press again. Only the CHECKOUT handle — which places an order — is
     * single-use, and spending this one would make an ordinary refusal unrecoverable.
     */
    assert('the detail screen reads its session repeatably', () =>
        PURCHASE.includes("inAppSurfaceStore.read('pd'") && !PURCHASE.includes("consume('pd'"));

    /**
     * ⚠ **The handle names the product; the page names only the variant.** So a page cannot
     * buy something the session was not opened for, whatever it posts.
     */
    assert('⛔ the product comes from the session, never from the page', () =>
        PURCHASE.includes('productId: session.productId')
        && !/productId:\s*(req\.body|input)\./.test(PURCHASE));

    /**
     * ⚠ **A lapsed handle answers 404**, because that is what the page can act on: `pd.html`
     * maps 404 and 410 onto its own "ask me again in the chat" copy, in the customer's own
     * language, and anything else onto a generic failure.
     */
    assert('a lapsed screen session answers 404', () =>
        /BOT_PRODUCT_LIST_EXPIRED,\s*\n?\s*404/.test(PURCHASE));

    console.log('\n── A tap must never be silent ──');

    /**
     * ⭐ **Telegram reports NO error for an unhandled callback.** The customer taps, and the
     * world is silent — forever. That is the worst outcome available on this surface, and it
     * is why the token door answers every token it does not handle with a sentence rather
     * than with a log line. Fourteen verbs were minted ahead of their handlers, so this branch
     * is reachable today by design.
     */
    /**
     * ⚠ **The refusal is DEFINED once, not merely raised from one place.** If the dispatcher and a
     * handler each built their own error, the two would drift the first time somebody changed a
     * status — and the customer would get two different answers to one event: they tapped
     * something and it did nothing.
     */
    assert('⛔ THE refusal is one factory: BOT_ACTION_TOKEN_UNKNOWN at 422', () => {
        const refusal = unknownBotAction();
        return refusal.code === 'BOT_ACTION_TOKEN_UNKNOWN' && refusal.statusCode === 422;
    });

    guardBites('⛔ neither the dispatcher nor a handler builds its own unknown-token error — and the guard bites', {
        anchor: () => PURCHASE.includes('unknownBotAction()') && DISPATCHER.includes('unknownBotAction()'),
        sources: [PURCHASE, DISPATCHER],
        forbidden: (src) => src.includes('BOT_ACTION_TOKEN_UNKNOWN'),
        mutant: "throw createAppError(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, 422, 'Malformed');",
    });

    console.log('\n── ⭐ The tap-code dispatcher: one door, routed by key ──');

    /**
     * ⚠ **Every way a tap can route nowhere ends at the same refusal** — an unparseable token, an
     * unknown verb, an unknown sub-key, and a key declared in the vocabulary whose handler has not
     * landed yet. Fourteen verbs were minted ahead of their handlers, so the last of those is
     * reachable by design.
     */
    assert('⛔ the dispatcher refuses an unparseable token AND an unhandled key, identically', () =>
        /if \(!parsed\) throw unknownBotAction\(\)/.test(DISPATCHER)
        && /if \(!handler\) throw unknownBotAction\(\)/.test(DISPATCHER));

    assert('the dispatcher resolves the caller at the door, before parsing anything', () =>
        DISPATCHER.indexOf('botCallerOf(req)') > -1
        && DISPATCHER.indexOf('botCallerOf(req)') < DISPATCHER.indexOf('parseBotActionId(token)'));

    /**
     * ⚠ **The registry is merged by the guard, at import — which is boot.** A registry assembled by
     * spreading would let the later stream silently win a key.
     */
    assert('⛔ the registry is built through mergeActionHandlers, never by spreading', () =>
        DISPATCHER.includes('mergeActionHandlers([') && !/\.\.\.\w+_ACTION_HANDLERS/.test(DISPATCHER));

    /**
     * ⚠ **Handlers receive the token parsed and must never re-read it** — a handler that re-parsed
     * could disagree with the dispatcher about which button was pressed.
     */
    /**
     * ⚠ **Scans the HANDLERS only, and deliberately not the dispatcher** — reading the raw token
     * is the dispatcher's one job, so including it would make this guard fail on correct code.
     * Both shapes are forbidden: property access and destructuring.
     */
    guardBites('⛔ no purchase handler re-reads the raw token — and the guard bites', {
        anchor: () => PURCHASE.includes('export const PURCHASE_ACTION_HANDLERS') && DISPATCHER.includes('parseBotActionId(token)'),
        sources: [PURCHASE],
        forbidden: (src) =>
            /req\.body[\s\S]{0,20}\.token\b/.test(src)
            || /\{[^}]*\btoken\b[^}]*\}\s*=\s*[^;]*req\.body/.test(src),
        mutant: 'const { token } = BotDisplayActionSchema.parse(req.body ?? {});',
    });

    console.log('\n── ⛔ A category button can be built for ANY category name ──');

    /**
     * ⚠ **This platform has no category ids** — a category is free text on the product, up to 200
     * characters. `cat:` plus « Électroménager, électronique et équipements de la maison » is
     * exactly 64 bytes; one more character and building the token THROWS, while the reply is being
     * built, so the whole turn fails rather than one button. The builder therefore digests the
     * name. These prove it holds for a name far past that edge, in two scripts.
     */
    const LONG_CATEGORY =
        'Électroménager, électronique et équipements de la maison, jardin et cuisine '
        + 'ـ'.repeat(40);

    assert('⛔ a category name far past 64 bytes still builds a token that fits', () => {
        const token = categoryActionId(LONG_CATEGORY);
        return Buffer.byteLength(LONG_CATEGORY, 'utf8') > 150
            && Buffer.byteLength(token, 'utf8') <= __CALLBACK_DATA_BYTES
            && Buffer.byteLength(token, 'utf8') === 20;
    });

    assert('the tap resolves back to the same category by recomputing the digest', () =>
        parseBotActionId(categoryActionId(LONG_CATEGORY))?.argument === categoryDigest(LONG_CATEGORY));

    /**
     * ⚠ **Hashed exactly as stored — no case-folding.** The handler matches against the strings
     * `listCategories()` returns, and those are grouped by exact value, so two spellings are two
     * categories and must stay two digests.
     */
    assert('the digest is stable, and distinguishes spellings exactly as the catalogue does', () =>
        categoryDigest('Mode') === categoryDigest('Mode')
        && categoryDigest('Mode') !== categoryDigest('mode')
        && /^[0-9a-f]{16}$/.test(categoryDigest('Mode')));

    console.log('\n── ⭐ Shared verbs route by (verb, sub-key) — proven, not scanned ──');

    /**
     * These call the routing rules directly. `bot-action-dispatch.ts` imports nothing that reaches
     * `orders/` or `payments/`, which is precisely why the rules live there rather than in the
     * dispatcher: the dispatcher imports every stream's handlers and could never be loaded here.
     */
    const route = (token: string) => {
        const parsed = parseBotActionId(token);
        return parsed ? actionKeyOf(parsed) : null;
    };

    assert('a plain verb routes by the verb alone, argument untouched', () => {
        const r = route(`ord:${OID}`);
        return r?.key === 'ord' && r.action.argument === OID && r.action.subKey === undefined;
    });

    assert('`open` routes by SURFACE, and a reference-less surface gets an empty argument', () => {
        const r = route('open:co');
        return r?.key === 'open:co' && r.action.subKey === 'co' && r.action.argument === '';
    });

    /**
     * ⚠ **Split at the FIRST colon only.** `yes:cd:<orderId>:<shipmentId>` must reach its handler
     * with both ids intact — a split on every colon would hand it `<orderId>` and lose the parcel.
     */
    assert('`yes` routes by CONTEXT, and a reference holding colons reaches the handler intact', () => {
        const r = route(`yes:cd:${OID}:${OID}`);
        return r?.key === 'yes:cd' && r.action.subKey === 'cd' && r.action.argument === `${OID}:${OID}`;
    });

    assert('a verb one stream owns keeps its own argument grammar — `shp` is never sub-dispatched', () => {
        const r = route(`shp:${OID}:${OID}`);
        return r?.key === 'shp' && r.action.argument === `${OID}:${OID}`;
    });

    assert('an EMPTY sub-key produces a key no stream can register', () => route('yes::x')?.key === 'yes:');

    const h = async (): Promise<void> => undefined;
    const mergeThrows = (streams: Parameters<typeof mergeActionHandlers>[0]): string | null => {
        try {
            mergeActionHandlers(streams);
            return null;
        } catch (err) {
            return (err as Error).message;
        }
    };

    /**
     * ⭐ **THE GUARD BITES — asked for by name, and proven by calling it.** Two streams claiming one
     * PAIR is a silent overwrite: the later spread wins, and one stream's button quietly starts
     * running the other stream's code. It must throw at boot, and it must NAME both streams and the
     * pair, so whoever hits it knows what to fix without reading this file.
     */
    assert('⭐ ⛔ two streams claiming ONE PAIR throws, naming both streams and the pair', () => {
        const message = mergeThrows([
            ['orders', { 'yes:cd': h }],
            ['account', { 'yes:cd': h }],
        ]);
        return message !== null
            && message.includes('yes:cd')
            && message.includes('orders')
            && message.includes('account');
    });

    /**
     * ⚠ **…and it must NOT bite on legitimate sharing**, which is the whole reason the guard moved
     * from the verb to the pair. Confirming a delivery and closing an account share the word
     * "yes"; refusing that would lock every stream after the first out of a universal verb.
     */
    assert('⛔ two streams claiming DIFFERENT pairs under one shared verb merges cleanly', () =>
        mergeThrows([
            ['orders', { 'yes:cd': h, 'open:ol': h }],
            ['account', { 'yes:close': h }],
            ['purchase', { 'open:co': h, 'open:pl': h }],
        ]) === null);

    assert('⛔ two streams claiming one PLAIN verb still throws', () =>
        mergeThrows([['orders', { ord: h }], ['support', { ord: h }]])?.includes('ord') === true);

    /**
     * ⚠ **A bare shared verb would shadow every context under it.** The type forbids it; this is the
     * runtime half, for a map built with a cast or assembled on the fly.
     */
    assert('⛔ registering a BARE shared verb throws', () =>
        mergeThrows([['rogue', { yes: h } as never]]) !== null);

    assert('an explicit undefined entry is not a claim', () =>
        mergeThrows([['orders', { 'yes:cd': undefined }], ['account', { 'yes:cd': h }]]) === null);

    assert('the purchase stream registers its two surfaces as PAIRS, never bare `open`', () =>
        /'open:co':\s*handleOpenCheckoutTap/.test(PURCHASE)
        && /'open:pl':\s*handleOpenListingTap/.test(PURCHASE)
        && !/^\s*open:\s*\w+,?$/m.test(PURCHASE));

    /**
     * ⚠ **`more:` must not get WORSE where there is no screen, and today there is none.**
     * `BOT_MINIAPP_BASE_URL` is unset in production, so `inAppScreenUrl` answers null — and
     * `more:` buttons are already sitting in live chat histories, where they mean "five more
     * cards". Degrading those to a storefront link would take a working control in production
     * and make it worse in order to serve a screen that is dark.
     */
    assert('⛔ `more:` falls back to chat cards when this deployment has no screen', () =>
        PURCHASE.includes('openHeldListing') && PURCHASE.includes('respondWithNextCards'));

    /**
     * ⚠ **The display engine belongs to the stream that draws cards.** This controller reads
     * it and calls it and never edits it, which is what keeps one list renderer rather than
     * two — the same rule the affordance keeps for the button.
     */
    assert('paging delegates to the display service rather than re-implementing it', () =>
        PURCHASE.includes('productDisplayService.next('));

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
