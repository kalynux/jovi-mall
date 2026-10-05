import { IRefundRequest } from '../models/refund-request.model';

/**
 * The camelCase projection of `refund_requests` (REFUND-FLOW-PLAN § 11.7) — what the internal
 * admin routes answer and what wi-admin renders. Explicit, field by field: a spread would publish
 * whatever the model gains next. Destination phones are FULL here (the administrator surface);
 * customer-facing views mask them with `maskRefundPhone`.
 */
export interface RefundRequestDto {
  id: string;
  sourceKind: IRefundRequest['source_kind'];
  sourceId: string;
  orderNumber: string | null;
  vendorId: string | null;
  customerId: string | null;
  reasonKind: IRefundRequest['reason_kind'];
  reason: string | null;
  itemDefective: boolean | null;
  overridePolicy: boolean;
  attribution: { goods: number; delivery: number };
  grossAmount: number;
  feeRate: number;
  feeAmount: number;
  netAmount: number;
  currency: string;
  paymentChannel: IRefundRequest['payment_channel'];
  channel: IRefundRequest['channel'];
  destination: { phone: string; name: string; source: 'payer' | 'typed' } | null;
  destinationProofFileId: string | null;
  codCollectionIds: string[];
  status: IRefundRequest['status'];
  requestedBy: IRefundRequest['requested_by'];
  approvedBy: { id: string | null; name: string | null; at: Date } | null;
  rejectedBy: { id: string | null; name: string | null; at: Date } | null;
  rejectionReason: string | null;
  transferReference: string | null;
  transferGateway: string | null;
  transferGatewayRef: string | null;
  transferFailureReason: string | null;
  transferNote: string | null;
  transferLegs: Array<{ phone: string; amount: number; gross: number; reference: string; gatewayRef: string | null; status: string; failureReason: string | null }>;
  externalSettlement: {
    method: string;
    reference: string | null;
    proofFileId: string;
    settledBy: { id: string | null; name: string | null };
    settledAt: Date;
    /** The part paid BY HAND — less than the request after a partly-sent multi-transfer refund. */
    grossAmount: number;
    netAmount: number;
  } | null;
  ticketId: string | null;
  refundTransactionIds: string[];
  completedAt: Date | null;
  /** `clawback` (earnings paused + recovered) or `none` (unallocated delivery money). */
  earningsImpact: IRefundRequest['earnings_impact'];
  /** When the earnings recovery of a completed order/booking refund finished; null until then. */
  earningsSettledAt: Date | null;
  /** When a completed billing refund took the plan or credits back; null until then. */
  billingReversedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toRefundRequestDto(row: IRefundRequest): RefundRequestDto {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id.toString(),
    orderNumber: row.order_number ?? null,
    vendorId: row.vendor_id?.toString() ?? null,
    customerId: row.customer_id?.toString() ?? null,
    reasonKind: row.reason_kind,
    reason: row.reason ?? null,
    itemDefective: row.item_defective ?? null,
    overridePolicy: row.override_policy === true,
    attribution: { goods: row.attribution?.goods ?? 0, delivery: row.attribution?.delivery ?? 0 },
    grossAmount: row.gross_amount,
    feeRate: row.fee_rate,
    feeAmount: row.fee_amount,
    netAmount: row.net_amount,
    currency: row.currency,
    paymentChannel: row.payment_channel,
    channel: row.channel ?? null,
    destination: row.destination
      ? { phone: row.destination.phone, name: row.destination.name, source: row.destination.source }
      : null,
    destinationProofFileId: row.destination_proof_file_id?.toString() ?? null,
    codCollectionIds: (row.cod_collection_ids ?? []).map((c) => c.toString()),
    status: row.status,
    requestedBy: { id: row.requested_by?.id ?? null, role: row.requested_by?.role, name: row.requested_by?.name ?? null },
    approvedBy: row.approved_by ? { id: row.approved_by.id, name: row.approved_by.name, at: row.approved_by.at } : null,
    rejectedBy: row.rejected_by ? { id: row.rejected_by.id, name: row.rejected_by.name, at: row.rejected_by.at } : null,
    rejectionReason: row.rejection_reason ?? null,
    transferReference: row.transfer_reference ?? null,
    transferGateway: row.transfer_gateway ?? null,
    transferGatewayRef: row.transfer_gateway_ref ?? null,
    transferFailureReason: row.transfer_failure_reason ?? null,
    transferNote: row.transfer_note ?? null,
    transferLegs: (row.transfer_legs ?? []).map((l) => ({
      phone: l.phone,
      amount: l.amount,
      gross: l.gross,
      reference: l.reference,
      gatewayRef: l.gateway_ref ?? null,
      status: l.status,
      failureReason: l.failure_reason ?? null,
    })),
    externalSettlement: row.external_settlement
      ? {
          method: row.external_settlement.method,
          reference: row.external_settlement.reference ?? null,
          proofFileId: row.external_settlement.proof_file_id.toString(),
          settledBy: { id: row.external_settlement.settled_by?.id ?? null, name: row.external_settlement.settled_by?.name ?? null },
          settledAt: row.external_settlement.settled_at,
          // A row from before 2026-10-05 carries no split: it was the whole request.
          grossAmount: row.external_settlement.gross_amount ?? row.gross_amount,
          netAmount: row.external_settlement.net_amount ?? row.net_amount,
        }
      : null,
    ticketId: row.ticket_id?.toString() ?? null,
    refundTransactionIds: (row.refund_transaction_ids ?? []).map((t) => t.toString()),
    completedAt: row.completed_at ?? null,
    earningsImpact: row.earnings_impact ?? 'clawback',
    earningsSettledAt: row.earnings_settled_at ?? null,
    billingReversedAt: row.billing_reversed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
