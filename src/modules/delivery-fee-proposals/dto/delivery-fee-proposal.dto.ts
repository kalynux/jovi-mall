import { IDeliveryFeeProposal } from '../models/delivery-fee-proposal.model';
import { IShipment } from '../../shipments/shipment.model';
import { ProposalAction, ProposalViewer, resolveAvailableActions } from '../domain/delivery-fee-proposal.rules';

export interface DeliveryFeeProposalDto {
  id: string;
  shipmentId: string;
  orderId: string;
  agencyId: string;
  proposedBy: {
    role: 'agency' | 'agent';
    userId: string | null;
    agentId: string | null;
  };
  currency: string;
  feeBefore: number;
  proposedFee: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  respondedBy: { role: string; userId: string | null; at: Date } | null;
  rejectionNote: string | null;
  withdrawalReason: string | null;
  /** What the approval did to the money. Vendor view only — see `toDeliveryFeeProposalDto`. */
  application?: {
    feeAtApply: number;
    vendorAllocationBefore: number | null;
    vendorAllocationAfter: number | null;
    snapshotRewritten: boolean;
  } | null;
  /** Bumped by every edit. The vendor sends it back on approve/reject. */
  version: number;
  /** Append-only edit trail, oldest first. */
  edits: Array<{
    editedBy: { role: 'agency' | 'agent'; userId: string | null; agentId: string | null };
    feeBefore: number;
    feeAfter: number;
    reasonBefore: string;
    reasonAfter: string;
    version: number;
    at: Date;
  }>;
  lastEditedBy: { role: 'agency' | 'agent'; userId: string | null; agentId: string | null; at: Date } | null;
  /** True once the agency edited it — agency-owned from then on. */
  agencyEdited: boolean;
  /** The verbs THIS viewer may use right now — the same table the service enforces. */
  availableActions: ProposalAction[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One projection for every viewer. `application` carries the vendor's allocation (their
 * net), so it is rendered for the VENDOR only — an agency must not learn the vendor's
 * earnings from a fee negotiation.
 */
export function toDeliveryFeeProposalDto(p: IDeliveryFeeProposal, viewer: ProposalViewer): DeliveryFeeProposalDto {
  const agentId = p.proposed_by_agent_id ? p.proposed_by_agent_id.toString() : null;
  return {
    id: (p._id as any).toString(),
    shipmentId: p.shipment_id.toString(),
    orderId: p.order_id.toString(),
    agencyId: p.agency_id.toString(),
    proposedBy: {
      role: p.proposed_by_role,
      userId: p.proposed_by_user_id ? p.proposed_by_user_id.toString() : null,
      agentId,
    },
    currency: p.currency,
    feeBefore: p.fee_before,
    proposedFee: p.proposed_fee,
    reason: p.reason,
    status: p.status,
    respondedBy: p.responded_at
      ? {
          role: p.responded_by_role ?? 'system',
          userId: p.responded_by_user_id ? p.responded_by_user_id.toString() : null,
          at: p.responded_at,
        }
      : null,
    rejectionNote: p.rejection_note ?? null,
    withdrawalReason: p.withdrawal_reason ?? null,
    ...(viewer.role === 'vendor'
      ? {
          application: p.application
            ? {
                feeAtApply: p.application.fee_at_apply,
                vendorAllocationBefore: p.application.vendor_allocation_before ?? null,
                vendorAllocationAfter: p.application.vendor_allocation_after ?? null,
                snapshotRewritten: p.application.snapshot_rewritten,
              }
            : null,
        }
      : {}),
    version: p.version ?? 1,
    edits: (p.edits ?? []).map((e) => ({
      editedBy: {
        role: e.edited_by_role,
        userId: e.edited_by_user_id ? e.edited_by_user_id.toString() : null,
        agentId: e.edited_by_agent_id ? e.edited_by_agent_id.toString() : null,
      },
      feeBefore: e.fee_before,
      feeAfter: e.fee_after,
      reasonBefore: e.reason_before,
      reasonAfter: e.reason_after,
      version: e.version,
      at: e.at,
    })),
    lastEditedBy: p.last_edited_by
      ? {
          role: p.last_edited_by.role,
          userId: p.last_edited_by.user_id ? p.last_edited_by.user_id.toString() : null,
          agentId: p.last_edited_by.agent_id ? p.last_edited_by.agent_id.toString() : null,
          at: p.last_edited_by.at,
        }
      : null,
    agencyEdited: !!p.agency_edited,
    availableActions: resolveAvailableActions(
      {
        status: p.status,
        proposed_by_role: p.proposed_by_role,
        proposed_by_agent_id: agentId,
        agency_edited: !!p.agency_edited,
      },
      viewer
    ),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/**
 * The two fields every shipment payload carries (toSummary, offer rows). Synchronous and
 * query-free: they come off the shipment document itself.
 */
export function shipmentFeeProposalSummary(shipment: Pick<IShipment, 'pending_delivery_fee_proposal_id' | 'delivery_fee_override'>) {
  const override = shipment.delivery_fee_override ?? null;
  return {
    deliveryFeeProposalPending: !!shipment.pending_delivery_fee_proposal_id,
    pendingDeliveryFeeProposalId: shipment.pending_delivery_fee_proposal_id
      ? shipment.pending_delivery_fee_proposal_id.toString()
      : null,
    deliveryFeeOverride: override
      ? {
          amount: override.amount,
          proposalId: override.proposal_id.toString(),
          approvedAt: override.approved_at,
        }
      : null,
  };
}
