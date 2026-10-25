import type { IEarningsAdjustment } from '../models/earnings-adjustment.model';
import type { IAgencyClaim } from '../models/agency-claim.model';

/**
 * What a vendor, an agency or an agent reads about money taken from (or forgiven to) them, and
 * what everybody reads about a damage claim (owner objective, 2026-10-22). Pure projections.
 *
 * Rows written before 2026-10-22 carry no explanation; they get a plain sentence from their kind
 * so a list never shows a blank line.
 */

export interface EarningsAdjustmentDto {
  id: string;
  /** `refund_clawback` (taken back), `clawback_recovery` (income applied to a debt), `write_off` (debt forgiven). */
  kind: string;
  amount: number;
  currency: string;
  /** Where it came from: still-held money, the COD reserve, available, or a debt now owed. */
  takenFrom: { pending: number; reserve: number; available: number; debt: number };
  /** Part of `amount` that is fees (a seller's cancelled-order fees, a lost dispute's payment fee). */
  feeAmount: number;
  /** A closed code to switch on, the numbers the sentence uses, and the English sentence. */
  reasonCode: string | null;
  reasonParams: Record<string, unknown> | null;
  explanation: string;
  refundRequestId: string | null;
  agencyClaimId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdAt: Date;
}

function fallbackExplanation(row: Pick<IEarningsAdjustment, 'kind' | 'amount' | 'currency'>): string {
  const money = `${Math.round(row.amount).toLocaleString('en-US')} ${row.currency}`;
  switch (row.kind) {
    case 'clawback_recovery':
      return `${money} of new earnings went to pay back a refund debt you owed.`;
    case 'write_off':
      return `Wi-Mall forgave ${money} of a refund debt you owed.`;
    default:
      return `${money} was taken back because the customer was refunded.`;
  }
}

export function toEarningsAdjustmentDto(row: IEarningsAdjustment): EarningsAdjustmentDto {
  return {
    id: String(row._id),
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    takenFrom: {
      pending: row.taken_from?.pending ?? 0,
      reserve: row.taken_from?.reserve ?? 0,
      available: row.taken_from?.available ?? 0,
      debt: row.taken_from?.debt ?? 0,
    },
    feeAmount: row.fee_amount ?? 0,
    reasonCode: row.reason_code ?? null,
    reasonParams: (row.reason_params as Record<string, unknown> | null) ?? null,
    explanation: row.explanation ?? fallbackExplanation(row),
    refundRequestId: row.refund_request_id ? String(row.refund_request_id) : null,
    agencyClaimId: row.agency_claim_id ? String(row.agency_claim_id) : null,
    sourceType: row.source_type ?? null,
    sourceId: row.source_id ? String(row.source_id) : null,
    createdAt: row.created_at,
  };
}

/** A damage claim as the agency and the vendor read it. No administrator identity, no internal note. */
export interface AgencyClaimPartyDto {
  id: string;
  kind: 'damage';
  shipmentId: string;
  orderId: string;
  orderNumber: string | null;
  trackingNumber: string | null;
  itemCount: number;
  maxPerItem: number;
  cap: number;
  amount: number;
  investigationFee: number;
  currency: string;
  deliveredAt: Date;
  raisedAt: Date;
  windowDays: number;
  reasonCode: string;
  reasonParams: Record<string, unknown>;
  explanation: string;
  createdAt: Date;
}

/** The administrator's view: everything, including who made it and why. */
export interface AgencyClaimAdminDto extends AgencyClaimPartyDto {
  agencyId: string;
  vendorId: string | null;
  refundRequestId: string | null;
  claimedAmount: number;
  note: string;
  createdBy: { id: string | null; name: string | null };
  takenFrom: { pending: number; reserve: number; available: number; debt: number };
}

export function toAgencyClaimPartyDto(c: IAgencyClaim): AgencyClaimPartyDto {
  return {
    id: String(c._id),
    kind: c.kind,
    shipmentId: String(c.shipment_id),
    orderId: String(c.order_id),
    orderNumber: c.order_number ?? null,
    trackingNumber: c.tracking_number ?? null,
    itemCount: c.item_count,
    maxPerItem: c.max_per_item,
    cap: c.cap,
    amount: c.amount,
    investigationFee: c.investigation_fee,
    currency: c.currency,
    deliveredAt: c.delivered_at,
    raisedAt: c.raised_at,
    windowDays: c.window_days,
    reasonCode: c.reason_code,
    reasonParams: c.reason_params,
    explanation: c.explanation,
    createdAt: c.created_at,
  };
}

export function toAgencyClaimAdminDto(c: IAgencyClaim): AgencyClaimAdminDto {
  return {
    ...toAgencyClaimPartyDto(c),
    agencyId: String(c.agency_id),
    vendorId: c.vendor_id ? String(c.vendor_id) : null,
    refundRequestId: c.refund_request_id ? String(c.refund_request_id) : null,
    claimedAmount: c.claimed_amount,
    note: c.note,
    createdBy: { id: c.created_by?.id ?? null, name: c.created_by?.name ?? null },
    takenFrom: {
      pending: c.taken_from?.pending ?? 0,
      reserve: c.taken_from?.reserve ?? 0,
      available: c.taken_from?.available ?? 0,
      debt: c.taken_from?.debt ?? 0,
    },
  };
}
