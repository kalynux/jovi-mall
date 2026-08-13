import { z } from 'zod';
import { PAYOUT_OWNER_TYPES } from '../models/payout-request.model';

/**
 * Query and param schemas for the admin earnings surface.
 *
 * The owner vocabulary is `PAYOUT_OWNER_TYPES`, not `EarningsOwnerType`, on every
 * shape here — `platform` is excluded deliberately. The singleton commission account
 * has its own endpoint (`/earnings/platform`) because it answers a different question:
 * what the marketplace earned, not what it owes somebody. Letting `platform` through
 * `:ownerType` would give two routes to one account and put "what we keep" into a
 * ranking of "what we owe", where the biggest row would mean the opposite of the rest.
 */

const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const ListEarningsAccountsQuerySchema = z.object({
  ownerType: z.enum(PAYOUT_OWNER_TYPES).optional(),
  ...paginationFields,
});

export type ListEarningsAccountsQuery = z.infer<typeof ListEarningsAccountsQuerySchema>;

export const LedgerQuerySchema = z.object(paginationFields);

export const OwnerParamsSchema = z.object({
  ownerType: z.enum(PAYOUT_OWNER_TYPES),
  ownerId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Not a valid id'),
});

export type OwnerParams = z.infer<typeof OwnerParamsSchema>;
