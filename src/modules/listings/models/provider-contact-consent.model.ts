import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PROVIDER_CONSENT_SOURCES, ProviderConsentSource } from '../domain/listing.types';

/**
 * ProviderContactConsent — a customer's opt-in to messages from ONE provider (L-14).
 *
 * Asked once, after the customer's first reveal from that provider. The default is No: a row
 * with `granted_at: null` means "asked, declined or not answered". Granted means
 * `granted_at != null && revoked_at == null`; a withdrawal (from settings, or from the
 * "Stop messages from this business" button on every relayed message) stamps `revoked_at`.
 * Granting again clears it. Only the customer changes it — never the provider, never an
 * administrator.
 */
export interface IProviderContactConsent extends Document {
  customer_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  asked_at: Date | null;
  granted_at: Date | null;
  revoked_at: Date | null;
  source: ProviderConsentSource;
  created_at: Date;
  updated_at: Date;
}

const ProviderContactConsentSchema = new Schema<IProviderContactConsent>(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    asked_at: { type: Date, default: null },
    granted_at: { type: Date, default: null },
    revoked_at: { type: Date, default: null },
    source: { type: String, enum: PROVIDER_CONSENT_SOURCES, required: true, default: 'bot' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

ProviderContactConsentSchema.index(
  { customer_id: 1, vendor_id: 1 },
  { unique: true, name: 'provider_consent_one_per_pair' },
);

export const ProviderContactConsentModel = mongoose.model<IProviderContactConsent>(
  MODELS.PROVIDER_CONTACT_CONSENT,
  ProviderContactConsentSchema,
  COLLECTIONS.PROVIDER_CONTACT_CONSENT,
);
