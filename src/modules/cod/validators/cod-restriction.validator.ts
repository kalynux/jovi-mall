import { z } from 'zod';
import { COD_RESTRICTION_REASON_MAX, COD_RESTRICTION_REASON_MIN } from '../domain/cod-restriction';

/**
 * Restrict (`restricted: true`) or lift (`false`) cash on delivery for one customer or one
 * delivery agency — owner decision 2026-10-10. One body for both subjects and both
 * directions, like the agency cash-limit pin's `maxAmount: number | null`.
 *
 * A reason is required BOTH ways: the restriction changes what a person or a business may
 * do with no automatic rule behind it, and lifting clears the field — so the reason given
 * on a lift survives only in wi-admin's audit row, which is where a reviewer will look.
 *
 * `.strict()`: the subject is the path, never the body.
 */
export const AdminSetCodRestrictionSchema = z
  .object({
    restricted: z.boolean(),
    reason: z.string().trim().min(COD_RESTRICTION_REASON_MIN).max(COD_RESTRICTION_REASON_MAX),
  })
  .strict();

export type AdminSetCodRestrictionInput = z.infer<typeof AdminSetCodRestrictionSchema>;
