import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { GeoCandidate } from '../../../core/geocoding';
import { CustomerProfileService } from '../../customers/services/customer-profile.service';
import { AddCustomerAddressInput } from '../../customers/validators/customer-onboarding.validator';
import { geoCandidateStore } from '../services/geo-candidate.store';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { toBotAddressList, toBotProfileSummary } from '../dto/bot-projections';
import {
    BotAddAddressSchema,
    BotAddressParamSchema,
    BotNoArgsSchema,
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

    /** `POST /addresses/list` — saved addresses, each with its `deliverable` verdict. */
    static listAddresses = asyncHandler(async (req: Request, res: Response) => {
        BotNoArgsSchema.parse(req.body ?? {});
        const profile = await customerProfileService.getProfile(botCallerOf(req).customerId);
        sendSuccess(res, toBotAddressList(profile.savedAddresses));
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
