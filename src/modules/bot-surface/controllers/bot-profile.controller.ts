import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { GeoCandidate } from '../../../core/geocoding';
import { CustomerProfileService } from '../../customers/services/customer-profile.service';
import {
    AddCustomerAddressInput,
    UpdateCustomerAddressInput,
} from '../../customers/validators/customer-onboarding.validator';
import { SUPPORTED_LANGUAGES, type Language } from '../../../core/constants/languages';
import { geoCandidateStore } from '../services/geo-candidate.store';
import {
    botCallerOf,
    botResponseLanguageOf,
    setBotResponseLanguage,
} from '../middlewares/bot-identity.middleware';
import { setBotReply } from '../middlewares/bot-reply.middleware';
import { botChrome } from '../domain/bot-chrome-copy';
import { languageActionId } from '../domain/bot-action-id';
import { unknownBotAction, type ParsedBotAction } from '../domain/bot-action-dispatch';
import { toBotAddressList, toBotProfileSummary } from '../dto/bot-projections';
import {
    parseSavedItemAction,
    setSavedItemReply,
    setSavedListReply,
    type SavedListRow,
} from '../domain/bot-saved-list-reply';
import { botStorefrontLink, surfacePath, windowForChat } from '../domain/bot-list-window';
import {
    BotAddAddressSchema,
    BotAddressParamSchema,
    BotAddressUpdateSchema,
    BotNoArgsSchema,
    BotProfileUpdateSchema,
    BotSetLanguageSchema,
} from '../validators/bot.validators';

const customerProfileService = new CustomerProfileService();

export class BotProfileController {
    /**
     * `POST /profile` — the sender's own profile, masked.
     *
     * See `toBotProfileSummary` for what differs from `GET /api/customer/profile` and why:
     * a chat window is shared, screenshotted and shoulder-surfed, and the customer already
     * knows their own number.
     */
    static getSummary = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const profile = await customerProfileService.getProfile(botCallerOf(req).customerId);
        sendSuccess(res, toBotProfileSummary(profile));
    });

    /**
     * `PATCH /profile/language` — the language every later notification is written in.
     *
     * ⚠ Narrower than the customer API, which validates `preferences.language` as any
     * BCP-47 string of 2–10 characters. Five languages have catalogue copy written for
     * them; a sixth would produce a profile every notification consumer falls back from
     * silently. The service merges rather than replaces `preferences`, so the currency and
     * the marketing opt-in survive.
     */
    static setLanguage = asyncHandler(async (req: Request, res: Response) => {
        const { language } = BotSetLanguageSchema.parse(req.body ?? {});
        const profile = await customerProfileService.updateProfile(botCallerOf(req).customerId, {
            preferences: { language },
        });
        sendSuccess(res, { preferences: { language: profile.preferences.language } });
    });

    /**
     * `PATCH /profile` — the one profile field a chat may write.
     *
     * See `BotProfileUpdateSchema` for why the other six the customer API accepts are
     * refused here. Answers the same masked summary `profile_get_summary` does, so a caller
     * needs one shape for both and cannot end up rendering a stale name it just changed.
     */
    static update = asyncHandler(async (req: Request, res: Response) => {
        const { name } = BotProfileUpdateSchema.parse(req.body ?? {});
        const profile = await customerProfileService.updateProfile(botCallerOf(req).customerId, {
            name,
        });
        sendSuccess(res, toBotProfileSummary(profile));
    });

    /** `POST /addresses/list` — saved addresses, each with its `deliverable` verdict. */
    static listAddresses = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const profile = await customerProfileService.getProfile(botCallerOf(req).customerId);

        /**
         * ⚠ **Unpaginated, like the digital library — the slice is the cap.**
         *
         * ⚠ **The default address is pinned to the front, and that is a correctness fix
         * rather than a nicety.** `toBotAddressList` is a plain `map` in stored order, so
         * capping the list at five could drop the customer's DEFAULT address — the one a
         * chat answer is most likely to be about, and the one checkout falls back to. A
         * truncation that hides the most important row is worse than no truncation.
         *
         * `sort` is stable in every runtime this targets, so everything else keeps its
         * stored order and only the default moves.
         */
        const ordered = [...toBotAddressList(profile.savedAddresses)]
            .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

        const chat = windowForChat({
            items: ordered,
            total: ordered.length,
            surface: 'addresses',
            language: botResponseLanguageOf(req),
        });

        sendSuccess(res, chat.items, { meta: { ...chat.window } });
    });

    /**
     * `POST /addresses` — save an address from a candidate handle.
     *
     * ⚠ **There is no way to send coordinates**, and that is the whole of GAP-005. The
     * handle is spent here; a retry finds it gone and answers
     * `400 BOT_GEO_CANDIDATE_EXPIRED`, which is what makes saving an address idempotent
     * without an idempotency record having to be consulted.
     *
     * The handle is spent BEFORE the write, deliberately. Spending it afterwards would
     * leave a window in which two concurrent saves both hold a live handle and both write
     * an address; spending first means the loser is told to search again, having written
     * nothing. The cost of the other ordering — a spent handle whose write then failed —
     * is one repeated search, which is the same thing the customer does anyway.
     */
    static addAddress = asyncHandler(async (req: Request, res: Response) => {
        const input = BotAddAddressSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const stored = await geoCandidateStore.consume(caller.userId, input.geoCandidateRef);
        if (!stored) {
            throw createAppError(ERROR_CODES.BOT_GEO_CANDIDATE_EXPIRED, 400, undefined, {
                candidateRef: input.geoCandidateRef,
            });
        }

        const profile = await customerProfileService.addAddress(
            caller.customerId,
            toSavedAddressInput({
                label: input.label,
                addressLine2: input.addressLine2 ?? null,
                isDefault: input.isDefault,
                candidate: stored.candidate,
                rawInput: stored.rawInput,
            }),
        );

        // The address that was just written is the newest one, and `addAddress` pushes.
        const addresses = toBotAddressList(profile.savedAddresses);
        sendSuccess(res, addresses[addresses.length - 1], { status: 201 });
    });

    /**
     * `PATCH /addresses/:addressId` — rename, re-describe, or re-point a saved address.
     *
     * ⚠ **Re-pointing goes through a candidate handle, never a `geo` object**, so this
     * route writes a `geo` by exactly the path `addAddress` does — `toSavedAddressInput`,
     * which writes no `location` key at all. That is what keeps the 2dsphere trap closed on
     * a second write path; see `BotAddressUpdateSchema` and the helper's own header.
     *
     * ⚠ **The handle is spent BEFORE the write**, same ordering and same reasoning as the
     * add: two concurrent edits both holding a live handle would both write, where spending
     * first means the loser is told to search again having changed nothing.
     *
     * A re-point rewrites the derived loose fields (`address_line1`, `city`, `state`,
     * `country`) alongside `geo`, because leaving them describing the OLD place is how an
     * address ends up printing one street on a label and routing to another.
     */
    static updateAddress = asyncHandler(async (req: Request, res: Response) => {
        const { addressId } = BotAddressParamSchema.parse(req.params);
        const input = BotAddressUpdateSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        const updates: UpdateCustomerAddressInput = {};
        if (input.label !== undefined) updates.label = input.label;
        // `null` clears the line, `undefined` leaves it alone — the clearable convention.
        if (input.addressLine2 !== undefined) updates.address_line2 = input.addressLine2;

        if (input.geoCandidateRef !== undefined) {
            const stored = await geoCandidateStore.consume(caller.userId, input.geoCandidateRef);
            if (!stored) {
                throw createAppError(ERROR_CODES.BOT_GEO_CANDIDATE_EXPIRED, 400, undefined, {
                    candidateRef: input.geoCandidateRef,
                });
            }

            const rebuilt = toSavedAddressInput({
                // `label` is required by the add's input shape but is not what a re-point
                // changes; the caller's own label wins, and the stored one stands otherwise.
                label: input.label ?? 'Address',
                addressLine2: input.addressLine2 ?? null,
                isDefault: false,
                candidate: stored.candidate,
                rawInput: stored.rawInput,
            });

            updates.address_line1 = rebuilt.address_line1;
            updates.city = rebuilt.city;
            updates.state = rebuilt.state;
            updates.country = rebuilt.country;
            updates.geo = rebuilt.geo;
        }

        const profile = await customerProfileService.updateAddress(
            caller.customerId,
            addressId,
            updates,
        );

        const updated = toBotAddressList(profile.savedAddresses).find((a) => a.id === addressId);
        sendSuccess(res, updated ?? null);
    });

    /**
     * `DELETE /addresses/:addressId` — forget a saved address.
     *
     * ⚠ **Removing the DEFAULT address leaves the customer without one**, and this route
     * does not elect a replacement. That is the customer API's behaviour and it stays: the
     * platform picking which of the remaining addresses a parcel goes to is a worse failure
     * than checkout asking. `addresses_list` reports the state, and `addresses_set_default`
     * is how a customer fixes it.
     */
    static removeAddress = asyncHandler(async (req: Request, res: Response) => {
        const { addressId } = BotAddressParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const profile = await customerProfileService.removeAddress(
            botCallerOf(req).customerId,
            addressId,
        );
        sendSuccess(res, {
            removed: true,
            remaining: profile.savedAddresses.length,
            // Stated rather than left to be inferred from a list the caller may not re-read.
            hasDefault: profile.savedAddresses.some((a) => a.is_default === true),
        }, { message: 'Address removed.' });
    });

    /**
     * `PATCH /addresses/:addressId/default` — make one the default.
     *
     * Returns the whole list rather than the one address, matching the catalogue: setting
     * a default CLEARS the flag on every sibling, so answering with one row would leave the
     * caller holding a list it now knows to be stale.
     */
    static setDefaultAddress = asyncHandler(async (req: Request, res: Response) => {
        const { addressId } = BotAddressParamSchema.parse(req.params);
        BotNoArgsSchema.parse(req.body ?? {});
        const profile = await customerProfileService.setDefaultAddress(
            botCallerOf(req).customerId,
            addressId,
        );
        sendSuccess(res, toBotAddressList(profile.savedAddresses));
    });
}

/**
 * A geocoding candidate, as the saved-address schema wants it.
 *
 * ── THE LOOSE FIELDS ARE DERIVED, AND THAT IS THE PLATFORM'S OWN POSITION ───
 * `geo` is the canonical geospatial address; `address_line1`, `city`, `state` and
 * `country` are the legacy loose fields kept populated for backward compatibility
 * ("adoption is additive" — `geo-address.types.ts`). A browser fills them from the form
 * the person typed into. A chat has no form, so they are derived from the candidate the
 * person chose — best-effort, and never in a way that can produce an empty required field.
 *
 * ⚠ **`location` is not written at all**, not even as null. A null inside the
 * 2dsphere-indexed `saved_addresses` array beside a real point on another address refuses
 * EVERY subsequent write to that customer document — measured, and the reason
 * `dropNullLocation` exists. The rule at every write boundary is: a point we do not have
 * is a key we do not write, and here we deliberately have none to write.
 *
 * `country` is left undefined rather than guessed when the provider returns no country
 * code, so the schema's own `'CM'` default applies — one place decides the platform's
 * geographic bias, and it is not this function.
 */
function toSavedAddressInput(input: {
    label: string;
    addressLine2: string | null;
    isDefault: boolean;
    candidate: GeoCandidate;
    rawInput: string | null;
}): AddCustomerAddressInput {
    const c = input.candidate.components;

    return {
        label: input.label,
        // The street when the provider resolved one; the canonical one-line address
        // otherwise — never empty, which the schema requires and a chat cannot guarantee.
        address_line1: clamp(c.street ?? input.candidate.formatted_address, 200),
        address_line2: input.addressLine2,
        // Ladder rather than a single field: rural Cameroonian results frequently carry a
        // neighbourhood or a region and no city, and `city` is required.
        city: clamp(c.city ?? c.neighbourhood ?? c.region ?? c.country ?? input.candidate.formatted_address, 100),
        state: c.region ? clamp(c.region, 100) : null,
        country: c.country_code ?? undefined,
        is_default: input.isDefault,
        geo: {
            formatted_address: input.candidate.formatted_address,
            coordinates: input.candidate.coordinates,
            provider: input.candidate.provider,
            provider_place_id: input.candidate.provider_place_id,
            components: c,
            // What the customer typed before choosing, which is what makes a bad match
            // debuggable later. Null on a reverse lookup, where they typed nothing.
            raw_input: input.rawInput,
        },
    } as AddCustomerAddressInput;
}

function clamp(value: string, max: number): string {
    const trimmed = value.trim();
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Exported for `test:bot-surface`, which drives it against real provider candidates. */
export { toSavedAddressInput as __toSavedAddressInput };

// ─────────────────────────────────────────────────────────────────────────────
// Language, as a tap — `acct:lang` asks, `lang:<code>` answers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each language, written in itself.
 *
 * ⚠ **NOT copy, and it must never become copy.** These are endonyms: the French option says
 * *Français* to an Arabic speaker and to an English one, because the person who needs it is
 * precisely the person who cannot read the current language. A copy key would give five
 * translations of five names — twenty-five strings, twenty of them wrong to show anybody — and
 * would let a translator turn *Português* into *Portuguese*, which is the one word a Portuguese
 * speaker scanning the list is not looking for.
 *
 * Derived from `SUPPORTED_LANGUAGES` by a lookup rather than by a parallel array, so a sixth
 * language is a compile error here instead of a silently missing row.
 */
const LANGUAGE_ENDONYM: Readonly<Record<Language, string>> = Object.freeze({
    en: 'English',
    fr: 'Français',
    pt: 'Português',
    es: 'Español',
    ar: 'العربية',
});

/** `acct:lang` — which language should I use? */
export async function languageChoiceTap(req: Request, res: Response): Promise<void> {
    botCallerOf(req);
    const language = botResponseLanguageOf(req);

    setBotReply(req, {
        kind: 'choice',
        text: botChrome('languagePrompt', language),
        options: SUPPORTED_LANGUAGES.map((code) => ({
            id: languageActionId(code),
            label: LANGUAGE_ENDONYM[code],
        })),
        listButton: botChrome('chooseListButton', language),
        sectionTitle: botChrome('chooseSectionTitle', language),
    });
    sendSuccess(res, { languages: SUPPORTED_LANGUAGES });
}

/**
 * `lang:<code>` — set it.
 *
 * ⚠ **The confirmation is written in the language just CHOSEN, not the one in force.**
 * `botResponseLanguageOf` returns what the identity middleware stamped when the request
 * arrived, which is the language being left behind — answering in it would tell a customer
 * who has just switched to Arabic, in French, that they will be written to in Arabic.
 *
 * `setBotResponseLanguage` moves the request's own stamp too, so an error raised after this
 * point in the same request is also answered in the new language.
 */
export async function setLanguageTap(req: Request, res: Response, action: ParsedBotAction): Promise<void> {
    const caller = botCallerOf(req);

    const language = action.argument;
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(language)) throw unknownBotAction();

    const profile = await customerProfileService.updateProfile(caller.customerId, {
        preferences: { language },
    });

    setBotResponseLanguage(req, language);
    setBotReply(req, { kind: 'text', text: botChrome('languageSet', language) });
    sendSuccess(res, { preferences: { language: profile.preferences.language } });
}

// ─────────────────────────────────────────────────────────────────────────────
// `acct:addr:…` — the address book
// ─────────────────────────────────────────────────────────────────────────────

/** The saved addresses, default first, projected for the shared list shape. */
async function addressRows(customerId: string): Promise<SavedListRow[]> {
    const profile = await customerProfileService.getProfile(customerId);
    const rows = toBotAddressList(profile.savedAddresses).map((a) => ({
        id: a.id,
        title: a.label,
        detail: a.formattedAddress,
        isDefault: a.isDefault,
    }));

    return [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/**
 * `acct:addr` · `acct:addr:<id>` · `acct:addr:<id>:def|rm`.
 *
 * ⚠ **Every branch re-reads the list, and a row that is no longer there is answered with the
 * CURRENT list rather than with an error.** A chat keeps its buttons for ever: the Remove under
 * an address deleted from the storefront last week is still tappable, and the honest answer to
 * it is what the customer has now. The same rule the stale Skip taught in onboarding, and the
 * reason neither `removeAddress` nor `setDefaultAddress` is reached with an id that has gone —
 * both would throw a 404 at somebody who pressed a button we drew.
 */
export async function addressSection(req: Request, res: Response, rest: string): Promise<void> {
    const caller = botCallerOf(req);
    const language = botResponseLanguageOf(req);
    const rows = await addressRows(caller.customerId);

    if (rest === '') {
        /**
         * ⚠ **An empty book goes STRAIGHT to the link**, rather than drawing an empty list or
         * saying nothing. Until the owner's ruling there was no control to offer here, so this
         * answered with data and let the model word it; now there is exactly one useful thing a
         * customer with no addresses can do, and it is one tap rather than two.
         */
        if (rows.length === 0) {
            await addressSection(req, res, 'new');
            return;
        }

        /**
         * ⚠ **The Add row is LAST, after the addresses themselves.** A list is read top down and
         * the rows the customer came for are their own; an action ahead of them would be the
         * first thing tapped by someone scanning quickly. WhatsApp caps a list at ten rows and
         * the chat window caps addresses below that, so the row cannot be pushed off the end.
         */
        setSavedListReply(req, language, 'addr', 'addressBookPrompt', [
            ...rows,
            {
                id: 'new',
                title: botChrome('addAddressButton', language),
                isDefault: false,
                mayBeDefault: false,
            },
        ]);
        sendSuccess(res, rows);
        return;
    }

    /**
     * `acct:addr:new` — adding an address happens on the WEBSITE (owner's ruling, 2026-09-20).
     *
     * ── WHY A LINK AND NOT A FLOW ───────────────────────────────────────────
     * Saving an address needs a geocoded candidate, which needs a search, which needs typed
     * text and a picker — a multi-turn flow this surface deliberately does not own. The owner
     * chose the link over the feature, knowing it pushes somebody out of the conversation.
     *
     * ⚠ **It is a LINK THAT WORKS, never a button that apologises.** A control tapped only to
     * be told "not available here" spends the customer's patience to deliver nothing; that is
     * the shape this round has been removing, not adding.
     *
     * ⚠ The path comes from `surfacePath('addresses')`, never a literal — `verify:landing-routes`
     * checks that table against the storefront's own routes, and a typed path is invisible to it.
     */
    if (rest === 'new') {
        const url = botStorefrontLink(surfacePath('addresses'), language);
        if (url) {
            setBotReply(req, {
                kind: 'link',
                text: botChrome('addressBookPrompt', language),
                label: botChrome('addAddressButton', language),
                url,
            });
        }
        sendSuccess(res, { section: 'addr', add: 'storefront', url });
        return;
    }

    const parsed = parseSavedItemAction(rest);
    if (!parsed) throw unknownBotAction();

    const row = rows.find((r) => r.id === parsed.id);
    if (!row) {
        // Gone since the button was drawn. Answer with what there is now, never a 404.
        if (rows.length > 0) setSavedListReply(req, language, 'addr', 'addressBookPrompt', rows);
        sendSuccess(res, rows);
        return;
    }

    if (parsed.op === null) {
        setSavedItemReply(req, language, 'addr', row);
        sendSuccess(res, row);
        return;
    }

    if (parsed.op === 'def') {
        const profile = await customerProfileService.setDefaultAddress(caller.customerId, row.id);
        setBotReply(req, { kind: 'text', text: botChrome('defaultSet', language) });
        sendSuccess(res, toBotAddressList(profile.savedAddresses));
        return;
    }

    const profile = await customerProfileService.removeAddress(caller.customerId, row.id);
    setBotReply(req, { kind: 'text', text: botChrome('itemRemoved', language) });
    sendSuccess(res, {
        removed: true,
        remaining: profile.savedAddresses.length,
        hasDefault: profile.savedAddresses.some((a) => a.is_default === true),
    });
}
