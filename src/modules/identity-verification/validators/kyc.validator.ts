import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';
import { GeoAddressZodSchema } from '../../../core/types/geo-address.types';
import { kycSlotParamSchema, KycDocumentSlot } from '../../../core/types/kyc-documents.types';

const ObjectIdSchema = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id');

/**
 * The typed half of a submission — the identity number and the geocoded home address.
 *
 * ⚠ **Every field is optional and none of them is validated for PRESENCE.** An empty body is
 * a legal request that changes nothing. The required/optional split belongs to the
 * administration dashboard (see `core/types/kyc-documents.types.ts`), and a `.refine` here
 * saying "at least one" would be this module's first opinion about completeness.
 *
 * Both are `clearable`: `''` or `null` removes the value, absent leaves it alone. That is the
 * platform's convention for a PATCH field and it matters here — an applicant who typed the
 * wrong identity number must be able to take it back rather than overwrite it with a space.
 */
export const UpdateKycDetailsSchema = z.object({
    /**
     * The national identity number, as printed on the card.
     *
     * No format check, deliberately. Cameroonian identity numbers have changed format at
     * least twice and a regex derived from today's cards silently refuses a valid older one —
     * at which point the applicant cannot submit and nobody can tell them why. The scans are
     * what the number is checked against, by a person.
     */
    idNumber: clearable(z.string().trim().min(1).max(64)),

    /**
     * The applicant's home, as a selected `GET /api/geo/search` result.
     *
     * The whole candidate rather than a typed string: "is this address valid" is then a
     * question the reviewer answers from `coordinates` and `provider` instead of by trusting
     * prose, which is the entire reason the dashboard can badge it.
     *
     * ⚠ `.nullable().optional()` rather than `clearable`, because the value is an OBJECT —
     * `clearable`'s preprocessor only rewrites the empty STRING, so it would pass `''`
     * straight into an object schema and produce a type error instead of a clear.
     */
    homeAddress: GeoAddressZodSchema.nullable().optional(),
});
export type UpdateKycDetailsInput = z.infer<typeof UpdateKycDetailsSchema>;

/**
 * The `:slot` path parameter, narrowed per role at the route.
 *
 * `kycSlotParamSchema` is called with the role's own slot list, so
 * `POST /api/agent/kyc/documents/store_address_sketch` is a 400 naming the slots an agent
 * has — rather than a 200 that stored nothing.
 */
export function buildKycSlotParamSchema(allowed: readonly KycDocumentSlot[]) {
    return kycSlotParamSchema(allowed);
}

/** `DELETE /kyc/documents/:slot/:fileId`. */
export function buildKycDocumentParamSchema(allowed: readonly KycDocumentSlot[]) {
    return kycSlotParamSchema(allowed).extend({ fileId: ObjectIdSchema });
}

/** `GET /kyc/documents/:fileId/content` — the applicant reading back their own upload. */
export const KycFileIdParamSchema = z.object({ fileId: ObjectIdSchema });
