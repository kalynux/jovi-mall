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
    parseBotActionId,
    __CALLBACK_DATA_BYTES,
} from '../../src/modules/bot-surface/domain/bot-action-id';
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
    const codeOf = (file: string): string =>
        fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/[^\n]*$/gm, '');

    const PURCHASE = codeOf(
        path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-purchase.controller.ts'),
    );

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
    assert('⛔ no rung is ever read from a request body', () =>
        !/body[\s\S]{0,40}\.verb\b/.test(PURCHASE) && !/verb:\s*(req|input|body)\./.test(PURCHASE));

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
        PURCHASE.includes('cartViewActionId()')
        && PURCHASE.includes("openSurfaceActionId('co')")
        && PURCHASE.includes("openSurfaceActionId('pl')"));

    assert('each of the three has a translated label', () =>
        PURCHASE.includes("botChrome('viewCartButton'")
        && PURCHASE.includes("botChrome('checkoutButton'")
        && PURCHASE.includes("botChrome('browseMoreButton'"));

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
    assert('⛔ the three buttons are built in exactly ONE place', () => {
        const cart = codeOf(
            path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-cart.controller.ts'),
        );
        return !cart.includes('cartViewActionId(') && !cart.includes('openSurfaceActionId(');
    });

    /**
     * ⛔ **The cap is the RENDERER's, and this controller must hold no opinion about it.**
     * `channel-reply.ts` composes every channel-ready body in one place, where
     * `WA_MAX_BUTTONS` is 3 and a fourth action is dropped before it reaches Meta. A second
     * place that also trimmed would be two renderers disagreeing about what a customer saw —
     * and the disagreement would surface on the day one of them changed.
     */
    assert('⛔ the controller enforces no WhatsApp button cap of its own', () =>
        !PURCHASE.includes('WA_MAX_BUTTONS')
        && !/actions[\s\S]{0,40}\.slice\(/.test(PURCHASE));

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
    assert('⛔ the write path calls no negotiation service — it cannot start the agent', () =>
        !PURCHASE.includes('negotiation') || !/import[^\n]*negotiation/.test(PURCHASE));

    assert('bargain and book ask a question rather than announcing anything', () =>
        PURCHASE.includes("botChrome('bargainInvitePrompt'")
        && PURCHASE.includes("botChrome('bookInvitePrompt'"));

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
    assert('⛔ no button path presents a negotiation lock', () =>
        !PURCHASE.includes('negotiationLockRef'));

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
        const cart = codeOf(
            path.join(__dirname, '../../src/modules/bot-surface/controllers/bot-cart.controller.ts'),
        );
        return cart.includes('negotiationLockRef')
            && /addToCart\([\s\S]{0,200}negotiationLockRef/.test(cart);
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
    assert('⛔ an unhandled token answers with a customer-facing refusal', () =>
        PURCHASE.includes('BOT_ACTION_TOKEN_UNKNOWN'));

    assert('the refusal is the DEFAULT of the verb switch, not a list of known-bad tokens', () =>
        /default:\s*\n\s*throw createAppError\(\s*\n?\s*ERROR_CODES\.BOT_ACTION_TOKEN_UNKNOWN/.test(
            PURCHASE,
        ));

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
