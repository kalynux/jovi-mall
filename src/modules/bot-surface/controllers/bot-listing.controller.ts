import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { publicListingService } from '../../listings/domain/services/public-listing.service';
import { listingRevealService } from '../../listings/domain/services/listing-reveal.service';
import { providerConsentService } from '../../listings/domain/services/listing-consent.service';
import { listingRepository } from '../../listings/repositories/listing.repository';
import { listingLeadRepository } from '../../listings/repositories/listing-lead.repository';
import { wishlistService } from '../../customers/services/wishlist.service';
import { botChrome } from '../domain/bot-chrome-copy';
import { botCallerOf, botResponseLanguageOf } from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { ParsedBotAction, unknownBotAction, type BotActionHandlers } from '../domain/bot-action-dispatch';
import {
    parseListingConsentArgument,
    parseListingRevealArgument,
    parseListingShowArgument,
    type ListingFieldName,
} from '../domain/bot-action-id';
import {
    consentAnsweredIntent,
    listingCardIntent,
    listingCardsIntent,
    revealReplyIntent,
    type RevealedValue,
} from '../domain/bot-listing-reply';
import {
    BotListingConsentSchema,
    BotListingDisplaySchema,
    BotListingParamSchema,
    BotListingRevealSchema,
    BotNoArgsSchema,
} from '../validators/bot.validators';

/**
 * Service listings on the customer bot (SERVICE-LISTINGS-PLAN § C-3 "Bot", § C-3a):
 *
 *   listings_display   POST /listings/display              cards, model-facing, charges nothing
 *   listings_get       POST /listings/:listingId           one card, model-facing, charges nothing
 *   listings_reveal    POST /listings/:listingId/reveal    the `lr:` tap — CHARGES THE PROVIDER
 *   listings_consent   POST /listings/consent              the `lc:` tap
 *
 * ⛔ **The two writes are never model-facing.** The model may SHOW a card; only the customer's
 * tap spends a provider's credits (stated defaults). That is why the reveal and the consent are
 * also reachable as tap tokens through `/actions/dispatch` (`LISTING_ACTION_HANDLERS`) — the
 * path a button takes — and why the n8n catalogue marks both `model_facing: false`.
 *
 * The reveal itself is `ListingRevealService`'s, with the CALLER's chat as the lead's channel,
 * so a provider's later message goes back where the customer unlocked their contact.
 */

async function showCards(req: Request, res: Response, listingIds: string[]): Promise<void> {
    const language = botResponseLanguageOf(req);
    const { data, missing } = await publicListingService.byIds(listingIds);
    if (data.length === 0) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
    setBotReply(req, listingCardsIntent(data.map((c) => ({ ...c, description: null })), language));
    sendSuccess(res, { listings: data, missing });
}

async function showOne(req: Request, res: Response, listingId: string): Promise<void> {
    const language = botResponseLanguageOf(req);
    const { data } = await publicListingService.byIds([listingId]);
    const card = data[0];
    if (!card) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
    const detail = await publicListingService.bySlug(card.slug);
    setBotReply(req, listingCardIntent({ ...card, description: detail.description }, language));
    sendSuccess(res, { listing: detail });
}

async function reveal(req: Request, res: Response, listingId: string, field: ListingFieldName): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const outcome = await listingRevealService.reveal({
        customerId: caller.customerId,
        userId: caller.userId,
        listingId,
        field,
        channel: caller.channel,
    });

    const [listing, lead] = await Promise.all([
        listingRepository.findById(listingId),
        listingLeadRepository.findCurrent(caller.customerId, listingId, new Date()),
    ]);
    const askConsent = outcome.openedLead ? await providerConsentService.askOnce(caller.customerId, outcome.vendorId) : false;
    const businessName = listing?.published?.company_name ?? '';

    setBotReply(req, revealReplyIntent({
        listingId,
        vendorId: outcome.vendorId,
        businessName,
        field,
        value: outcome.result.value as RevealedValue,
        hasVideo: (listing?.available_fields ?? []).includes('video'),
        videoAlreadyRevealed: (lead?.fields_revealed ?? []).includes('video'),
        askConsent,
    }, language));
    sendSuccess(res, { ...outcome.result, askConsent });
}

async function answerConsent(req: Request, res: Response, vendorId: string, granted: boolean): Promise<void> {
    const caller = botCallerOf(req);
    const view = await providerConsentService.set(caller.customerId, vendorId, granted, 'bot');
    setBotReply(req, consentAnsweredIntent(view.businessName ?? '', view.granted, botResponseLanguageOf(req)));
    sendSuccess(res, view);
}

export class BotListingController {
    /** `listings_display` — `{ listingIds }` in the order the search returned them. */
    static display = asyncHandler(async (req: Request, res: Response) => {
        const { listingIds } = BotListingDisplaySchema.parse(req.body ?? {});
        await showCards(req, res, listingIds);
    });

    /** `listings_get` — one card, with its description. */
    static get = asyncHandler(async (req: Request, res: Response) => {
        const { listingId } = BotListingParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        await showOne(req, res, listingId);
    });

    /** `listings_reveal` — `{ field }`. The `lr:` tap; never model-facing. */
    static reveal = asyncHandler(async (req: Request, res: Response) => {
        const { listingId } = BotListingParamSchema.parse(req.params);
        const { field } = BotListingRevealSchema.parse(req.body ?? {});
        await reveal(req, res, listingId, field);
    });

    /** `listings_consent` — `{ vendorId, granted }`. The `lc:` tap; never model-facing. */
    static consent = asyncHandler(async (req: Request, res: Response) => {
        const { vendorId, granted } = BotListingConsentSchema.parse(req.body ?? {});
        await answerConsent(req, res, vendorId, granted);
    });
}

/** `ls:` · `lr:` · `lc:` (§ C-3a) · `lv:` (saved listings). Malformed arguments are the one unknown-token refusal. */
export const LISTING_ACTION_HANDLERS: BotActionHandlers = Object.freeze({
    ls: async (req: Request, res: Response, action: ParsedBotAction) => {
        const listingId = parseListingShowArgument(action.argument);
        if (!listingId) throw unknownBotAction();
        await showOne(req, res, listingId);
    },
    lr: async (req: Request, res: Response, action: ParsedBotAction) => {
        const parsed = parseListingRevealArgument(action.argument);
        if (!parsed) throw unknownBotAction();
        await reveal(req, res, parsed.listingId, parsed.field);
    },
    lc: async (req: Request, res: Response, action: ParsedBotAction) => {
        const parsed = parseListingConsentArgument(action.argument);
        if (!parsed) throw unknownBotAction();
        await answerConsent(req, res, parsed.vendorId, parsed.granted);
    },
    /**
     * `lv:<listingId>` — the card's "Save" row (2026-11-08). Saves and says so; reveals nothing,
     * charges nothing, tells the provider nothing (RS-2). A double tap answers the same sentence.
     */
    lv: async (req: Request, res: Response, action: ParsedBotAction) => {
        const listingId = parseListingShowArgument(action.argument);
        if (!listingId) throw unknownBotAction();
        await wishlistService.addListing(botCallerOf(req).customerId, listingId);
        setBotReply(req, { kind: 'text', text: botChrome('savedForLaterPrompt', botResponseLanguageOf(req)) });
        sendSuccess(res, { saved: true, listingId });
    },
});
