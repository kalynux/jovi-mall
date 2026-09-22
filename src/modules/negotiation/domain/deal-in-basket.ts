import type { ErrorCategory } from '../../../core/error-category';
import { customerMessageFor } from '../../bot-surface/domain/bot-error-copy';
import { botChrome } from '../../bot-surface/domain/bot-chrome-copy';
import { recoveryFor } from '../../bot-surface/domain/bot-recovery-actions';
import type { BotReplyIntent } from '../../bot-surface/domain/channel-reply';
import { addedToCartActions } from '../../bot-surface/domain/purchase-chat-copy';
import { WA_LIMITS } from '../../whatsapp/constants/whatsapp-limits';

/**
 * What the customer reads once an agreed deal has gone into — or failed to go into — the basket.
 *
 * ── ⭐ ONE DEFINITION, TWO CLOSERS ──────────────────────────────────────────
 * A deal has two closers: the customer pressing **Lock it in** (`deal:` tap,
 * `bot-negotiation.controller.ts`), and the bargaining agent agreeing in words (the gate,
 * `NegotiationService.record` with `lock: true`). Owner, 2026-09-22: *"a deal agreed in words must
 * do exactly what the lock-in button does"* — the item goes into the basket at the locked price and
 * the customer gets the same line and the same three buttons as any other add.
 *
 * Until then only the press did that. The spoken close minted the lock and stopped: the customer
 * read the agent's sentence ("…what's your delivery address and number?"), nothing was in the
 * basket, no button was drawn, and the purchase depended on a later turn remembering the lock
 * (executions 1914 → 1934, 2026-09-22). So the wording lives here, pure, and both doors render it.
 *
 * ── THE SPOKEN CLOSE KEEPS THE AGENT'S SENTENCE ─────────────────────────────
 * The gate's contract (plan D-4) is that the customer reads the sentence the gate approved. On a
 * spoken close that sentence LEADS, and the platform's own line follows it in the same message:
 *
 *     «Va pour 10 500 l'unité 🤝»
 *
 *     Marché conclu — c'est dans votre panier à ce prix.
 *     [ Voir le panier ] [ Commander ] [ Continuer ]
 *
 * ⚠ **The basket claim is the platform's, never the model's.** The model writes its sentence BEFORE
 * the basket write happens, so it cannot know whether the write will succeed — a basket holding a
 * digital item refuses a physical one. The playbook therefore tells it to confirm the price and
 * nothing else, and this module adds "it's in your basket" only on the branch where that is true.
 * On a refusal the same slot carries the cart's own customer sentence instead, so no message ever
 * tells a customer something is in their basket when it is not.
 *
 * ⚠ **Pure, and it must stay so.** No service, no controller, no clock: `test:negotiation` renders
 * every branch in five languages with no database, and the deploy-day harness loads this file into
 * the n8n simulator to feed the LIVE `decide send` node exactly what the gate will return.
 */

/** A basket write that did not happen, as the cart refused it. */
export interface BasketRefusal {
    /** The cart's own error code — the key the customer sentence is resolved by. */
    code: string;
    category: ErrorCategory;
    details?: Record<string, unknown>;
}

/**
 * The body budget a deal message is composed to.
 *
 * ⚠ **WhatsApp's interactive body is 1 024 characters and the renderer cuts from the END.** A long
 * agent sentence followed by the platform's line would lose the LINE — the one part that says where
 * the item is — so the lead is trimmed instead, and the line always survives. Telegram allows 4 096;
 * one budget for both keeps a message identical on the two channels.
 */
export const DEAL_MESSAGE_BUDGET = WA_LIMITS.INTERACTIVE_BODY;

const SEPARATOR = '\n\n';

/**
 * The agent's sentence, then the platform's line — the line kept whole whatever the lead's length.
 *
 * A blank or absent lead yields the line alone, which is exactly the press's message.
 */
export function composeDealText(lead: string | null | undefined, line: string): string {
    const trimmed = (lead ?? '').trim();
    if (trimmed === '') return line;

    const room = DEAL_MESSAGE_BUDGET - SEPARATOR.length - line.length;
    // A line that fills the budget on its own leaves no room for a lead; the line is what matters.
    if (room <= 1) return line;

    const fitted = trimmed.length <= room ? trimmed : `${trimmed.slice(0, room - 1).trimEnd()}…`;
    return `${fitted}${SEPARATOR}${line}`;
}

/**
 * The deal is in the basket: *"Deal — it's in your basket at that price."* and View basket ·
 * Checkout · Keep shopping.
 *
 * ⚠ **The three buttons are `addedToCartActions`, never a local list** — every door that adds to
 * the basket offers the same next steps (`purchase-chat-copy.ts` says why, and pins the count at
 * WhatsApp's cap of three). With no `lead` this is byte-for-byte the press's reply.
 */
export function dealInBasketIntent(language: string | null, lead?: string | null): BotReplyIntent {
    return {
        kind: 'text',
        text: composeDealText(lead, botChrome('dealLockedPrompt', language)),
        actions: addedToCartActions(language),
    };
}

/**
 * The deal stands but the basket refused the line.
 *
 * The sentence and buttons are the ones the bot surface draws for the same refusal on a tap
 * (`customerMessageFor` + `recoveryFor`, exactly as `bot-reply.middleware.ts` composes an error
 * reply), so a customer reads the same explanation whichever closer they used. The price lock is
 * untouched: it stays live for its TTL and the assistant can still spend it with `cart_add_item`
 * once the basket can take the line.
 *
 * ⛔ **Never the basket line here.** Saying "it's in your basket" on this branch is the one lie this
 * module exists to make impossible.
 */
export function dealRefusedIntent(
    refusal: BasketRefusal,
    language: string | null,
    lead?: string | null,
): BotReplyIntent {
    const sentence = customerMessageFor(refusal.code, refusal.category, language);
    const recovery = recoveryFor({
        code: refusal.code,
        category: refusal.category,
        details: refusal.details,
        text: sentence,
        language,
    });
    const text = composeDealText(lead, recovery.text);

    return recovery.actions.length > 0
        ? { kind: 'text', text, actions: recovery.actions }
        : { kind: 'text', text };
}
