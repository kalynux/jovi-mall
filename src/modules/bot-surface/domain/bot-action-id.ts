import { createHash } from 'crypto';
import { BotOnboardingStep } from './bot-onboarding';

/**
 * The value a customer sends back by PRESSING something, rather than by typing it.
 *
 * ── WHY A TOKEN VOCABULARY EXISTS AT ALL ────────────────────────────────────
 * An answer drawn from a closed set — skip · yes · no · which of these — must never be
 * collected as free text. Three things go wrong the moment it is:
 *
 *   1. **The word is language-dependent and the parser is not.** Telling a French customer
 *      to type *« passer »* means something, somewhere, has to know that `passer`,
 *      `saltar`, `omitir` and `تخطٍّ` are all the token `skip`. That table would live in the
 *      automation layer, which is exactly the layer with no copy table — the premise this
 *      whole surface has now corrected three times.
 *   2. **The prompt has to teach the vocabulary.** Copy ended up carrying
 *      *"just say \"skip\" if you would rather not"* — a sentence explaining an interface
 *      rather than asking a question, with a quoted magic word inside it.
 *   3. **Typing is lossy.** `Skip`, `skip.`, `Passer !` and `pass` are all one intent and
 *      four strings.
 *
 * A button removes all three: the label is translated for the human, the **id is not
 * translated at all**, and it comes back byte-identical to what this service chose.
 *
 * ⚠ **THE RULE, for every future turn: if the set of valid answers is known in advance,
 * render buttons and put a token here.** Free text is for what only the customer can
 * supply — a name, an email, an address. A yes/no, a confirmation, a choice between two
 * payment methods and a "not now" are all buttons.
 *
 * ── THE SHAPE: `<verb>:<argument>` ──────────────────────────────────────────
 * Self-describing, because a tap arrives with no memory of the turn that produced it. The
 * automation layer is stateless between turns by design, so the token has to say both what
 * was pressed AND what it was pressed on.
 *
 * ⚠ **Adding a verb means documenting its token → request-body mapping in
 * `api-doc/n8n/bot-surface.md` § 14 in the same change.** A token nobody can map is a
 * button that does nothing, and it fails silently — Telegram reports no error for an
 * unhandled callback.
 *
 * ── ONE DELIBERATE ASYMMETRY: GEO CANDIDATES CARRY NO VERB ──────────────────
 * A picker row from `/geo/search` uses the bare `candidateRef` as its id, not
 * `geo:<ref>`. That is not an oversight. The ref IS the value that must be posted back
 * (`geoCandidateRef`), so a bare id means the automation layer forwards what it received
 * and transforms nothing — the strongest form of the rule this file serves. A verb would
 * buy self-description the caller does not need there (it knows why it started an address
 * flow) and would cost a strip step. Refs are recognisable anyway: they begin `gc_`.
 */

/**
 * The closed verb set. A token's first segment is always one of these.
 *
 * ⚠ **The four originals keep their exact meanings, forever.** A button lives in a chat
 * history indefinitely, and a customer scrolling back to a card from last month can still tap
 * it. Re-pointing `buy` at something new would silently change what every one of those old
 * buttons does. The purchase ladder (`purchase-affordance.ts`) chooses **which verb to
 * render**; it never changes **what a verb does**.
 *
 * ⚠ **Every verb below fits the 64-byte cap with its largest realistic argument** — two
 * ObjectIds and a separator is the worst case, 49 bytes, leaving 15 for the verb and colon.
 * The longest here is `bargain:` at 8. Checked, not assumed: `token()` throws on a miss.
 */
export const BOT_ACTION_VERBS = Object.freeze([
    // ── The originals ────────────────────────────────────────────────────────
    'skip',
    'add',
    'buy',
    'more',
    // ── The purchase ladder's other two rungs ────────────────────────────────
    'bargain',
    'book',
    // ── Navigation ───────────────────────────────────────────────────────────
    /** Opens one of the four in-app surfaces. One verb, four destinations. */
    'open',
    /** The next five cards IN THE CHAT. `more` now opens the in-app listing instead. */
    'next',
    'cat',
    // ── Confirmation ─────────────────────────────────────────────────────────
    'yes',
    'no',
    // ── Orders and fulfilment ────────────────────────────────────────────────
    'ord',
    'shp',
    'code',
    'track',
    // ── The basket ───────────────────────────────────────────────────────────
    /**
     * `cart:view` — show me what is in my basket.
     *
     * ⚠ **A verb rather than a screen, deliberately.** The obvious alternative was to drop the
     * button and let the customer type "show me my cart", and that was refused: the three
     * actions after an add — View cart · Checkout · Browse more — are exactly WhatsApp's cap of
     * three, and silently shipping two of them is the kind of quiet scope cut that turns a
     * designed turn into a worse one nobody decided on.
     *
     * ⚠ **Its handler must return the basket as DATA and set no reply**, so the model narrates
     * it. `bot-surface.md` § 14.3 states that a cart is data for the model, and a handler that
     * rendered its own basket message would make this surface a second renderer of baskets —
     * disagreeing with the model's version on the day one of them changes.
     */
    'cart',
    // ── Payment results ──────────────────────────────────────────────────────
    /**
     * `pay:st:<transactionId>` — Check status · `pay:rt:<transactionId>` — Try again.
     *
     * ⚠ **The TOKEN carries a transaction id; the matching ROUTES do not.** A route's caller is a
     * model, which invents ids it has never seen. A token's id is minted by this service into a
     * button and returns byte-identical. And a token MUST carry one, because a button outlives the
     * payment it was drawn for: "Try again" under last week's failure, tapped after two newer
     * checkouts, must not re-charge whichever basket is newest.
     *
     * ⚠ **`pay:rt` re-opens a CHARGE for orders that already exist; it never re-places an order.**
     * Creating orders clears the basket, so by the time a payment fails there is no basket left to
     * check out.
     */
    'pay',
    // ── Support, reviews, preferences ────────────────────────────────────────
    'tkt',
    'rate',
    'lang',
] as const);
export type BotActionVerb = (typeof BOT_ACTION_VERBS)[number];

/**
 * Telegram's `callback_data` cap, in bytes.
 *
 * Repeated from `channel-reply.ts` rather than imported because this module must not depend
 * on the renderer — it describes what a token IS, and the renderer decides how to draw it.
 * `test:bot-surface` asserts the two numbers agree, which is what stops the duplication
 * becoming a divergence.
 */
const CALLBACK_DATA_BYTES = 64;

/**
 * Build a token, refusing one no channel could carry.
 *
 * The throw is a boot-time-ish fault rather than a request outcome: every argument here is
 * a compile-time constant of this service (a step name today), so an oversized token is a
 * programming error rather than anything a caller did. It is worth refusing loudly, because
 * the alternative failure is invisible — Telegram accepts an oversized `callback_data`,
 * truncates it, and the button silently does nothing when tapped.
 */
function token(verb: BotActionVerb, argument: string): string {
    const value = `${verb}:${argument}`;
    if (Buffer.byteLength(value, 'utf8') > CALLBACK_DATA_BYTES) {
        // eslint-disable-next-line no-restricted-syntax -- programming fault, not a request outcome
        throw new Error(`[BotSurface] action id "${value}" exceeds ${CALLBACK_DATA_BYTES} bytes`);
    }
    return value;
}

/**
 * `skip:<step>` — decline an optional onboarding step.
 *
 * Maps to `POST /identity/onboarding` with `{ step: "<step>", action: "skip" }`, which is
 * the body that already existed; nothing about the route changed. What changed is that the
 * customer reaches it by pressing rather than by typing a word in a language somebody has
 * to parse.
 */
export function skipActionId(step: BotOnboardingStep): string {
    return token('skip', step);
}

/**
 * `add:<productId>:<variantId>` and `buy:<productId>:<variantId>` — the two buy buttons on a
 * product card.
 *
 * ⚠ **The token carries IDS, not a position in the list somebody was shown**, and that is the
 * decision worth defending. A `add:<setId>:<index>` token would be shorter and the handler
 * would have to load the display set anyway for `more:` — but it would also **expire with the
 * set**, so a customer scrolling back to a card from an hour ago would tap Add to cart and be
 * told the list had gone. A card in a chat history is a card the customer can still see; a
 * button on it that has quietly stopped working is the worst of the three outcomes.
 *
 * Ids make the token self-describing, which is this file's whole doctrine — *"a tap arrives
 * with no memory of the turn that produced it"* — and it fits: `add:` plus two 24-character
 * ObjectIds and a separator is **53 bytes against Telegram's 64**. That margin is the reason
 * a slug pair was never an option; two slugs would silently truncate.
 *
 * Both map to `POST /catalog/action` with `{ token }`. `add` puts one in the basket and says
 * so; `buy` does the same and answers with the pay link, so the customer's next tap is
 * payment rather than another sentence.
 */
export function addToCartActionId(productId: string, variantId: string): string {
    return token('add', `${productId}:${variantId}`);
}

export function buyNowActionId(productId: string, variantId: string): string {
    return token('buy', `${productId}:${variantId}`);
}

/**
 * `more:<setId>` — the next page of a product list the customer is already looking at.
 *
 * The set id is an opaque handle minted with the list (`product-display.store.ts`), so this
 * IS a token that dies with its set — deliberately, and unlike the two above. "Show me more of
 * that list" has no meaning once the list is gone, and the handler answers a lapsed handle by
 * inviting a fresh search rather than by pretending.
 */
export function showMoreActionId(setId: string): string {
    return token('more', setId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  The rich-UI vocabulary
//
//  ⚠ **Declared in one pass with the verbs above, for the reason `bot-chrome-copy.ts` gives
//  about its own table**: several workstreams build on this file at once in one tree, and a
//  verb missing its builder is a button somebody hand-rolls as a string literal — which is
//  how a token silently exceeds 64 bytes and the keyboard stops working with no error.
//
//  Every builder goes through `token()`, so every one of them is length-checked.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The purchase ladder's other two rungs. `add` and `buy` above are unchanged.
 *
 * ⚠ **CORRECTED — this comment used to say `bargain` "hands the customer back to the
 * negotiating model", and that rests on a premise which is false.** The bargaining agent lives
 * entirely in **n8n**. jovi-mall's whole negotiation surface — `/api/internal/negotiation/`'s
 * playbook, tools and gate — sits behind `requireServiceToken` and is **n8n calling in**. There
 * is no outbound path from this service that makes the agent take a turn, and nothing here can
 * hand a conversation to it.
 *
 * What actually wakes the bargaining agent is the **customer's next inbound message**. So this
 * button's handler must say something worth replying to, and the customer's reply is what
 * engages the haggle. A handler that posted an opening offer and waited would wait forever.
 *
 * `book` reaches the slot picker, which is why it needs no variant: a booking names a product
 * and a slot. Verified in source by the stream that owns the purchase write path; the same
 * correction is recorded in `pd.html`, which carried the same false premise.
 */
export function bargainActionId(productId: string, variantId: string): string {
    return token('bargain', `${productId}:${variantId}`);
}

export function bookActionId(productId: string): string {
    return token('book', productId);
}

/**
 * `cart:view` — show me my basket.
 *
 * ⚠ **The argument is a literal, not an id, and that is not an oversight.** A customer has
 * exactly one open basket, so naming it would be inventing a parameter that could only ever be
 * wrong — the same reasoning that leaves `open:ol` and `open:sl` without a reference.
 * `parseBotActionId` requires a non-empty argument, so the literal is what satisfies it.
 */
export function cartViewActionId(): string {
    return token('cart', 'view');
}

/**
 * `open:<surface>:<ref>` — **one verb for all four in-app screens.**
 *
 * A verb per screen would have cost four entries in the closed set and four builders for what
 * is one action: *leave the chat and draw this properly*. The surface is the first argument
 * segment instead, which also means a fifth screen is a new SURFACE rather than a new VERB —
 * and a new verb is the thing that has to be documented, mapped and taught to the automation
 * layer.
 *
 * ⚠ **Three of the five carry no reference at all.** The order listing, the store listing and
 * checkout are scoped by the caller's own identity, so naming an id would be inventing a
 * parameter that could only ever be wrong. `parseBotActionId` requires a non-empty argument,
 * so the bare surface name IS the argument — `open:ol`, not `open:ol:`.
 *
 * ⚠ **`co` was added late, and the reason is worth keeping.** An earlier version of this type
 * excluded checkout on the grounds that "no tap-code should be able to open a screen that can
 * place an order". That instinct was right about the danger and wrong about where it lives.
 * The danger would be baking a MINTED checkout handle into a chat button — and that is exactly
 * what `open:co` does NOT do: it carries no reference, so the session is minted **on the tap**,
 * by the server, for whoever tapped. A pre-minted `co` handle in a button would also be dead
 * on arrival, since checkout handles live ten minutes and a chat message does not.
 *
 * So the rule that actually protects checkout is unchanged and is enforced elsewhere: a `co`
 * session is minted server-side, kind-checked on read, and **spent** by the write that places
 * the order. This type governs which screens a tap can ASK for, not what a tap can carry.
 */
export type BotInAppSurface = 'pd' | 'pl' | 'ol' | 'sl' | 'co';

export function openSurfaceActionId(surface: BotInAppSurface, ref?: string): string {
    return token('open', ref ? `${surface}:${ref}` : surface);
}

/**
 * `next:<setId>` — the next five cards **in the chat**.
 *
 * ⚠ **Not to be confused with `more:`, which now opens the in-app listing.** The two sit side
 * by side on one message and mean different things: this one keeps the customer in the
 * conversation, that one hands them a page. They share a set id because they are two ways of
 * reading the same held result — see `product-display.store.ts`.
 */
export function nextPageActionId(setId: string): string {
    return token('next', setId);
}

/**
 * `yes:<context>` and `no:<context>` — the universal confirm pair.
 *
 * ⚠ **The context is REQUIRED and that is the whole design.** A bare `yes` is a tap with no
 * memory of what it agreed to, arriving at a stateless layer — precisely what this file's
 * header says a token must never be. `yes:close` says what was agreed; `yes` says a customer
 * pressed something, once, about something.
 *
 * ⚠ **The context is also the ROUTING KEY.** `yes` and `no` are shared by several streams, so the
 * dispatcher routes them by the pair `yes:<context>` (`domain/bot-action-dispatch.ts`), and each
 * context has exactly one owning stream — two claiming one stops the process at boot. So a
 * context is a name in a namespace every stream shares, not a private label: pick one that says
 * what is being confirmed, and ask the registry's owner before using it.
 *
 * `ref` is what the confirmation is ABOUT — an order id, or `<orderId>:<shipmentId>`. Passed
 * separately rather than concatenated by the caller, so a context can never be malformed into
 * swallowing part of its reference. ⚠ Byte budget: with a two-id ref the context gets 10
 * characters before the token passes Telegram's 64.
 */
export function confirmActionId(context: string, ref?: string): string {
    return token('yes', ref ? `${context}:${ref}` : context);
}

export function declineActionId(context: string, ref?: string): string {
    return token('no', ref ? `${context}:${ref}` : context);
}

/**
 * A short, fixed-length stand-in for a category NAME: the first 16 hex characters of its SHA-256.
 *
 * ── ⚠ WHY A CATEGORY IS NAMED BY A DIGEST, NOT BY AN ID ─────────────────────
 * **This platform has no category ids.** `Product.category` is a plain indexed string — there is no
 * Category collection, model or taxonomy — and `listCategories()` answers only a name and a count.
 * So the only thing a caller could put in a token is the name, and a name is free text up to 200
 * characters, where every accented letter is two bytes. `cat:` plus
 * « Électroménager, électronique et équipements de la maison » is EXACTLY 64 bytes; one more
 * character and `token()` throws — while BUILDING the reply, so the whole turn fails rather than
 * one button. The first person to add a long French or Arabic category would have broken category
 * browsing for everyone who saw that list.
 *
 * A digest fits for any name, any length, any script (`cat:` + 16 = 20 bytes), and survives the
 * category list re-ordering — it is sorted by product count, so a position would not.
 *
 * ⚠ **Resolving one means RECOMPUTING this over the current category list** and matching. A
 * category that has since disappeared resolves to nothing, which the handler must answer as
 * "gone", never as an error. Hashed exactly as stored — no trimming, no case-folding — because the
 * match is against the same string `listCategories()` returns. 64 bits across one catalogue's
 * categories makes a collision not a practical concern, and one would open a real category rather
 * than fail.
 */
export function categoryDigest(categoryName: string): string {
    return createHash('sha256').update(categoryName, 'utf8').digest('hex').slice(0, 16);
}

/**
 * `cat:<digest>` — a category pick, which then opens the in-app listing.
 *
 * ⚠ **Takes the category NAME and digests it here**, so no caller can pass the wrong thing: not a
 * raw name (which would throw past 64 bytes on a long one), and not a hand-made digest that could
 * drift from `categoryDigest`. The builder and the digest live in one file so the two ends of the
 * token cannot disagree.
 */
export function categoryActionId(categoryName: string): string {
    return token('cat', categoryDigest(categoryName));
}

/** `ord:<orderId>` — pick one order out of the five the chat listed. */
export function orderActionId(orderId: string): string {
    return token('ord', orderId);
}

/**
 * `ord:<orderId>:cancel` — the Cancel button on an order card, which puts up the are-you-sure.
 *
 * ⚠ **A literal suffix on `ord`, deliberately NOT `no:ord:<id>`.** That shape was considered and
 * withdrawn: a `no:` meaning "yes, I want to cancel" is a trap for the next reader, and it needed
 * a paragraph to defend. The are-you-sure that follows answers with `yes:cnc` / `no:cnc`, where
 * the context really does name what is being agreed to. 35 bytes.
 */
export function orderCancelActionId(orderId: string): string {
    return token('ord', `${orderId}:cancel`);
}

/**
 * `shp:<orderId>:<shipmentId>` and `code:<orderId>:<shipmentId>`.
 *
 * ⚠ **Both carry the ORDER as well as the shipment, and the redundancy is deliberate.** Every
 * read on this surface is ownership-scoped through the order (`resolveOwnedOrder`), so a
 * token naming only a shipment would force a reverse lookup whose failure mode is answering
 * about somebody else's delivery. 53 bytes, inside the cap.
 *
 * ⚠ **There is no `resend` companion to `code`.** A replacement delivery code is issued by the
 * agent from the agent app, which keeps one issuing path; a second one here would let a
 * customer invalidate the code the agent is holding at the door.
 */
export function shipmentActionId(orderId: string, shipmentId: string): string {
    return token('shp', `${orderId}:${shipmentId}`);
}

/**
 * `shp:<orderId>` — every parcel on one order. The two-id form above is ONE parcel.
 *
 * ⚠ **Arity is what tells the two apart, inside the owning handler — not a sub-key.** `shp` has one
 * owner, so the dispatcher routes it by the verb alone; only verbs several streams share get a
 * sub-key. This is the order card's "Shipments" button, which used to emit `track:<orderId>` —
 * and `track` now means the tracking LINK, so an old card tapped today reaches a different answer.
 * 28 bytes.
 */
export function orderShipmentsActionId(orderId: string): string {
    return token('shp', orderId);
}

export function codCodeActionId(orderId: string, shipmentId: string): string {
    return token('code', `${orderId}:${shipmentId}`);
}

/**
 * `track:<orderId>` — the order's parcel status in one line, plus a Track LINK to the storefront's
 * tracking page.
 *
 * ⚠ **Changed meaning (2026-09-16): this used to open the parcel LIST**, which is now
 * `shp:<orderId>`. It points at the same tracking page the "order shipped" notification already
 * sends customers to, so one tracking view serves every door. And it is a tap that REPLIES with a
 * link rather than being a link itself, which is what lets a cash-on-delivery parcel card carry
 * both Get code and Track: WhatsApp cannot put a reply button and a URL button in one message.
 */
export function trackActionId(orderId: string): string {
    return token('track', orderId);
}

/**
 * `pay:st:<transactionId>` — Check status, and `pay:rt:<transactionId>` — Try again.
 *
 * `pay` has one owner, so `st` and `rt` are told apart inside its handler rather than by a
 * dispatcher sub-key. Worst case `pay:rt:` + a 24-hex id is 31 bytes.
 */
export function paymentStatusActionId(transactionId: string): string {
    return token('pay', `st:${transactionId}`);
}

export function paymentRetryActionId(transactionId: string): string {
    return token('pay', `rt:${transactionId}`);
}

/** `tkt:<ticketId>` — pick a support ticket to reply to, attach to, or close. */
export function ticketActionId(ticketId: string): string {
    return token('tkt', ticketId);
}

/**
 * `rate:<orderId>:<stars>` — a one-tap review from the delivered notification.
 *
 * ⚠ **The stars ride the token rather than being asked for afterwards**, because the moment a
 * delivery lands is the only moment a customer reliably rates anything. A follow-up question
 * costs the rating; five buttons cost one tap. Written text, if any, is a separate turn.
 */
export function rateActionId(orderId: string, stars: 1 | 2 | 3 | 4 | 5): string {
    return token('rate', `${orderId}:${stars}`);
}

/** `lang:<code>` — one of the five languages this surface speaks. */
export function languageActionId(language: string): string {
    return token('lang', language);
}

/**
 * Split a token back into its parts, or null when it is not one of ours.
 *
 * ⚠ **Returns null rather than throwing on an unknown verb**, because the input is whatever a
 * messaging platform sent back and a stale button from a previous deploy is an ordinary event,
 * not a fault. The caller turns a null into "I did not understand that" — which is a turn the
 * customer can act on, unlike a 500.
 */
export function parseBotActionId(
    raw: string | null | undefined,
): { verb: BotActionVerb; argument: string } | null {
    if (typeof raw !== 'string') return null;
    const separator = raw.indexOf(':');
    if (separator <= 0) return null;

    const verb = raw.slice(0, separator);
    const argument = raw.slice(separator + 1);
    if (!argument) return null;
    if (!(BOT_ACTION_VERBS as readonly string[]).includes(verb)) return null;

    return { verb: verb as BotActionVerb, argument };
}

/** ⚠ Exported for `test:bot-surface`, which re-checks the cap against the renderer's own. */
export const __CALLBACK_DATA_BYTES = CALLBACK_DATA_BYTES;
