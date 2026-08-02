import { z } from 'zod';
import { AGENT_CANCELLATION_REASONS, AgentCancellationReason } from '../../shipments/shipment.model';

/**
 * Agent cancels a shipment mid-delivery (STEP 10). A fixed reason enum plus an
 * optional free-text note capped at 200 characters — required when the reason is
 * `other` so a catch-all cancellation is never left unexplained.
 */
export const CancelShipmentSchema = z
  .object({
    reason: z.enum(AGENT_CANCELLATION_REASONS as [AgentCancellationReason, ...AgentCancellationReason[]]),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.reason !== 'other' || (v.note && v.note.length > 0), {
    message: 'A note is required when the cancellation reason is "other"',
    path: ['note'],
  });
export type CancelShipmentInput = z.infer<typeof CancelShipmentSchema>;

/** List an agent's offers. */
export const ListOffersQuerySchema = z.object({
  status: z
    .enum(['pending', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded'])
    .optional(),
  /**
   * Free-text search over the same fields as the shipment list — customer
   * name/phone, product titles, order number, tracking number — resolved to the
   * shipments those match and then to the offers on them. Minimum 2 characters;
   * see ShipmentRepository.buildSearchClause.
   */
  q: z.string().trim().min(2, 'Search term must be at least 2 characters').max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListOffersQuery = z.infer<typeof ListOffersQuerySchema>;

/** Agent declines an offer. Reason is optional free text (kept short). */
export const RejectOfferSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type RejectOfferInput = z.infer<typeof RejectOfferSchema>;

/** Agency toggles auto-assignment participation. */
export const UpdateAssignmentSettingsSchema = z.object({
  autoAssignEnabled: z.boolean(),
});
export type UpdateAssignmentSettingsInput = z.infer<typeof UpdateAssignmentSettingsSchema>;

/** Manual pick — an agency offers a specific agent. Mirrors AssignAgentSchema. */
export const OfferAgentSchema = z.object({
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agent ID'),
});
export type OfferAgentInput = z.infer<typeof OfferAgentSchema>;

/**
 * The agency's manual override of the automatic pickup location (Part 3). A
 * coordinate (both lat AND lng) and/or an address is enough; all fields optional.
 */
export const ReassignPickupLocationSchema = z
  .object({
    label: z.string().trim().max(200).optional(),
    addressLine1: z.string().trim().max(200).optional(),
    addressLine2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    country: z.string().trim().max(120).optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    note: z.string().trim().max(500).optional(),
  })
  // A coordinate needs both halves — a lone lat or lng is meaningless.
  .refine((v) => (v.latitude == null) === (v.longitude == null), {
    message: 'latitude and longitude must be provided together',
    path: ['latitude'],
  });

/**
 * Reassign a shipment to a different agent. `agentId` is the replacement:
 * REQUIRED past pickup (no auto-reassignment of an in-flight/returned parcel),
 * OPTIONAL pre-pickup (omit to auto-assign the best candidate). `reason` is
 * mandatory — reassignment is a critical action and the why is part of the audit
 * trail. `pickupLocation` optionally overrides the automatic handover point.
 */
export const ReassignShipmentSchema = z.object({
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agent ID').optional(),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
  pickupLocation: ReassignPickupLocationSchema.optional(),
});
export type ReassignShipmentInput = z.infer<typeof ReassignShipmentSchema>;
