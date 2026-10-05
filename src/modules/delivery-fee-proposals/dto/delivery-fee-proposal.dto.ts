import { IDeliveryFeeProposal } from '../models/delivery-fee-proposal.model';
import { IShipment } from '../../shipments/shipment.model';
import { ProposalAction, ProposalViewer, resolveAvailableActions } from '../domain/delivery-fee-proposal.rules';
import type { IDeliveryFeeRefund } from '../models/delivery-fee-refund.model';

export interface DeliveryFeeProposalDto {
  id: string;
  shipmentId: string;
  orderId: string;
  agencyId: string;
  proposedBy: {
    role: 'agency' | 'agent' | 'system';
    userId: string | null;
    agentId: string | null;
  };
  /**
   * ADR-A11. Who answers: `vendor` (vendor-paid), `customer` (an increase on a customer-paid
   * shipment), `none` (a customer-paid decrease — already applied when created).
   */
  approver: 'vendor' | 'customer' | 'none';
  /** `agency` (an agency/agent proposal) · `change_agency` (D-10 difference) · `combined_request`. */
  origin: 'agency' | 'change_agency' | 'combined_request';
  direction: 'increase' | 'decrease' | null;
  /** The customer approved (online: the top-up it needs is on `topup`) — null otherwise. */
  customerApproval: { approvedAt: Date; version: number } | null;
  topup: { amount: number; status: 'awaiting_payment' | 'paid'; paidAt: Date | null } | null;
  combinedRequestId: string | null;
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
    /** ADR-A11 — the customer side of a customer-paid change (null on a vendor-paid one). */
    customerFeeBefore: number | null;
    customerFeeAfter: number | null;
    customerTopupAmount: number | null;
    customerRefundDue: number | null;
    codCollectionAdjusted: boolean;
    vendorBorneDelta: number | null;
  } | null;
  /** Bumped by every edit. The vendor sends it back on approve/reject. */
  version: number;
  /** Append-only edit trail, oldest first. */
  edits: Array<{
    editedBy: { role: 'agency' | 'agent' | 'system'; userId: string | null; agentId: string | null };
    feeBefore: number;
    feeAfter: number;
    reasonBefore: string;
    reasonAfter: string;
    version: number;
    at: Date;
  }>;
  lastEditedBy: { role: 'agency' | 'agent' | 'system'; userId: string | null; agentId: string | null; at: Date } | null;
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
    approver: p.approver ?? 'vendor',
    origin: p.origin ?? 'agency',
    direction: p.direction ?? null,
    customerApproval: p.customer_approval
      ? { approvedAt: p.customer_approval.approved_at, version: p.customer_approval.version }
      : null,
    topup: p.topup ? { amount: p.topup.amount, status: p.topup.status, paidAt: p.topup.paid_at ?? null } : null,
    combinedRequestId: p.combined_request_id ? p.combined_request_id.toString() : null,
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
                customerFeeBefore: p.application.customer_fee_before ?? null,
                customerFeeAfter: p.application.customer_fee_after ?? null,
                customerTopupAmount: p.application.customer_topup_amount ?? null,
                customerRefundDue: p.application.customer_refund_due ?? null,
                codCollectionAdjusted: !!p.application.cod_collection_adjusted,
                vendorBorneDelta: p.application.vendor_borne_delta ?? null,
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
        approver: p.approver ?? 'vendor',
        origin: p.origin ?? 'agency',
        customer_approved: !!p.customer_approval,
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

/**
 * The CUSTOMER's projection (ADR-A11). Deliberately narrower than the dashboards' one: no user
 * or agent ids, no edit trail, no money application (the vendor's net is not the customer's
 * business). What is left is what a customer decides on — the figure, why, and their verbs.
 */
export interface CustomerDeliveryFeeProposalDto {
  id: string;
  shipmentId: string;
  orderId: string;
  /** Who raised it, in the customer's terms: the delivery company, or the platform (a moved parcel). */
  raisedBy: 'delivery_company' | 'platform';
  origin: 'agency' | 'change_agency' | 'combined_request';
  direction: 'increase' | 'decrease' | null;
  currency: string;
  feeBefore: number;
  proposedFee: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  /** Send back on approve / reject — an edited figure is refused (409). */
  version: number;
  /** Online increase approved: what must be paid before pickup. */
  topup: { amount: number; status: 'awaiting_payment' | 'paid'; paidAt: Date | null } | null;
  availableActions: ProposalAction[];
  respondedAt: Date | null;
  createdAt: Date;
}

export function toCustomerDeliveryFeeProposalDto(p: IDeliveryFeeProposal): CustomerDeliveryFeeProposalDto {
  return {
    id: (p._id as any).toString(),
    shipmentId: p.shipment_id.toString(),
    orderId: p.order_id.toString(),
    raisedBy: p.proposed_by_role === 'system' ? 'platform' : 'delivery_company',
    origin: p.origin ?? 'agency',
    direction: p.direction ?? null,
    currency: p.currency,
    feeBefore: p.fee_before,
    proposedFee: p.proposed_fee,
    reason: p.reason,
    status: p.status,
    version: p.version ?? 1,
    topup: p.topup ? { amount: p.topup.amount, status: p.topup.status, paidAt: p.topup.paid_at ?? null } : null,
    availableActions: resolveAvailableActions(
      {
        status: p.status,
        proposed_by_role: p.proposed_by_role,
        proposed_by_agent_id: p.proposed_by_agent_id ? p.proposed_by_agent_id.toString() : null,
        agency_edited: !!p.agency_edited,
        approver: p.approver ?? 'vendor',
        origin: p.origin ?? 'agency',
        customer_approved: !!p.customer_approval,
      },
      { role: 'customer' }
    ),
    respondedAt: p.responded_at ?? null,
    createdAt: p.created_at,
  };
}

/**
 * A MANUAL delivery-fee refund as an administrator sees it (W-E2,
 * `/api/internal/admin/delivery-fee-refunds`). The operator-facing `note` (why it is manual) is
 * included here and nowhere customer-facing. `settledBy.id` is a wi-admin administrator id.
 */
export interface AdminDeliveryFeeRefundDto {
  id: string;
  orderId: string;
  orderNumber: string | null;
  shipmentId: string | null;
  customerId: string;
  vendorId: string;
  amount: number;
  currency: string;
  /** `manual_required` (owed — the settle button) · `completed` (settled). */
  status: string;
  cause: string;
  note: string | null;
  ticketId: string | null;
  /** The refund REQUEST that returns this money (REFUND-FLOW-PLAN § 7), or null on a legacy row. */
  refundRequestId: string | null;
  /** True while it may be settled — the one flag the button needs. */
  settleable: boolean;
  settlement: {
    method: string;
    reference: string | null;
    note: string | null;
    settledBy: { id: string; source: string; name: string | null };
    settledAt: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toAdminDeliveryFeeRefundDto(r: IDeliveryFeeRefund, orderNumber: string | null): AdminDeliveryFeeRefundDto {
  const s = r.settlement;
  return {
    id: (r._id as any).toString(),
    orderId: r.order_id.toString(),
    orderNumber,
    shipmentId: r.shipment_id ? r.shipment_id.toString() : null,
    customerId: r.customer_id.toString(),
    vendorId: r.vendor_id.toString(),
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    cause: r.cause,
    note: r.note ?? null,
    ticketId: r.ticket_id ? r.ticket_id.toString() : null,
    refundRequestId: r.refund_request_id ? r.refund_request_id.toString() : null,
    // A row whose money sits in an OPEN refund request is settled in the refund queue, not here.
    settleable: r.status === 'manual_required' && !r.refund_request_id,
    settlement: s
      ? {
          method: s.method,
          reference: s.reference ?? null,
          note: s.note ?? null,
          settledBy: { id: s.settled_by_user_id, source: s.settled_by_source, name: s.settled_by_name ?? null },
          settledAt: s.settled_at,
        }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
