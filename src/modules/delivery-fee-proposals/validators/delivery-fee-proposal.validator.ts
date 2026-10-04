import { z } from 'zod';
import { DELIVERY_FEE_PROPOSAL_STATUSES } from '../models/delivery-fee-proposal.model';

const objectId = (label: string) => z.string().regex(/^[0-9a-fA-F]{24}$/, `Invalid ${label}`);

/** POST …/delivery-fee-proposals — the new fee is an integer ≥ 0 in minor units. */
export const CreateDeliveryFeeProposalSchema = z
  .object({
    proposedFee: z.number().int('proposedFee must be an integer (minor units)').min(0),
    reason: z.string().trim().min(3, 'Explain why the fee should change').max(500),
  })
  .strict();

/**
 * PATCH …/delivery-fee-proposals/:proposalId — fee and/or reason (at least one). `version`
 * is optional here: when sent it must be the current one (409 VERSION_MISMATCH otherwise).
 */
export const EditDeliveryFeeProposalSchema = z
  .object({
    proposedFee: z.number().int('proposedFee must be an integer (minor units)').min(0).optional(),
    reason: z.string().trim().min(3, 'Explain why the fee should change').max(500).optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => v.proposedFee !== undefined || v.reason !== undefined, {
    message: 'Send proposedFee and/or reason',
  });

/**
 * The version the vendor SAW. REQUIRED on approve and reject — a vendor must never answer a
 * figure they were not shown (an edit bumps it).
 */
const SeenVersion = z.number().int().min(1);

export const ApproveDeliveryFeeProposalSchema = z.object({ version: SeenVersion }).strict();

export const RejectDeliveryFeeProposalSchema = z
  .object({
    note: z.string().trim().max(500).nullish(),
    version: SeenVersion,
  })
  .strict();

export const ShipmentProposalParamsSchema = z.object({
  id: objectId('shipment ID'),
  proposalId: objectId('proposal ID').optional(),
});

export const OrderProposalParamsSchema = z.object({
  id: objectId('order ID'),
  proposalId: objectId('proposal ID').optional(),
});

export const VendorProposalQuerySchema = z.object({
  status: z.enum(DELIVERY_FEE_PROPOSAL_STATUSES as [string, ...string[]]).optional(),
  orderId: objectId('order ID').optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ── ADR-A11 — customer-paid fee changes, the change-agency cover, combined requests ──────────

/** POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/approve — the seen version. */
export const CustomerApproveDeliveryFeeProposalSchema = ApproveDeliveryFeeProposalSchema;

/** POST …/reject — the seen version, and an optional note for the delivery company. */
export const CustomerRejectDeliveryFeeProposalSchema = RejectDeliveryFeeProposalSchema;

/**
 * POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/pay — the top-up charge.
 * The same shape every charging door takes (ADR-A08): the customer names a PROVIDER; the server
 * picks the aggregator. Re-exported from the payments validators so the rules cannot fork.
 */
export { InitiateBookingPaymentRequestSchema as PayDeliveryTopupSchema } from '../../payments/validators/payment.validators';

/** POST /api/customer/orders/groups/:cartId/combined-delivery-requests */
export const CreateCombinedDeliveryRequestSchema = z
  .object({
    agencyId: objectId('agency ID'),
    /** Omit to ask about every eligible parcel this agency carries on the checkout. */
    shipmentIds: z.array(objectId('shipment ID')).min(2).max(20).optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

export const CartCombinedParamsSchema = z.object({
  cartId: objectId('checkout ID'),
  requestId: objectId('request ID').optional(),
});

/** POST /api/agency/combined-delivery-requests/:requestId/respond — lower fees, or decline. */
export const RespondCombinedDeliveryRequestSchema = z
  .object({
    fees: z
      .array(
        z
          .object({
            shipmentId: objectId('shipment ID'),
            proposedFee: z.number().int('proposedFee must be an integer (minor units)').min(0),
          })
          .strict()
      )
      .min(1)
      .max(20)
      .optional(),
    decline: z.literal(true).optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((v) => (v.fees !== undefined) !== (v.decline === true), {
    message: 'Send either fees (lower prices) or decline: true',
  });

export const CombinedRequestParamsSchema = z.object({ requestId: objectId('request ID') });

export const AgencyCombinedQuerySchema = z.object({
  status: z.enum(['open', 'answered', 'declined', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
