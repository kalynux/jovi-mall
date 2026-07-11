import { z } from 'zod';

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

// Sending a request: 'counterpartyId' is an agencyId when the caller is a
// vendor, or a vendorId when the caller is an agency — resolved in the
// controller from req.auth.role.
export const RequestConnectionSchema = z.object({
  counterpartyId: z.string().regex(OBJECT_ID_REGEX, 'Invalid id'),
});
export type RequestConnectionDto = z.infer<typeof RequestConnectionSchema>;

// Free-text, optional — unlike ShipmentRejectionReason this isn't a fixed
// enum, since rejection here is a business decision, not an operational one.
export const RejectConnectionSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});
export type RejectConnectionDto = z.infer<typeof RejectConnectionSchema>;

export const TerminateConnectionSchema = z.object({
  note: z.string().trim().max(300).optional(),
});
export type TerminateConnectionDto = z.infer<typeof TerminateConnectionSchema>;

export const ListConnectionsQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'rejected', 'withdrawn', 'paused_reapproval', 'terminated']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListConnectionsQuery = z.infer<typeof ListConnectionsQuerySchema>;

// A raw 'true' string flag becomes `true`; anything else (including 'false' or
// absent) becomes undefined — matches the manual parsing convention already
// used for these same flags in vendor-profile.controller.ts's agency browse.
const trueFlag = () => z.string().optional().transform((v) => (v === 'true' ? true : undefined));

// Vendor searching agencies to request a connection with — connection-aware
// superset of AgencyListQueryParams (delivery-agency.repository.ts).
export const BrowseAgenciesQuerySchema = z.object({
  search: z.string().trim().optional(),
  region: z.string().trim().optional(),
  hq_city: z.string().trim().optional(),
  storage_based: trueFlag(),
  pickup_based: trueFlag(),
  returns_payer: z.enum(['vendor', 'agency', 'customer']).optional(),
  min_claim_deadline_days: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BrowseAgenciesQuery = z.infer<typeof BrowseAgenciesQuerySchema>;

// Agency searching vendors to request a connection with.
export const BrowseVendorsQuerySchema = z.object({
  search: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  return_eligible: trueFlag(),
  cancellable: trueFlag(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BrowseVendorsQuery = z.infer<typeof BrowseVendorsQuerySchema>;
