import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/** Which side of the storage arrangement acted. */
export type StockRequestParty = 'vendor' | 'agency';

export type StockRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** One entry of the append-only trail. */
export interface IStockRequestHistoryEntry {
  status: StockRequestStatus;
  changed_at: Date;
  changed_by_role: StockRequestParty;
  changed_by_user_id: Types.ObjectId | null;
  note: string | null;
}

export interface IStockAdjustmentRequest extends IBaseDocument {
  vendor_id: Types.ObjectId;
  /**
   * The agency that warehouses this product, snapshotted when the request was
   * raised. It is the *effective* agency (`delivery.agency_id`, else the vendor's
   * `default_delivery_agency_id`), resolved once here so the counterparty cannot
   * change under a standing request. Approval re-derives it and refuses on a
   * mismatch rather than silently letting a different agency answer.
   */
  agency_id: Types.ObjectId;
  product_id: Types.ObjectId;
  variant_id: Types.ObjectId;

  requested_by_role: StockRequestParty;
  requested_by_user_id: Types.ObjectId | null;
  requested_at: Date;

  /** `variant.stock` / `isInfiniteStock` when the request was raised. */
  quantity_before: number;
  infinite_before: boolean;

  /**
   * The ABSOLUTE target, never a delta.
   *
   * A delta approved three days later applies to a number nobody agreed on — the
   * approver would be signing off on "-10" without knowing what it lands on. An
   * absolute figure means the request says exactly what the shelf will read.
   * Drift is preserved rather than rejected: `quantity_before` is what the
   * proposer saw, `approval.quantity_at_apply` what was actually replaced.
   */
  requested_quantity: number;
  /**
   * Kept even though an agency-stored product may never be infinite (see
   * `agency-storage-stock.rule.ts`), because a vendor CAN ask — the request
   * endpoint has to be able to represent the ask in order to refuse it with the
   * right error instead of a validation shrug.
   */
  requested_infinite: boolean;

  status: StockRequestStatus;
  note: string | null;

  approval: {
    by_role: StockRequestParty;
    by_user_id: Types.ObjectId | null;
    at: Date;
    /** What `variant.stock` actually held the instant it was replaced. */
    quantity_at_apply: number;
  } | null;

  rejection: {
    by_role: StockRequestParty;
    by_user_id: Types.ObjectId | null;
    at: Date;
    reason: string | null;
  } | null;

  withdrawal: {
    by_role: StockRequestParty;
    by_user_id: Types.ObjectId | null;
    at: Date;
  } | null;

  status_history: IStockRequestHistoryEntry[];
}

const HistoryEntrySchema = new Schema<IStockRequestHistoryEntry>(
  {
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'withdrawn'], required: true },
    changed_at: { type: Date, required: true, default: Date.now },
    changed_by_role: { type: String, enum: ['vendor', 'agency'], required: true },
    changed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    note: { type: String, default: null, maxlength: 500, trim: true },
  },
  { _id: false },
);

/**
 * A proposed change to `ProductVariant.stock` on a SKU an agency warehouses.
 *
 * ## Why the number needs two signatures
 *
 * `variant.stock` used to be the vendor's alone. For an `agency_storage` product
 * that is the wrong owner for it: the agency is the party that can actually go and
 * count the shelf, it bills storage per SKU against that figure, and it is the one
 * left short when a delivery is dispatched against stock that was never delivered
 * to the warehouse. Equally, the agency cannot be trusted to write it unilaterally —
 * it is the vendor's goods and the vendor's catalogue.
 *
 * So neither side writes it. Either proposes, the other approves, and the number
 * moves in the same transaction that records the approval.
 *
 * ## Shape notes
 *
 * Per-outcome sub-documents (`approval` / `rejection` / `withdrawal`) rather than a
 * flat set of nullable columns, mirroring `VendorAgencyConnection` — it makes
 * "rejected, by whom, when, why" unambiguous and impossible to half-fill.
 *
 * Soft-deletable via `BaseSchemaFields` but nothing deletes these: the trail of who
 * moved a warehoused quantity is the point.
 */
const StockAdjustmentRequestSchema = new Schema<IStockAdjustmentRequest>({
  vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
  agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
  product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
  variant_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_VARIANT, required: true },

  requested_by_role: { type: String, enum: ['vendor', 'agency'], required: true },
  requested_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
  requested_at: { type: Date, required: true, default: Date.now },

  quantity_before: { type: Number, required: true, min: 0 },
  infinite_before: { type: Boolean, required: true, default: false },

  requested_quantity: { type: Number, required: true, min: 0 },
  requested_infinite: { type: Boolean, required: true, default: false },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'withdrawn'],
    required: true,
    default: 'pending',
  },
  note: { type: String, default: null, maxlength: 500, trim: true },

  approval: {
    type: {
      by_role: { type: String, enum: ['vendor', 'agency'], required: true },
      by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
      at: { type: Date, required: true },
      quantity_at_apply: { type: Number, required: true },
    },
    required: false,
    default: null,
  },

  rejection: {
    type: {
      by_role: { type: String, enum: ['vendor', 'agency'], required: true },
      by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
      at: { type: Date, required: true },
      reason: { type: String, default: null, maxlength: 500, trim: true },
    },
    required: false,
    default: null,
  },

  withdrawal: {
    type: {
      by_role: { type: String, enum: ['vendor', 'agency'], required: true },
      by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
      at: { type: Date, required: true },
    },
    required: false,
    default: null,
  },

  status_history: { type: [HistoryEntrySchema], default: [] },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// At most ONE open request per SKU. Partial so resolved rows don't block the next
// negotiation — the same trick `ContractTermsProposal` uses for its one-open rule.
// Without it, both sides proposing at once leaves two pending rows and whichever
// is approved second silently overwrites the first.
StockAdjustmentRequestSchema.index(
  { variant_id: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

// The two inboxes. `createdAt`, not `created_at`: BaseSchemaOptions sets
// `timestamps: true`, which is camelCase.
StockAdjustmentRequestSchema.index({ agency_id: 1, status: 1, createdAt: -1 });
StockAdjustmentRequestSchema.index({ vendor_id: 1, status: 1, createdAt: -1 });

// One SKU's negotiation history, and the read-model's "is anything open on this
// page of rows?" lookup.
StockAdjustmentRequestSchema.index({ variant_id: 1, createdAt: -1 });

export const StockAdjustmentRequestModel = model<IStockAdjustmentRequest>(
  MODELS.STOCK_ADJUSTMENT_REQUEST,
  StockAdjustmentRequestSchema,
  COLLECTIONS.STOCK_ADJUSTMENT_REQUEST,
);
