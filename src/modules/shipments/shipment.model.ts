import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

export type ShipmentStatus =
  | 'pending'
  | 'assigned'
  | 'picked_up'
  | 'in_transit'
  | 'agent_delivered'
  | 'delivered'
  | 'failed'
  | 'returned'
  | 'rejected'
  | 'pending_agency_reassignment';

/**
 * Reason an agency declined an assigned shipment. Fixed set (mirrors
 * ProductSuspensionReason) so rejections can be reported/analysed, not free text.
 */
export type ShipmentRejectionReason =
  | 'out_of_coverage_area'
  | 'capacity_exceeded'
  | 'invalid_address'
  | 'vendor_item_not_ready'
  | 'other';

export interface IShipmentItem {
  order_item_id: mongoose.Types.ObjectId;
  product_id: mongoose.Types.ObjectId;
  quantity: number;
}

export interface IShipmentStatusHistoryEntry {
  status: ShipmentStatus;
  changed_at: Date;
  changed_by_user_id: mongoose.Types.ObjectId | null;
  changed_by_role: string;
}

export interface IShipment extends Document {
  order_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  agent_id?: mongoose.Types.ObjectId | null;
  status: ShipmentStatus;
  /**
   * Set when `status` is forced to 'pending_agency_reassignment' because the
   * agency went inactive with no replacement configured yet. Snapshots the
   * shipment's own prior status (independent of its items) so it resumes
   * exactly, whether via unhold (same agency came back) or reassignment.
   */
  hold?: { previousStatus: 'pending' | 'assigned'; heldAt: Date } | null;
  // Carrier tracking number, set by the delivery agency/agent handling the
  // shipment. Null until the shipment is dispatched and a number is recorded.
  tracking_number?: string | null;
  // Set when the agency declines the assignment (status = 'rejected'). Keeps a
  // permanent record even after the affected items move to a new agency.
  rejection?: { reason: ShipmentRejectionReason; rejectedAt: Date; rejectedBy: mongoose.Types.ObjectId } | null;
  /**
   * Per-shipment customer delivery confirmation — the analogue of
   * `Order.completion`, scoped to this one shipment. Set once the customer
   * confirms THIS shipment arrived (status moves agent_delivered → delivered).
   * An order with several shipments (multi-agency) requires every shipment to
   * carry its own confirmation before the order itself can be 'delivered'.
   */
  customer_confirmation?: { confirmed_at: Date; confirmed_by: mongoose.Types.ObjectId } | null;
  // Append-only status audit trail, feeding the multi-agency order timeline.
  status_history: IShipmentStatusHistoryEntry[];
  items: IShipmentItem[];
  created_at: Date;
  updated_at: Date;
}

const ShipmentSchema = new Schema<IShipment>({
  order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
  agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
  agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
  status: {
    type: String,
    enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment'],
    default: 'pending'
  },
  hold: {
    type: {
      previousStatus: { type: String, enum: ['pending', 'assigned'], required: true },
      heldAt: { type: Date, required: true },
    },
    required: false,
    default: null,
  },
  tracking_number: { type: String, default: null, trim: true },
  rejection: {
    type: {
      reason: {
        type: String,
        enum: ['out_of_coverage_area', 'capacity_exceeded', 'invalid_address', 'vendor_item_not_ready', 'other'],
        required: true,
      },
      rejectedAt: { type: Date, required: true },
      rejectedBy: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    },
    required: false,
    default: null,
  },
  customer_confirmation: {
    type: {
      confirmed_at: { type: Date, required: true },
      confirmed_by: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    },
    required: false,
    default: null,
  },
  status_history: {
    type: [{
      status: {
        type: String,
        enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment'],
        required: true,
      },
      changed_at: { type: Date, required: true },
      changed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
      changed_by_role: { type: String, required: true },
    }],
    default: [],
  },
  items: [{
    order_item_id: { type: Schema.Types.ObjectId, required: true },
    product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
    quantity: { type: Number, required: true }
  }]
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

export const ShipmentModel = mongoose.model<IShipment>(MODELS.SHIPMENT, ShipmentSchema, COLLECTIONS.SHIPMENT);
