import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { MessagingChannel } from '../../channel-connections';
import { publicCatalogService } from '../../catalog/services/public-catalog.service';
import { CustomerRepository } from '../../customers/customer.repository';
import { BargainEntryIds, bargainEntryIdsAreValid } from '../../bot-commands/domain/bargain-entry';
import { addToCartActionId, bookActionId, buyNowActionId } from '../domain/bot-action-id';
import { unknownBotAction } from '../domain/bot-action-dispatch';
import { botChrome } from '../domain/bot-chrome-copy';
import { BotReplyIntent } from '../domain/channel-reply';
import { onboardingReplyIntent } from '../domain/onboarding-reply';
import { resolvePurchaseAffordance } from '../domain/purchase-affordance';
import { purchaseInvitePrompt } from '../domain/purchase-chat-copy';
import { toBotSyncDto } from '../dto/bot-projections';
import { currentRecords } from './bot-registration.service';
import { pendingBargainStore } from './pending-bargain.store';

/**
 * The website's **Bargain** button, once it has reached the bot.
 *
 * ── WHAT IT DOES, AND THE ONE THING IT CANNOT ───────────────────────────────
 * It asks the customer the price question for one exact product and records a hand-off, so that
 * the ANSWER reaches the bargaining agent rather than the main assistant. It cannot start the
 * haggle itself: the agent lives in n8n and wakes only on an inbound customer message
 * (`bargain-cannot-be-started-from-backend`). So this is the screen-press path
 * (`pending-bargain.store.ts`, `N8N-DEPLOY-DAY-CHANGES.md` § 8.2a) reached through a third door —
 * the next `/identity/sync` hands the press to n8n as `pendingBargain`, n8n writes its routing
 * flag, and the customer's offer lands on the bargainer. No n8n change was needed for any of it.
 *
 * ── THREE ARRIVALS, ONE RESOLUTION ──────────────────────────────────────────
 *   1. A customer with a finished setup → the price question, now (`beginBargainFromLink`).
 *   2. A customer mid-setup (WhatsApp creates the account on the first message, so this is the
 *      usual WhatsApp newcomer) → the press is held and the SETUP question is asked, led by one
 *      sentence saying the haggle is kept. The price question comes on the turn that completes
 *      the checklist (`replyForHeldBargain`, called from `bot-identity.controller.ts`).
 *   3. A Telegram chat with no account yet → refused by the identity guard before any handler,
 *      which already answers with the contact-share button. `holdForUnregisteredSender` keeps
 *      the product through that refusal; arrival 2 takes it from there.
 *
 * ── ⚠ WHY A FIXED PRICE IS OFFERED, NEVER ADDED ─────────────────────────────
 * A chat `bargain:` tap re-resolves its rung and, on a product that stopped being negotiable,
 * ADDS it to the basket (`executePurchase`). That is right for a card in a chat history and wrong
 * for a link opened from a website: the customer asked to haggle, not to buy. Owner decision
 * (2026-09-27) — say the price is fixed and offer the basket with a button. This service
 * therefore NEVER calls `executePurchase` and never writes a cart.
 */

const customerRepository = new CustomerRepository();

/** What the link resolves to, read live. */
export type BargainEntryVerdict =
    | { kind: 'bargain'; productId: string; variantId: string; productTitle: string }
    | { kind: 'fixed'; verb: 'add' | 'buy' | 'book'; productId: string; variantId: string | null; productTitle: string };

/**
 * Read every rule live — the link is text the customer may have edited, and the page it came from
 * may be a day old.
 *
 * Refusals are THROWN, as `executePurchase`'s are, so they reach the customer through the bot
 * surface's one refusal path (`error.customerMessage`, in their language):
 *   - an id that is not an id                   → `BOT_ACTION_TOKEN_UNKNOWN` (the tap's refusal)
 *   - a product gone, unpublished or suspended  → `CATALOG_PRODUCT_NOT_FOUND`
 *   - a variant gone, or out of stock           → `CATALOG_VARIANT_INSUFFICIENT_STOCK`
 */
export async function resolveBargainEntry(ids: BargainEntryIds): Promise<BargainEntryVerdict> {
    if (!bargainEntryIdsAreValid(ids)) throw unknownBotAction();

    // The publishability gate: refuses a draft, suspended, deleted or unpublished-vendor product
    // exactly as the storefront does.
    const product = await publicCatalogService.getProductById(ids.productId);

    /**
     * ⚠ **A NAMED variant that no longer exists is refused, not swapped for the default.** A chat
     * card falls back to the default (`executePurchase`), but the website sent the exact variant
     * the visitor picked, and haggling over a different one — another size, another price — is
     * not what they asked for. Only a link that named no variant gets the default.
     */
    const variant = ids.variantId
        ? product.variants.find((v) => v.id === ids.variantId) ?? null
        : product.variants.find((v) => v.id === product.defaultVariantId) ?? null;

    const affordance = resolvePurchaseAffordance({
        type: product.type,
        negotiable: variant?.negotiable ?? false,
        inStock: variant?.inStock ?? false,
        variantId: variant?.id ?? null,
    });

    if (!affordance.enabled || (ids.variantId !== null && !variant)) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK, 422, 'That item cannot be bought right now');
    }

    if (affordance.verb === 'bargain' && variant) {
        return { kind: 'bargain', productId: ids.productId, variantId: variant.id, productTitle: product.title };
    }

    return {
        kind: 'fixed',
        verb: affordance.verb === 'bargain' ? 'add' : affordance.verb,
        productId: ids.productId,
        variantId: variant?.id ?? null,
        productTitle: product.title,
    };
}

/** The price question — byte-identical to what a `bargain:` tap asks. */
export function bargainInviteIntent(productTitle: string, language: string | null): BotReplyIntent {
    return { kind: 'text', text: purchaseInvitePrompt(productTitle, 'bargain', language) };
}

/** "This has a fixed price now — want it anyway?" with the ONE button that gets it. */
export function fixedPriceIntent(
    verdict: Extract<BargainEntryVerdict, { kind: 'fixed' }>,
    language: string | null,
): BotReplyIntent {
    if (verdict.verb === 'book') {
        return {
            kind: 'text',
            text: `${verdict.productTitle}\n\n${botChrome('bargainBookInsteadPrompt', language)}`,
            actions: [{ id: bookActionId(verdict.productId), label: botChrome('bookButton', language) }],
        };
    }

    // `add`/`buy` are only ever resolved with a variant — `sellable` requires one.
    const variantId = verdict.variantId!;
    const action = verdict.verb === 'buy'
        ? { id: buyNowActionId(verdict.productId, variantId), label: botChrome('buyNowButton', language) }
        : { id: addToCartActionId(verdict.productId, variantId), label: botChrome('addToCartButton', language) };

    return {
        kind: 'text',
        text: `${verdict.productTitle}\n\n${botChrome('bargainFixedPricePrompt', language)}`,
        actions: [action],
    };
}

export interface BargainLinkCaller {
    userId: string;
    customerId: string;
    channel: MessagingChannel;
    externalId: string;
    language: string | null;
}

export interface BargainLinkResult {
    intent: BotReplyIntent;
    /** What happened, for the response `data` and the log. */
    outcome: 'bargain_invited' | 'bargain_held_for_setup' | 'fixed_price';
    productId: string;
    variantId: string | null;
}

/**
 * Arrivals 1 and 2 — a resolved customer typed (or a link typed for them) the Bargain command.
 *
 * ⚠ **The press is recorded BEFORE the question is returned**, the rule `screenAct` keeps for the
 * same reason: a customer quick enough to answer must not reach `/identity/sync` ahead of the
 * record. Here the reply is sent by n8n after this returns, so the ordering is guaranteed anyway —
 * but it costs nothing to keep the two doors identical.
 */
export async function beginBargainFromLink(caller: BargainLinkCaller, ids: BargainEntryIds): Promise<BargainLinkResult> {
    const verdict = await resolveBargainEntry(ids);

    if (verdict.kind === 'fixed') {
        return {
            intent: fixedPriceIntent(verdict, caller.language),
            outcome: 'fixed_price',
            productId: verdict.productId,
            variantId: verdict.variantId,
        };
    }

    await pendingBargainStore.record(
        { owner: caller.userId, channel: caller.channel, externalId: caller.externalId },
        { productId: verdict.productId, variantId: verdict.variantId },
    );

    const setup = await setupQuestionFor(caller);
    if (setup) {
        /**
         * ⭐ Mid-setup. The price question would be answered with a price, and the next message
         * belongs to the checklist — `route turn` sends it to onboarding and `/identity/sync`
         * does not spend a hand-off while a step is outstanding. So ask the setup question, led
         * by one sentence saying the haggle is kept. It keeps the step's own control (the
         * contact keyboard, the location button, the Skip action) because it IS that step's
         * rendering, with a line in front.
         */
        const lead = `${verdict.productTitle}\n\n${botChrome('bargainAfterSetupPrompt', caller.language)}`;
        return {
            intent: { ...setup, text: `${lead}\n\n${setup.text}` },
            outcome: 'bargain_held_for_setup',
            productId: verdict.productId,
            variantId: verdict.variantId,
        };
    }

    return {
        intent: bargainInviteIntent(verdict.productTitle, caller.language),
        outcome: 'bargain_invited',
        productId: verdict.productId,
        variantId: verdict.variantId,
    };
}

/**
 * The customer's outstanding setup question, rendered — or null when the checklist is done.
 * Through `toBotSyncDto` and `onboardingReplyIntent`, the two functions every sync already uses,
 * so this is the SAME question and the same control the next sync would have asked.
 */
async function setupQuestionFor(caller: BargainLinkCaller): Promise<Extract<BotReplyIntent, { text: string }> | null> {
    const customer = await customerRepository.findById(caller.customerId);
    if (!customer) return null;

    const language = customer.preferences?.language ?? caller.language;
    const next = toBotSyncDto({
        registered: true,
        isNew: false,
        upgraded: false,
        customer: null,
        records: currentRecords(customer),
        channel: caller.channel,
        language,
    }).onboarding.next;

    const intent = onboardingReplyIntent(next, language);
    return intent && 'text' in intent ? (intent as Extract<BotReplyIntent, { text: string }>) : null;
}

/**
 * The turn that COMPLETES the setup checklist: is a website Bargain link waiting?
 *
 * Returns the reply to send instead of the welcome, or null for "no link held — welcome as usual".
 * It PEEKS rather than consumes: the next `/identity/sync` spends the hand-off, because that sync
 * is the one carrying the customer's answer to this question.
 *
 * ⚠ **Never throws.** It runs on an onboarding write that has already succeeded; a catalogue
 * hiccup here must cost the haggle, never the customer's setup answer. A held link that no longer
 * resolves (sold out, taken down) is discarded and the welcome goes out — and a product that
 * became fixed-price gets the fixed-price offer, the hand-off discarded so the next message is not
 * routed to a bargainer with nothing to haggle.
 */
export async function replyForHeldBargain(
    conversation: { owner: string; channel: MessagingChannel; externalId: string },
    language: string | null,
): Promise<BotReplyIntent | null> {
    try {
        const held = await pendingBargainStore.peek(conversation.channel, conversation.externalId, conversation.owner);
        if (!held) return null;

        let verdict: BargainEntryVerdict;
        try {
            verdict = await resolveBargainEntry({ productId: held.productId, variantId: held.variantId });
        } catch {
            await pendingBargainStore.discard(conversation.channel, conversation.externalId);
            return null;
        }

        if (verdict.kind === 'fixed') {
            await pendingBargainStore.discard(conversation.channel, conversation.externalId);
            return fixedPriceIntent(verdict, language);
        }
        return bargainInviteIntent(verdict.productTitle, language);
    } catch (error) {
        console.warn('[BotSurface] could not read a held Bargain link at setup completion', error);
        return null;
    }
}

/**
 * Arrival 3 — a Telegram chat with no account yet opened the Bargain link.
 *
 * The identity guard refuses `/command` for that sender (`BOT_IDENTITY_NEEDS_CONTACT`, which
 * renders the contact-share button — the right first turn), so no handler runs. This keeps the
 * product through the refusal, with no owner, for the first account the conversation resolves to.
 *
 * Only a link that resolves to a live haggle is kept; anything else is dropped here, and the
 * customer simply gets the welcome when setup finishes. Never throws — it runs on a refusal path.
 */
export async function holdForUnregisteredSender(
    conversation: { channel: MessagingChannel; externalId: string },
    ids: BargainEntryIds,
): Promise<boolean> {
    try {
        const verdict = await resolveBargainEntry(ids);
        if (verdict.kind !== 'bargain') return false;
        await pendingBargainStore.record(
            { owner: null, channel: conversation.channel, externalId: conversation.externalId },
            { productId: verdict.productId, variantId: verdict.variantId },
        );
        return true;
    } catch (error) {
        console.warn('[BotSurface] could not hold a Bargain link for an unregistered sender', error);
        return false;
    }
}
