import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PAYMENT_GATEWAY_NAMES, PaymentGatewayName } from '../gateways/gateway.interface';
import { PAYMENT_PROVIDERS, PaymentProvider } from '../domain/payment-provider';

/**
 * `payment_settings`: a single document, `_id: 'payments'` (ADR-A08 D-3).
 *
 * Which aggregator opens new collections, which one sends payouts, whether Stripe is on, and
 * which providers customers may choose. Written only by an administrator through wi-admin dev
 * tools; read through the cached `services/payment-settings.service.ts`, never per request.
 *
 * Mongo for the reason `system_state` gives: it survives a restart and converges across
 * instances, and it adds no new failure mode because nothing serves without Mongo anyway.
 *
 * **A missing document is the normal state**, and it means `DEFAULT_PAYMENT_SETTINGS`
 * (`domain/payment-routing.ts`). No seed, no migration. The first administrator write creates
 * it at `version: 1`.
 *
 * `version` is the compare-and-set counter. The literal `_id` means the unique primary key is
 * what makes two concurrent "first writes" collide instead of both succeeding.
 */

export const PAYMENT_SETTINGS_ID = 'payments';

export interface IPaymentSettings extends Document<string> {
  _id: string;
  collection_aggregator: PaymentGatewayName;
  payout_aggregator: PaymentGatewayName;
  stripe_enabled: boolean;
  providers: Record<PaymentProvider, { enabled: boolean }>;
  /** REFUND-FLOW-PLAN § 11.6: percent taken off a transfer/external refund. Absent on older documents = 2. */
  refund_fee_percent?: number;
  version: number;
  updated_at: Date | null;
  /** A wi-admin administrator id: resolves to nothing here, so the name is snapshotted beside it. */
  updated_by_id: string | null;
  updated_by_name: string | null;
  reason: string | null;
}

const providerFields = Object.fromEntries(
  PAYMENT_PROVIDERS.map((p) => [p, { enabled: { type: Boolean, default: false } }]),
);

const PaymentSettingsSchema = new Schema<IPaymentSettings>(
  {
    _id: { type: String, required: true },
    collection_aggregator: { type: String, enum: [...PAYMENT_GATEWAY_NAMES], required: true },
    payout_aggregator: { type: String, enum: [...PAYMENT_GATEWAY_NAMES], required: true },
    stripe_enabled: { type: Boolean, default: false },
    providers: providerFields,
    refund_fee_percent: { type: Number, min: 0, max: 20, default: 2 },
    version: { type: Number, required: true, min: 1 },
    updated_at: { type: Date, default: null },
    updated_by_id: { type: String, default: null },
    updated_by_name: { type: String, default: null },
    reason: { type: String, default: null },
  },
  {
    // `updated_at` is written by the service with the rest of the change, not by Mongoose.
    timestamps: false,
    // The `_id` is ours, not Mongoose's.
    _id: false,
  },
);

export const PaymentSettingsModel = mongoose.model<IPaymentSettings>(
  MODELS.PAYMENT_SETTINGS,
  PaymentSettingsSchema,
  COLLECTIONS.PAYMENT_SETTINGS,
);
