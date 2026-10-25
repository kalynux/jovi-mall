import { z } from 'zod';

/**
 * Bodies and queries of the damage-claim routes (owner F-8, 2026-10-22) and of the "why was my
 * money taken" lists. `.strict()`: on a surface that moves money an unknown key is a 400.
 */

const objectId = z.string().trim().regex(/^[a-f\d]{24}$/i, 'Not a valid id');
const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

/** `POST /api/internal/admin/agency-claims` */
export const CreateAgencyClaimBodySchema = z
  .object({
    shipmentId: objectId,
    /** How many items were damaged in delivery. */
    itemCount: z.number().int().min(1).max(1000),
    /** What is claimed for the damage, whole currency units; ≤ the agency's max refund per item × itemCount. */
    amount: z.number().int().positive(),
    /** Why — what was damaged and how it was established. Read by the next administrator. */
    note: z.string().trim().min(3).max(1000),
    /** The refund this claim follows, when there is one (its opening date can start the window). */
    refundRequestId: objectId.optional(),
  })
  .strict();

/** `GET /api/internal/admin/agency-claims/eligibility` */
export const AgencyClaimEligibilityQuerySchema = z
  .object({ shipmentId: objectId, refundRequestId: objectId.optional() })
  .strict();

/** `GET /api/internal/admin/agency-claims` */
export const ListAgencyClaimsQuerySchema = z
  .object({
    agencyId: objectId.optional(),
    vendorId: objectId.optional(),
    shipmentId: objectId.optional(),
    ...paginationFields,
  })
  .strict();

export const AgencyClaimIdParamSchema = z.object({ id: objectId }).strict();

/** The party lists: `GET /api/{vendor,agency,agent}/earnings/adjustments`, `…/claims`. */
export const PartyListQuerySchema = z.object({ ...paginationFields }).strict();

export type CreateAgencyClaimBody = z.infer<typeof CreateAgencyClaimBodySchema>;
