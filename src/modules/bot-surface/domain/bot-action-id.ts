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
    /**
     * `bpay:<bookingId>` — pay for this appointment · `bpay:<bookingId>:b` — pay its balance.
     *
     * ⚠ **Not `pay:rt`, and the reason is the bug it replaces.** `pay:rt`'s handler re-opens a
     * charge for ORDERS (`resolveCheckoutPayment` filters `cartId: { $ne: null }`), so under a
     * failed booking payment it answered a customer about their orders. A booking is its own
     * money, with its own screen (`bp`).
     *
     * ⚠ **It carries a BOOKING ID, never a screen handle.** The `bp` session is minted on the tap,
     * by the server, for whoever tapped — the `open:co` property — so a button living in a chat
     * history for a month holds no credential, and a stranger's tap opens nothing (404).
     */
    'bpay',
    // ── Support, reviews, preferences ────────────────────────────────────────
    'tkt',
    'rate',
    'lang',
    // ── Discovery and bargaining ─────────────────────────────────────────────
    /** `sim:<productId>` — what else is like this one. */
    'sim',
    /** `save:<productId>` — keep it for later. ⚠ NOT a restock alert; nothing can send one. */
    'save',
    /** `deal:<sessionId>:<round>` — take the price the agent offered in that round. */
    'deal',
    // ── Digital delivery ─────────────────────────────────────────────────────
    /**
     * `dl:<entitlementId>` — download the file this entitlement grants.
     *
     * ⛔ **A BUTTON rather than a link in text, and the reason is mechanical.** A download URL
     * is public (the token IS the authorisation), SINGLE-USE and fifteen minutes long — and
     * both chat apps PRE-FETCH a URL that appears in message text to build a preview. A pasted
     * link is therefore spent by the preview crawler before the customer can tap it: they get
     * a dead link and the log records a successful download. A link button is not pre-fetched.
     */
    'dl',
    // ── The account surface ──────────────────────────────────────────────────
    /**
     * `acct:<section>[:<id>[:<op>]]` — every door on the account surface, under ONE verb with
     * one owning stream.
     *
     * ⚠ **A section, not a verb each.** Eight sections as eight verbs would put eight names in
     * the shared vocabulary for one stream's internal structure — and the dispatcher routes a
     * plain verb by the verb alone, so the argument grammar below stays inside the owning
     * handler where the next change to it is not somebody else's edit.
     *
     * Worst case is `acct:addr:new:<candidate>` at 60 bytes: a geocoding candidate handle is
     * `gc_` plus 43 characters, and `token()` throws above 64 rather than letting Telegram
     * truncate it in silence.
     */
    'acct',
    // ── Delivery-fee changes after checkout (ADR-A11 § Fee changes, W-H) ─────
    /**
     * `dfee:list` · `dfee:<orderId>` · `dfee:<orderId>:<proposalId>` · `dfee:pay:<proposalId>` —
     * the customer's side of a delivery-fee change: see what is waiting, and pay an approved
     * top-up. Approve / Decline ride the shared confirm pair as `yes:dfc:` / `no:dfc:`.
     *
     * ⚠ **No token carries an amount.** Every figure is re-read from the proposal on the press,
     * so a button sitting in a chat history can never commit the customer to a number they were
     * not shown — the `deal:` rule. The Decline / Accept pair carries the proposal's `version`,
     * which is what makes "the figure you saw" checkable (409 on an edited figure → the fresh
     * question is drawn instead).
     *
     * Worst case `dfee:<24>:<24>` = 54 bytes. Grammar owned by `parseDeliveryFeeArgument`.
     */
    'dfee',
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
 * `yes:tos` — accept the Terms of Service and Privacy Policy, the last onboarding step.
 *
 * Goes through `POST /catalog/action` like every other tap and is handled by
 * `bot-identity.controller.ts`. ⚠ **It needs ONE n8n condition to get there** (owner's choice,
 * 2026-09-28, over dressing it as a `skip:`): `wi-mall-core` → `route turn` sends every turn to
 * the onboarding router while `onboarding.next` is set, and that router knows only `skip:` and
 * `gc_` taps — anything else re-sends the question. The `onboarding` rule must exclude
 * `yes:tos` so it falls to the `tap` rule. Exact edit: `api-doc/n8n/bot-surface.md` § 11.5.
 */
export function acceptTermsActionId(): string {
    return confirmActionId('tos');
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
 * `book` needs no variant because a booking names a product and a slot. ⚠ **CORRECTED
 * 2026-09-27 — this said "`book` reaches the slot picker", and it did not**: the tap answered a
 * sentence asking the customer to type a day and a time, and nothing anywhere could open the
 * picker. It now answers that sentence WITH a **Choose a time** button (`open:bk:<productId>`),
 * which is what reaches the picker.
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
 * wrong — the same reasoning that leaves `open:ol` without a reference.
 * `parseBotActionId` requires a non-empty argument, so the literal is what satisfies it.
 *
 * ⚠ **This cited `open:sl` as the second example until 2026-09-20, and `open:sl` DOES NOT
 * EXIST.** No handler map claims it and nothing anywhere builds it: the store screen is real
 * and is reached by a TOOL (`inapp_open_stores`), never by a tap. The reasoning was sound and
 * one of its two examples was imaginary — which is how a reader comes away believing there is a
 * store tap to maintain.
 */
export function cartViewActionId(): string {
    return token('cart', 'view');
}

/**
 * `open:<surface>:<ref>` — **one verb for every in-app screen.**
 *
 * A verb per screen would have cost an entry in the closed set and a builder apiece for what is
 * one action: *leave the chat and draw this properly*. The surface is the first argument
 * segment instead, which also means a NEW screen is a new SURFACE rather than a new VERB — and
 * a new verb is the thing that has to be documented, mapped and taught to the automation layer.
 *
 * ⚠ **This said "all four screens", then "the five", and by 2026-09-20 there were EIGHT** —
 * `pd pl ol sl co bl bk bp`. The counts were correct when written and nothing made them wrong
 * out loud, which is the argument against counting in prose at all: the sentence now describes
 * the rule and the type below is the list.
 *
 * ⚠ **The ones that carry no reference are scoped by the caller's own identity** — the order
 * listing and checkout — so naming an id would be inventing a parameter that could only ever be
 * wrong. `parseBotActionId` requires a non-empty argument, so the bare surface name IS the
 * argument: `open:ol`, not `open:ol:`.
 *
 * ⚠ **A surface in this type is not the same thing as a TAP that reaches it.** Today a tap can
 * ask for `pl`, `pd`, `ol`, `co`, `bl` and `bk`; `sl` is reached only by a tool; and `bp` is
 * reached under its own verb, `bpay:`, because it needs a purpose as well as a booking.
 * `test-bot-surface` § 20 is what keeps that honest — it compares every token this file can
 * BUILD against every key the dispatcher ROUTES.
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
/**
 * ⚠ **All three bookings screens are nameable by a button, and NONE of those buttons carries a
 * handle.** `open:bl` carries nothing, `open:bk:<productId>` a product id, and `bpay:` (its own
 * verb) a booking id — so each session is minted server-side, on the tap, for whoever tapped: the
 * `open:co` property. ⚠ **CORRECTED 2026-09-27** — this said `bk` and `bp` were "deliberately
 * unreachable from a button at all", because a picker handle holds a slot and a payment handle
 * moves money. That hazard is real for a button carrying a HANDLE and does not apply to one
 * carrying an id; the rule as written was also the reason neither screen could ever be opened.
 * (A `bk` session holds no slot anyway: the hold is taken at Confirm.)
 */
export type BotInAppSurface = 'pd' | 'pl' | 'ol' | 'sl' | 'co' | 'bl' | 'bk' | 'bp';

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
 * ⚠ LEGACY — the token argument category buttons carried before 2026-10-04, kept ONLY so a
 * button already sitting in a chat history still resolves.
 *
 * Until then the platform had no category ids (`Product.category` was free text), so a button
 * could only carry the name — free text up to 200 characters, where « Électroménager,
 * électronique et équipements de la maison » alone is 64 bytes and one more character makes
 * `token()` throw while building the reply. A 16-hex SHA-256 prefix of the name was the
 * stand-in, resolved by recomputing it over the current list. Nothing MINTS one any more;
 * `handleCategoryTap` still recognises one (an argument that is not a 24-hex id), hashed
 * exactly as the name is stored.
 */
export function categoryDigest(categoryName: string): string {
    return createHash('sha256').update(categoryName, 'utf8').digest('hex').slice(0, 16);
}

/**
 * `cat:<categoryId>` — a category pick, which then opens the in-app listing.
 *
 * Categories are entries of one shared list with stable ids now
 * (PRODUCTION-READINESS/PRODUCT-CATEGORIES-PLAN.md), so the button carries the id: 28 bytes for
 * any name in any script, and it survives a RENAME (a name digest would not) and a MERGE (the
 * handler follows `merged_into` to the survivor).
 */
export function categoryActionId(categoryId: string): string {
    return token('cat', categoryId);
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

/**
 * `bpay:<bookingId>[:b]` — open the booking payment screen for this appointment's price, or with
 * `:b` for the balance a longer job came to. See the verb's note in `BOT_ACTION_VERBS`.
 *
 * ⚠ **The notification catalogue writes this as a LITERAL** (`bpay:{{…}}`), because its ids do
 * not exist until render time; `parseBookingPayArgument` below is what both must agree with, and
 * `test:inapp-bookings` parses the catalogue's literals with it.
 */
export function bookingPayActionId(bookingId: string, purpose: 'primary' | 'balance'): string {
    return token('bpay', purpose === 'balance' ? `${bookingId}:b` : bookingId);
}

/** The argument of a `bpay:` token, or null when it is not one this service could have drawn. */
export function parseBookingPayArgument(
    argument: string,
): { bookingId: string; purpose: 'primary' | 'balance' } | null {
    const match = /^([0-9a-f]{24})(:b)?$/.exec(argument);
    if (!match) return null;
    return { bookingId: match[1], purpose: match[2] ? 'balance' : 'primary' };
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
 * `sim:<productId>` — products similar to this one, as a listing. Drawn on an out-of-stock card,
 * where the buy buttons are gone and "what else is like it" is the useful next step. 28 bytes.
 *
 * ⚠ Not `open:pl:<productId>`: `open:pl` is already Browse more, and its handler refuses any
 * argument. Overloading it would give one key two meanings decided by whether an argument exists.
 */
export function similarItemsActionId(productId: string): string {
    return token('sim', productId);
}

/**
 * `save:<productId>` — put the product in the customer's saved items. 29 bytes.
 *
 * ⚠ Owner decision 2026-09-16: this REPLACES "Notify me". Nothing on the platform can tell a
 * customer when something is back in stock, so the button promises nothing of the kind — it saves.
 */
export function saveForLaterActionId(productId: string): string {
    return token('save', productId);
}

/**
 * `deal:<sessionId>:<round>` — accept the price the bargaining agent offered in that round, and put
 * the item in the basket at it. At most 33 bytes (a 24-hex session id, a round under 1000).
 *
 * ⛔ **The token carries a REFERENCE, never a price** (owner's rule). The price is read from the
 * negotiation session's own record of that round and re-judged against the live window on the
 * press — a price in the token would let anyone lock any figure. The ROUND is what makes "the exact
 * price shown" true: a press on an offer the agent has since replaced is refused as superseded,
 * never locked at a price the customer did not see.
 */
export function lockInOfferActionId(sessionId: string, round: number): string {
    return token('deal', `${sessionId}:${round}`);
}

/**
 * `rate:<orderId>` · `rate:<orderId>:<stars>` · `rate:<orderId>:<stars>:<productId>`
 *
 * ⭐ **The one verb in this file whose grammar was still free to choose.** The rule above — a
 * verb's meaning is frozen forever, because a button lives in a chat history indefinitely — did
 * not apply here: `rateActionId` had never been called from anywhere, so no `rate:` button has
 * ever reached a customer and there was no history to protect. Read the freezing rule as still
 * absolute for every other verb; this was a one-time window.
 *
 * Told apart by ARITY, exactly as `shp:<orderId>` and `shp:<orderId>:<shipmentId>` are:
 *   `rate:<orderId>`                        the invitation — asks for the stars.      29 B
 *   `rate:<orderId>:<stars>`                one product on the order → the review is  31 B
 *                                           created; several → asks which.
 *   `rate:<orderId>:<stars>:<productId>`    that product, at those stars.             56 B
 *
 * ⚠ **Stars before product, and the order matters.** The stars are the impulse at the moment a
 * delivery lands, and the comment on `rateActionId` is right that a follow-up question costs the
 * rating. A single-product order — the common case — is one tap after the invitation.
 */
export function rateInviteActionId(orderId: string): string {
    return token('rate', orderId);
}

export function rateProductActionId(orderId: string, stars: 1 | 2 | 3 | 4 | 5, productId: string): string {
    return token('rate', `${orderId}:${stars}:${productId}`);
}

/**
 * `dl:<entitlementId>` — download the file this entitlement grants. 27 bytes.
 *
 * ⛔ **The token names the ENTITLEMENT, never the download link.** A link is single-use and
 * lives 15 minutes; a chat message lives forever, so a minted URL baked into a button would be
 * dead for almost everyone who ever tapped it. The server mints on the press — the same rule
 * `open:co` follows for checkout, and `deal:` for a price.
 */
export function downloadActionId(entitlementId: string): string {
    return token('dl', entitlementId);
}

/**
 * `acct:<section>[:<id>[:<op>]]` — the account surface.
 *
 * Sections: `menu` · `prof` · `addr` · `pay` · `ntf` · `inbox` · `conn` · `lang` · `close` ·
 * `contact`. Operations ride as further parts — `acct:addr:<id>:def`, `acct:addr:<id>:rm`,
 * `acct:inbox:read`, `acct:contact:em:resend`, `acct:addr:new:<candidateRef>`.
 *
 * ⚠ **Variadic rather than one `argument` string**, so no caller can hand-build a section and
 * an id with the wrong separator; the joining happens here, once, and `token()` checks the
 * result against the 64-byte cap for every shape.
 */
export function accountActionId(section: string, ...parts: string[]): string {
    return token('acct', [section, ...parts].join(':'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Delivery-fee changes after checkout (ADR-A11 § Fee changes after checkout, W-H)
//
//  One verb, `dfee`, owned by one stream (`bot-delivery-fee.controller.ts`), told apart by its
//  first argument exactly as `shp:` and `tkt:` are — plus the shared confirm pair under the
//  context `dfc`. The builders and the parsers sit together so the notification catalogue's
//  hand-written literal (`dfee:{{orderId}}`) and every drawn button are read by ONE grammar.
// ─────────────────────────────────────────────────────────────────────────────

/** The confirm context for Accept / Decline on a delivery-fee change. */
export const DELIVERY_FEE_CONFIRM_CONTEXT = 'dfc';

/** `dfee:list` — every delivery-fee change waiting for this customer, across their open orders. */
export function deliveryFeeListActionId(): string {
    return token('dfee', 'list');
}

/**
 * `dfee:<orderId>` — the changes waiting on ONE order: one → its question; several → a choice.
 *
 * ⚠ **What the delivery-fee notifications carry** (`order.delivery_fee.approval_needed` ·
 * `topup_due` · `topup_failed`), as the literal `dfee:{{orderId}}`: the notifier's context holds
 * the order and not the proposal, and an order-scoped button re-reads the CURRENT figure on the
 * press — a notification is exactly the button most likely to be pressed after an edit.
 */
export function deliveryFeeOrderActionId(orderId: string): string {
    return token('dfee', orderId);
}

/** `dfee:<orderId>:<proposalId>` — one change's question. A row in the choice above. 54 bytes. */
export function deliveryFeeProposalActionId(orderId: string, proposalId: string): string {
    return token('dfee', `${orderId}:${proposalId}`);
}

/**
 * `dfee:pay:<proposalId>` — charge the approved top-up to the wallet on the account. 33 bytes.
 *
 * ⚠ **Charges the amount the APPROVAL froze** (`proposal.topup.amount`), never a recomputed one —
 * `DeliveryFeeProposalService.customerPay` owns that rule. The token carries no amount.
 */
export function deliveryFeePayActionId(proposalId: string): string {
    // The sub-word is a constant, not a `pay:` literal: this is the ARGUMENT of a `dfee` token, and a
    // literal head would read as a `pay:` token to test:inapp-fulfilment's hand-written-token scan.
    const payStep = 'pay';
    return token('dfee', `${payStep}:${proposalId}`);
}

/** `yes:dfc:<proposalId>:<version>` — Accept. ≤ 45 bytes for any version under 10⁹. */
export function deliveryFeeAcceptActionId(proposalId: string, version: number): string {
    return confirmActionId('dfc', `${proposalId}:${version}`);
}

/** `no:dfc:<proposalId>:<version>` — Decline. */
export function deliveryFeeDeclineActionId(proposalId: string, version: number): string {
    return declineActionId('dfc', `${proposalId}:${version}`);
}

export type DeliveryFeeTap =
    | { kind: 'list' }
    | { kind: 'order'; orderId: string }
    | { kind: 'proposal'; orderId: string; proposalId: string }
    | { kind: 'pay'; proposalId: string };

/**
 * The argument of a `dfee:` token, or null when it is not one this service could have drawn.
 * Lower-case hex only, as every id this service mints is.
 */
export function parseDeliveryFeeArgument(argument: string): DeliveryFeeTap | null {
    if (argument === 'list') return { kind: 'list' };
    let match = /^pay:([0-9a-f]{24})$/.exec(argument);
    if (match) return { kind: 'pay', proposalId: match[1] };
    match = /^([0-9a-f]{24})$/.exec(argument);
    if (match) return { kind: 'order', orderId: match[1] };
    match = /^([0-9a-f]{24}):([0-9a-f]{24})$/.exec(argument);
    if (match) return { kind: 'proposal', orderId: match[1], proposalId: match[2] };
    return null;
}

/**
 * The argument of a `yes:dfc:` / `no:dfc:` token AFTER the context (`<proposalId>:<version>`),
 * or null. The version is a positive integer the service compares with the proposal's own.
 */
export function parseDeliveryFeeConfirmArgument(argument: string): { proposalId: string; version: number } | null {
    const match = /^([0-9a-f]{24}):([1-9][0-9]{0,8})$/.exec(argument);
    if (!match) return null;
    return { proposalId: match[1], version: Number(match[2]) };
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
