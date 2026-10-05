import { OrderModel, IOrder } from '../../orders/order.model';
import { VendorModel, IVendorReturnPolicy } from '../../vendors/vendor.model';
import { computeVendorRefundEligibility } from '../../vendor/service/vendor-refund.service';
import { ERROR_CODES } from '../../../core/error-codes';
import type { CodCollectionCoverage } from '../domain/refund-ports';
import { RefundSourceKind } from '../models/refund-request.model';
import {
  attributeRefund,
  AttributionInput,
  maxAttributable,
  REFUND_REASON_KINDS,
  RefundReasonKind,
  ReturnShippingPayer,
} from '../domain/refund-attribution';
import { computeRefundFee, RefundPaymentChannel } from '../domain/refund-fee';
import { maskRefundPhone, normalizeRefundPhone } from '../domain/refund-destination';
import { getPaymentSettingsSync } from './payment-settings.service';
import { refundRequestService, RefundRequestService, SourceFacts } from './refund-request.service';

/**
 * The admin refund PREVIEW (REFUND-FLOW-PLAN § 11.7, `GET /api/internal/admin/refunds/eligibility`).
 *
 * ── One source of facts ───────────────────────────────────────────────────────
 * Everything money-shaped comes from `RefundRequestService.describeSource` — the SAME read
 * `create` builds a request from — so the ceiling the dashboard shows and the ceiling `create`
 * enforces cannot disagree. Nothing here writes.
 *
 * ── The vendor's commercial gates are REPORTED, not enforced ──────────────────
 * For an ORDER, `overrides[]` lists which of the vendor's return-policy gates a refund would
 * bypass, by the same pure `computeVendorRefundEligibility` the vendor's own path and the legacy
 * admin path use (one definition, three readers). The platform is not party to the vendor's
 * return window; an administrator may go past it, deliberately — `create` refuses
 * `422 REFUND_POLICY_OVERRIDE_REQUIRED` unless `overridePolicy: true` is sent when this list is
 * non-empty. Bookings and billing carry no vendor return policy, so their list is always empty.
 */

export type VendorPolicyOverride =
  | 'return_window_expired'
  | 'policy_disabled'
  | 'order_not_paid'
  | 'above_policy_maximum';

export interface AttributionPreviewRow {
  maxRefundable: number;
  goods: number;
  delivery: number;
  feeAmount: number;
  netAmount: number;
}

export interface RefundEligibilityDto {
  sourceKind: RefundSourceKind;
  sourceId: string;
  /** GROSS ceiling for the selected reason: min(attribution rule, money still refundable). */
  maxRefundable: number;
  currency: string;
  paymentChannel: RefundPaymentChannel;
  /** Every payment leg carries a readable payer number (mobile money only). */
  hasPayerPhone: boolean;
  payerPhoneMasked: string | null;
  attributionPreview: {
    reasonKind: RefundReasonKind;
    itemDefective: boolean | null;
    goods: number;
    delivery: number;
    goodsAmount: number;
    deliveryAmountPaid: number;
    delivered: boolean;
    /** Money still refundable, before the attribution rule. */
    remaining: number;
    feeAmount: number;
    netAmount: number;
    byReasonKind: Record<RefundReasonKind, AttributionPreviewRow>;
  };
  returnShippingPayer: ReturnShippingPayer | null;
  overrides: VendorPolicyOverride[];
  codCoverage: CodCollectionCoverage[];
  /** The percent applied to this source (0 for a card payment, R-3). */
  feePercent: number;
}

export interface EligibilityQuery {
  sourceKind: RefundSourceKind;
  sourceId: string;
  reasonKind?: RefundReasonKind;
  itemDefective?: boolean;
  amount?: number;
}

export class RefundEligibilityService {
  constructor(private readonly refunds: RefundRequestService = refundRequestService) {}

  async preview(query: EligibilityQuery): Promise<RefundEligibilityDto> {
    const facts = await this.refunds.describeSource(query.sourceKind, query.sourceId);
    const reasonKind = query.reasonKind ?? defaultReasonKind(facts);
    const itemDefective = query.itemDefective ?? null;
    const feePercent = facts.paymentChannel === 'card' ? 0 : getPaymentSettingsSync().refund_fee_percent;

    const row = (kind: RefundReasonKind): AttributionPreviewRow => {
      const input = attributionInputOf(facts, kind, itemDefective);
      const max = Math.max(0, Math.min(maxAttributable(input), facts.remaining));
      const attribution = attributeRefund(input, max) ?? { goods: 0, delivery: 0 };
      const fee = computeRefundFee(max, feePercent, facts.paymentChannel);
      return { maxRefundable: max, goods: attribution.goods, delivery: attribution.delivery, feeAmount: fee.feeAmount, netAmount: fee.netAmount };
    };
    const byReasonKind = Object.fromEntries(REFUND_REASON_KINDS.map((k) => [k, row(k)])) as Record<
      RefundReasonKind,
      AttributionPreviewRow
    >;
    const selected = byReasonKind[reasonKind];

    const phones = facts.legs.map((l) => normalizeRefundPhone(l.payerPhone));
    const hasPayerPhone =
      facts.paymentChannel === 'mobile_money' && phones.length > 0 && phones.every((p) => p !== null);

    const overrides = facts.kind === 'order'
      ? await this.orderPolicyOverrides(facts, query.amount ?? selected.maxRefundable)
      : [];

    return {
      sourceKind: facts.kind,
      sourceId: facts.id,
      maxRefundable: selected.maxRefundable,
      currency: facts.currency,
      paymentChannel: facts.paymentChannel,
      hasPayerPhone,
      payerPhoneMasked: hasPayerPhone ? maskRefundPhone(phones[0]) : null,
      attributionPreview: {
        reasonKind,
        itemDefective,
        goods: selected.goods,
        delivery: selected.delivery,
        goodsAmount: facts.goodsAmount,
        deliveryAmountPaid: facts.deliveryAmountPaid,
        delivered: facts.delivered,
        remaining: facts.remaining,
        feeAmount: selected.feeAmount,
        netAmount: selected.netAmount,
        byReasonKind,
      },
      returnShippingPayer: facts.returnShippingPayer,
      overrides,
      codCoverage: facts.codCollections,
      feePercent,
    };
  }

  /**
   * Which vendor return-policy gates a refund of `amount` on this ORDER would bypass. Empty for
   * any other source. Shared by the preview and by the create route's override check.
   */
  async policyOverridesFor(input: {
    kind: RefundSourceKind;
    sourceId: string;
    amount?: number;
    reasonKind: RefundReasonKind;
    itemDefective: boolean | null;
  }): Promise<VendorPolicyOverride[]> {
    if (input.kind !== 'order') return [];
    const facts = await this.refunds.describeSource(input.kind, input.sourceId);
    // Absent amount = what `create` defaults to: the most the attribution and the money allow.
    const ceiling = Math.min(
      maxAttributable(attributionInputOf(facts, input.reasonKind, input.itemDefective)),
      facts.remaining
    );
    return this.orderPolicyOverrides(facts, input.amount ?? ceiling);
  }

  private async orderPolicyOverrides(facts: SourceFacts, amount: number): Promise<VendorPolicyOverride[]> {
    const order = await OrderModel.findById(facts.id);
    if (!order) return [];
    const vendor = await VendorModel.findById(order.vendor_id)
      .select('policies.return_policy')
      .lean<{ policies?: { return_policy?: IVendorReturnPolicy } } | null>();
    return policyOverridesOf(order, vendor?.policies?.return_policy ?? null, facts, amount);
  }
}

/** Pure: the vendor-policy overrides for `amount`, from the vendor's own eligibility rule. */
export function policyOverridesOf(
  order: IOrder,
  returnPolicy: IVendorReturnPolicy | null,
  facts: Pick<SourceFacts, 'remaining' | 'currency'>,
  amount: number
): VendorPolicyOverride[] {
  // The money still refundable stands in for the payment record, so the rule sees the SAME
  // balance `create` enforces — COD (no payment transaction) included.
  const vendorPolicy = computeVendorRefundEligibility(order, returnPolicy, {
    amountSnapshot: facts.remaining,
    totalRefunded: 0,
    currencySnapshot: facts.currency,
  });
  const overrides: VendorPolicyOverride[] = [];
  if (vendorPolicy.reasonCode === ERROR_CODES.REFUND_WINDOW_EXPIRED) overrides.push('return_window_expired');
  if (vendorPolicy.reasonCode === ERROR_CODES.REFUND_POLICY_DISABLED) overrides.push('policy_disabled');
  if (vendorPolicy.reasonCode === ERROR_CODES.REFUND_ORDER_NOT_PAID) overrides.push('order_not_paid');
  if (vendorPolicy.eligible && amount > vendorPolicy.maxRefundable) overrides.push('above_policy_maximum');
  return overrides;
}

/** Before delivery a refund is a cancellation; after it, a return (D-5). */
export function defaultReasonKind(facts: Pick<SourceFacts, 'delivered'>): RefundReasonKind {
  return facts.delivered ? 'return' : 'cancellation';
}

function attributionInputOf(
  facts: SourceFacts,
  reasonKind: RefundReasonKind,
  itemDefective: boolean | null
): AttributionInput {
  return {
    reasonKind,
    returnShippingPayer: facts.returnShippingPayer,
    itemDefective,
    goodsAmount: facts.goodsAmount,
    deliveryAmountPaid: facts.deliveryAmountPaid,
    delivered: facts.delivered,
  };
}

export const refundEligibilityService = new RefundEligibilityService();
