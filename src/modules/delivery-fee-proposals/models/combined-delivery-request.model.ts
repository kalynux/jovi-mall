import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { COMBINED_REQUEST_STATUSES, CombinedRequestStatus } from '../domain/customer-fee-change.rules';

/** One shipment of the request, with the fee it carried when the customer asked. */
export interface ICombinedRequestShipment {
  shipment_id: Types.ObjectId;
  order_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  fee_at_request: number;
}

/** The agency's answer: the lower fees it granted (each became a decrease proposal), or none. */
export interface ICombinedRequestAnswer {
  fees: Array<{ shipment_id: Types.ObjectId; fee_before: number; fee_after: number; proposal_id: Types.ObjectId }>;
  /** Σ (fee_before − fee_after) — what the customer saved. */
  saving: number;
  note: string | null;
  answered_by_user_id: Types.ObjectId | null;
  answered_at: Date;
}

/**
 * A customer's request to ONE agency for a combined delivery price on ≥ 2 of their parcels from
 * ONE checkout (owner decision D-8, ADR-A11). The fees were posted prices at checkout; this is
 * the customer asking, after paying, whether carrying several parcels together can be cheaper.
 *
 * The agency answers by LOWERING fees — each lowered fee is an ordinary decrease proposal
 * (`origin: 'combined_request'`), applied directly, with the money returned exactly as any
 * decrease returns it — or by declining. It can never raise one here.
 *
 *   open → answered | declined   (the agency)
 *   open → cancelled             (the customer)
 *
 * One open request per (checkout, agency) — partial unique index.
 */
export interface ICombinedDeliveryRequest extends Document {
  customer_id: Types.ObjectId;
  cart_id: Types.ObjectId;
  agency_id: Types.ObjectId;
  currency: string;
  shipments: ICombinedRequestShipment[];
  /** The customer's optional message to the agency. */
  note: string | null;
  status: CombinedRequestStatus;
  answer: ICombinedRequestAnswer | null;
  /** The agency's reason on a decline. */
  decline_note: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const CombinedDeliveryRequestSchema = new Schema<ICombinedDeliveryRequest>(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    cart_id: { type: Schema.Types.ObjectId, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },
    shipments: {
      type: [
        new Schema<ICombinedRequestShipment>(
          {
            shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, required: true },
            order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
            vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
            fee_at_request: { type: Number, required: true, min: 0 },
          },
          { _id: false }
        ),
      ],
      required: true,
    },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    status: { type: String, enum: [...COMBINED_REQUEST_STATUSES], required: true, default: 'open' },
    answer: {
      type: new Schema<ICombinedRequestAnswer>(
        {
          fees: {
            type: [
              new Schema(
                {
                  shipment_id: { type: Schema.Types.ObjectId, required: true },
                  fee_before: { type: Number, required: true, min: 0 },
                  fee_after: { type: Number, required: true, min: 0 },
                  proposal_id: { type: Schema.Types.ObjectId, required: true },
                },
                { _id: false }
              ),
            ],
            default: [],
          },
          saving: { type: Number, required: true, min: 0 },
          note: { type: String, default: null, trim: true, maxlength: 500 },
          answered_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
          answered_at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    decline_note: { type: String, default: null, trim: true, maxlength: 500 },
    closed_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ── Indexes (built by `npm run migrate:delivery-fee-proposal-indexes`; keep in step) ──────────
CombinedDeliveryRequestSchema.index(
  { cart_id: 1, agency_id: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'combined_delivery_request_one_open_per_cart_agency' }
);
CombinedDeliveryRequestSchema.index({ agency_id: 1, status: 1, created_at: -1 }, { name: 'combined_delivery_request_agency_inbox' });
CombinedDeliveryRequestSchema.index({ customer_id: 1, cart_id: 1, created_at: -1 }, { name: 'combined_delivery_request_by_customer_cart' });

export const CombinedDeliveryRequestModel = mongoose.model<ICombinedDeliveryRequest>(
  MODELS.COMBINED_DELIVERY_REQUEST,
  CombinedDeliveryRequestSchema,
  COLLECTIONS.COMBINED_DELIVERY_REQUEST
);
