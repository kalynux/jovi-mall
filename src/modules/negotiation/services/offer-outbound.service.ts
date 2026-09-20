import { CustomerModel } from '../../customers/customer.model';
import { lockInOfferActionId } from '../../bot-surface/domain/bot-action-id';
import { botChrome } from '../../bot-surface/domain/bot-chrome-copy';
import { BotChannelReply, BotReplyIntent, renderBotReply } from '../../bot-surface/domain/channel-reply';
import { formatBotPrice } from '../../bot-surface/domain/product-card';
import { NegotiationIdentity } from '../validators/negotiation.validator';

/**
 * The counter-offer, as a message with the price ON a button.
 *
 * ── ⛔ WHY THE GATE HAS TO BUILD THIS, RATHER THAN THE AUTOMATION LAYER ──────
 * `negotiation_record` returns the approved sentence as a **plain string**, and the bargaining
 * flow sends exactly that string — which is the whole of plan D-4: the customer reads the message
 * the gate approved and no other. A button cannot be bolted on in n8n without re-opening that
 * property, because whatever composed the button would be composing a message the gate never saw.
 *
 * So the gate returns the channel-ready body **beside** the string. `reply` keeps its exact meaning
 * and value — the live flow sends it today and must keep working — and `outbound` is a sibling the
 * flow prefers when present. One field added, nothing changed.
 *
 * ── WHAT THE BUTTON SAYS, AND WHY THE PRICE IS ON IT ────────────────────────
 * *Lock it in · 18 000 XAF*. A press is an ACCEPTANCE, and the whole argument for letting a button
 * close a deal is that the customer can see what they are agreeing to at the moment they agree. A
 * button reading only "Lock it in" under a paragraph of haggling would be exactly the inference
 * from context that this design refuses.
 *
 * WhatsApp caps a reply-button title at 20 characters, which the full label does not fit, so the
 * short form is `✓ <price>` — 18 characters at a nine-digit price, measured. Telegram draws the
 * full label.
 *
 * ── ⚠ THE LANGUAGE IS THE CUSTOMER'S STORED ONE, NEVER THE CHANNEL'S LOCALE ──
 * The identity the gate resolves carries no language, so this reads `preferences.language` the way
 * the bot surface's own middleware does. The alternative — letting the caller pass the locale it
 * has — was considered and refused: n8n holds Telegram's `language_code`, which is the phone's
 * language and explicitly not the one the customer chose for this bot. It would look right in
 * testing, where the two usually agree, and be wrong for exactly the people who changed it.
 *
 * Best-effort and self-catching: a language lookup must never be the thing that fails a gate call.
 * English is the fallback, as it is everywhere else on this surface.
 */

export interface OfferOutboundInput {
    identity: NegotiationIdentity;
    customerId: string;
    sessionId: string;
    /** The round this offer was recorded as — what the press names. */
    round: number;
    /** The sentence the gate has just approved, sent verbatim. */
    reply: string;
    unitPrice: number;
    currency: string;
}

/**
 * The offer as an INTENT — pure, so the label, the short label and the token can be driven by a
 * suite with no database and no clock. The I/O (one language lookup) is the wrapper below.
 */
export function counterOfferIntent(input: {
    sessionId: string;
    round: number;
    reply: string;
    unitPrice: number;
    currency: string;
    language: string | null;
}): BotReplyIntent {
    const price = formatBotPrice(input.unitPrice, input.currency);

    return {
        kind: 'text',
        text: input.reply,
        actions: [
            {
                id: lockInOfferActionId(input.sessionId, input.round),
                label: `${botChrome('lockItInButton', input.language)} · ${price}`,
                /**
                 * ⚠ **WhatsApp's reply-button title is 20 characters and the full label does not
                 * fit.** `✓ <price>` is 18 at a nine-digit amount — measured, not assumed — and it
                 * keeps the number on the control, which is the whole point: a press is an
                 * acceptance, so the customer must see the price at the moment they accept.
                 */
                shortLabel: `✓ ${price}`,
            },
        ],
    };
}

export async function buildCounterOfferOutbound(
    input: OfferOutboundInput,
): Promise<BotChannelReply | null> {
    try {
        const language = await readStoredLanguage(input.customerId);

        return renderBotReply(
            counterOfferIntent({ ...input, language }),
            input.identity.channel,
            input.identity.externalId,
        );
    } catch (error) {
        /**
         * ⚠ **A missing button must never cost the customer the message.** The sentence is already
         * approved and `reply` carries it; the flow falls back to sending the plain string, which
         * is exactly what it did before this existed. Silence would be the one unacceptable outcome.
         */
        console.warn('[Negotiation] could not build the lock-it-in reply', error);
        return null;
    }
}

async function readStoredLanguage(customerId: string): Promise<string | null> {
    const customer = await CustomerModel.findById(customerId).select('preferences.language').lean();
    return customer?.preferences?.language ?? null;
}
