import { botChrome } from './bot-chrome-copy';
import { cartViewActionId, openSurfaceActionId } from './bot-action-id';
import type { BotReplyOption } from './channel-reply';

/**
 * The two pieces of purchase wording that MORE THAN ONE DOOR produces — pure, and importable
 * by anything.
 *
 * ── ⚠ WHY THEY MOVED OUT OF THE CONTROLLER ──────────────────────────────────
 * Both used to live in `bot-purchase.controller.ts`, exported, and four callers imported them
 * from there: the cart controller, the negotiation controller, the WhatsApp form completion
 * command, and the controller itself. That worked at runtime and broke two other things.
 *
 *   - **A suite cannot import a controller here.** `test:whatsapp-flows` imports the form
 *     completion command, which reached `bot-purchase.controller.ts`, which reaches `orders/`
 *     and `payments/` — and those do work at import under bare `ts-node` and never return, so
 *     the run produces NO OUTPUT and reads as a broken test rather than a hung one.
 *   - **A WhatsApp customer was left in an empty thread.** A form's completion pushes nothing
 *     (`pushIntoConversation` belongs to the web screen's door, not the form's), so when a
 *     customer taps Bargain or Book inside a form, the CHAT has to answer the form's completion
 *     — with the same question the chat tap produces. The alternative was a second copy of that sentence, which is the drift
 *     `addedToCartActions`'s own comment warns about.
 *
 * ⚠ **This module imports NO service and no controller**, and must not start: that property is
 * the whole reason it exists. `bot-chrome-copy` and `bot-action-id` are pure domain, and
 * `channel-reply` is imported for its type alone.
 */

/**
 * View cart · Checkout · Browse more — the three things a customer wants after adding something.
 *
 * ⚠ **Four doors produce an "added to cart" turn** and they must offer the same three controls:
 * the purchase tap, `cart_add_item` when the customer typed their order, a won bargain, and a
 * WhatsApp form's completion. Two copies of this list is how one door quietly grows a fourth
 * button, or loses Checkout, and nothing fails.
 *
 * All three are tokens rather than typed words, per `bot-action-id.ts`'s rule: the label is
 * translated, the id is not.
 *
 * ⚠ **The Checkout token carries NO handle.** A `co` session is ten minutes and single-use, so
 * baking one into a button would produce a control that is dead before most customers tap it.
 * The server mints on the tap instead, which is the shape `open:ol` and `open:sl` already use.
 *
 * ⚠ **Exactly three, which is WhatsApp's hard cap.** A fourth is dropped by the renderer in
 * silence, so a fourth added here would disappear on one channel and not the other.
 */
export function addedToCartActions(language: string | null): BotReplyOption[] {
    return [
        { id: cartViewActionId(), label: botChrome('viewCartButton', language) },
        { id: openSurfaceActionId('co'), label: botChrome('checkoutButton', language) },
        { id: openSurfaceActionId('pl'), label: botChrome('browseMoreButton', language) },
    ];
}

/** The two rungs that write nothing and ask a question instead. */
export type PurchaseInviteVerb = 'bargain' | 'book';

/**
 * The product, then the question — for the two rungs that START A CONVERSATION rather than
 * writing to the basket.
 *
 * ⚠ **A question, never an announcement, and that is load-bearing rather than tone.** jovi-mall
 * cannot start a bargain: the agent lives in the automation layer and wakes on the customer's
 * NEXT INBOUND MESSAGE. A message that merely announced the haggle would reach the customer,
 * engage nobody, and leave the conversation dead. The same holds for a booking, which needs a
 * day and a time only the customer can give.
 *
 * ⚠ **The title is on its own line above the fixed sentence, never interpolated into it** —
 * the rule `bot-chrome-copy.ts` keeps, so no translation has to decide where a product name
 * belongs in its own word order.
 */
export function purchaseInvitePrompt(
    title: string,
    verb: PurchaseInviteVerb,
    language: string | null,
): string {
    const key = verb === 'bargain' ? 'bargainInvitePrompt' : 'bookInvitePrompt';
    return `${title}\n\n${botChrome(key, language)}`;
}
