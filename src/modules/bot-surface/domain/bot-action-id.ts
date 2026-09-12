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

/** The closed verb set. A token's first segment is always one of these. */
export const BOT_ACTION_VERBS = Object.freeze(['skip', 'add', 'buy', 'more'] as const);
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
