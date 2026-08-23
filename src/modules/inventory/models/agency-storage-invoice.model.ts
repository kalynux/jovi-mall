import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * `open` — issued, nobody has said it was paid.
 * `settled` — the agency says the vendor paid it. **Out of band** — see the model docstring.
 * `void` — issued in error. Kept, never deleted, so a gap in the numbering means something.
 */
export type StorageInvoiceStatus = 'open' | 'settled' | 'void';

export interface IStorageInvoiceLine {
  stock_level_id: Types.ObjectId;
  product_id: Types.ObjectId;
  variant_id: Types.ObjectId;
  /** Snapshotted: a vendor renaming a SKU must not rewrite last month's statement. */
  sku: string | null;
  product_title: string | null;
  location_id: Types.ObjectId | null;
  location_label: string | null;
  /** Units on the shelf when the invoice was issued — see the model docstring. */
  quantity: number;
  monthly_rate_per_sku: number;
  line_total: number;
}

export interface IAgencyStorageInvoice extends IBaseDocument {
  agency_id: Types.ObjectId;
  vendor_id: Types.ObjectId;

  /** `YYYY-MM`, the month billed. The idempotency key, with the two ids. */
  period_key: string;
  period_start: Date;
  /** Exclusive. `period_start` of the following month. */
  period_end: Date;

  lines: IStorageInvoiceLine[];
  /** Distinct SKUs billed. */
  sku_count: number;
  /** Σ line quantities. */
  unit_count: number;
  /** Σ line totals. */
  total: number;
  /** The rate every line was priced at, snapshotted off the agency's policy. */
  monthly_rate_per_sku: number;

  status: StorageInvoiceStatus;
  issued_at: Date;
  settled_at: Date | null;
  settled_by_user_id: Types.ObjectId | null;
  note: string | null;
}

const StorageInvoiceLineSchema = new Schema<IStorageInvoiceLine>({
  stock_level_id: { type: Schema.Types.ObjectId, ref: MODELS.AGENCY_STOCK_LEVEL, required: true },
  product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
  variant_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_VARIANT, required: true },
  sku: { type: String, default: null },
  product_title: { type: String, default: null },
  location_id: { type: Schema.Types.ObjectId, default: null },
  location_label: { type: String, default: null },
  quantity: { type: Number, required: true, min: 0 },
  monthly_rate_per_sku: { type: Number, required: true, min: 0 },
  line_total: { type: Number, required: true, min: 0 },
}, { _id: false });

/**
 * A month of storage rent, per (agency, vendor).
 *
 * ## ⚠ This is a RECORD. No money moves (D-7).
 *
 * The platform does not collect this from the vendor and does not pay it to the agency.
 * `EarningsQuoteService` still excludes `monthly_storage_fee_per_sku` from every per-order
 * split — it is rent, not a delivery fee — and there is deliberately no `EarningsLedger`
 * entry, no `CreditWallet` debit and no payout anywhere in this module. What the record
 * buys is that both sides now read the **same number**, that it is durable and dated, and
 * that "has this been paid" has somewhere to live. `settled` is the agency stating that it
 * was paid out of band; nothing verifies it, and the field name says who is claiming.
 *
 * ## What the quantity means, precisely
 *
 * **Units on the shelf at the moment of issue**, not an average over the month. The
 * platform holds no daily snapshot of a shelf, so an average would have to be reconstructed
 * from the movement ledger — which is possible and is a bigger feature than this one. The
 * chosen basis is stated on the wire and in the api-doc rather than left for a reader to
 * infer, because "we billed you for 40 units" is a claim somebody will check.
 *
 * ## Why the rate is snapshotted per line as well as per invoice
 *
 * An agency may change `monthly_storage_fee_per_sku` at any time, and a statement that
 * re-derives its own totals from the current policy would silently restate a month somebody
 * has already paid. Every number here is frozen at issue.
 *
 * ⚠ **No currency field**, deliberately: `monthly_storage_fee_per_sku` carries none either,
 * anywhere in this codebase, and inventing one here would make this the only place that
 * claims to know it.
 */
const AgencyStorageInvoiceSchema = new Schema<IAgencyStorageInvoice>({
  agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
  vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },

  period_key: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  period_start: { type: Date, required: true },
  period_end: { type: Date, required: true },

  lines: { type: [StorageInvoiceLineSchema], default: [] },
  sku_count: { type: Number, required: true, default: 0, min: 0 },
  unit_count: { type: Number, required: true, default: 0, min: 0 },
  total: { type: Number, required: true, default: 0, min: 0 },
  monthly_rate_per_sku: { type: Number, required: true, default: 0, min: 0 },

  status: { type: String, enum: ['open', 'settled', 'void'], required: true, default: 'open' },
  issued_at: { type: Date, required: true, default: Date.now },
  settled_at: { type: Date, default: null },
  settled_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
  note: { type: String, default: null, maxlength: 500, trim: true },

  ...BaseSchemaFields,
}, BaseSchemaOptions);

/**
 * One statement per (agency, vendor, month) — the generator's idempotency.
 *
 * Partial on `deletedAt: null` for the same reason the stock-level key is: a soft-deleted
 * statement must not block re-issuing that month. `void` rows DO hold the key, and that is
 * correct — voiding says "this statement was wrong", not "no statement exists"; re-issuing
 * over it would leave two documents claiming the same month.
 */
AgencyStorageInvoiceSchema.index(
  { agency_id: 1, vendor_id: 1, period_key: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

AgencyStorageInvoiceSchema.index({ agency_id: 1, status: 1, period_key: -1 });
AgencyStorageInvoiceSchema.index({ vendor_id: 1, status: 1, period_key: -1 });

export const AgencyStorageInvoiceModel = model<IAgencyStorageInvoice>(
  MODELS.AGENCY_STORAGE_INVOICE,
  AgencyStorageInvoiceSchema,
  COLLECTIONS.AGENCY_STORAGE_INVOICE,
);
