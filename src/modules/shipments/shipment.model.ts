import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { GeoAddressSchema, IGeoAddress } from '../../core/types/geo-address.types';

// `handing_over` is the post-pickup reassignment state: an agent had picked the
// parcel up but could not deliver it, so the shipment was pulled off them and is
// awaiting a replacement agent to take over. It is trackable (the replacement is
// tracked once they accept) and non-terminal — it ends only when the new agent
// picks the item up (`handing_over` → `picked_up`) or the handover is returned.
export type ShipmentStatus =
  | 'pending'
  | 'assigned'
  | 'handing_over'
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

/**
 * Where this shipment is in the agent-acceptance workflow. This is NOT the
 * shipment `status` (which is the cross-service contract shared with
 * geo-tracker) — it is a lightweight mirror so agency dashboards can tell a
 * shipment awaiting an agent's answer apart from one nobody has offered yet,
 * without joining the offers collection.
 *
 *   unassigned — no live offer; sitting in the agency queue for someone to place
 *   offered    — a pending offer is out with an agent (see current_offer_id)
 *   accepted   — an agent accepted; `agent_id` is now set (the real binding)
 *
 * The authoritative record is always the shipment_assignment_offers rows +
 * `agent_id`; this field is a derived convenience and is kept in step with them.
 */
export type ShipmentAssignmentState = 'unassigned' | 'offered' | 'accepted';

export interface IShipmentAssignmentInfo {
  state: ShipmentAssignmentState;
  /** The pending offer, while `state === 'offered'`; null otherwise. */
  current_offer_id: mongoose.Types.ObjectId | null;
  /** The agent an offer is currently out to (offered) or was accepted by. */
  offered_agent_id: mongoose.Types.ObjectId | null;
  updated_at: Date;
}

export interface IShipmentStatusHistoryEntry {
  status: ShipmentStatus;
  changed_at: Date;
  changed_by_user_id: mongoose.Types.ObjectId | null;
  changed_by_role: string;
}

/**
 * Where a replacement agent collects a reassigned shipment. Set on the shipment
 * (and mirrored onto the offer) when a shipment is reassigned agent → agent. The
 * source records HOW the point was chosen so the app can label it:
 *
 *   previous_agent_location — the old agent's last known position (the expected
 *                             handover point; picked_up / in_transit reassignment)
 *   original_pickup         — the shipment's original pickup (returned reassignment:
 *                             vendor business address or agency warehouse)
 *   agency_business         — the responsible agency's HQ (failed reassignment)
 *   manual                  — the agency overrode the automatic default
 *
 * `location` is the coordinate (always present for `previous_agent_location` and
 * whenever the chosen address is geolocated); `address` is the human-readable
 * address when known. At least one of the two is populated.
 */
export type HandoverPickupSource =
  | 'previous_agent_location'
  | 'original_pickup'
  | 'agency_business'
  | 'manual';

export interface IShipmentHandoverPickupAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface IShipmentHandoverPickup {
  source: HandoverPickupSource;
  /** Human label for the point ("Handover with Jean", "FastShip HQ — Akwa"). */
  label: string | null;
  address: IShipmentHandoverPickupAddress | null;
  location: IGeoPoint | null;
  /**
   * Full geocoded address when the collection point is a known geocoded place
   * (original vendor pickup, agency HQ). Null when the point is only a raw
   * coordinate (e.g. the previous agent's last position) or a loose manual entry.
   * When present, `geo.coordinates` supersedes `location`.
   */
  geo: IGeoAddress | null;
  /** Optional free-text instruction from the agency (e.g. "call on arrival"). */
  note: string | null;
  /** True when the automatic default could not be resolved and a fallback was used. */
  is_fallback: boolean;
}

/**
 * The reassignment-handover record: set when a shipment is moved from one agent
 * to another, capturing where the replacement collects it and who/what it came
 * from. Distinct from the per-item `pickup_location` snapshot on the order — this
 * is the ONE collection point for the whole reassigned shipment.
 */
export interface IShipmentHandover {
  pickup: IShipmentHandoverPickup;
  from_agent_id: mongoose.Types.ObjectId | null;
  from_status: ShipmentStatus;
  reassigned_at: Date;
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
  // permanent record even after the affected items move to a new agency. `note`
  // is a free-text explanation — required when `reason` is 'other' (enforced by
  // the request validator), optional otherwise; null when none was given.
  rejection?: { reason: ShipmentRejectionReason; note?: string | null; rejectedAt: Date; rejectedBy: mongoose.Types.ObjectId } | null;
  /**
   * Per-shipment customer delivery confirmation — the analogue of
   * `Order.completion`, scoped to this one shipment. Set once the customer
   * confirms THIS shipment arrived (status moves agent_delivered → delivered).
   * An order with several shipments (multi-agency) requires every shipment to
   * carry its own confirmation before the order itself can be 'delivered'.
   *
   * `auto` mirrors `Order.completion.auto`: the confirmation window elapsed and
   * the sweep confirmed on the customer's behalf, so `confirmed_by` is null.
   * Without that distinction a lapsed window would be indistinguishable from a
   * customer who actually looked at the parcel and said yes — which is exactly
   * the evidence a delivery dispute turns on.
   */
  customer_confirmation?: {
    confirmed_at: Date;
    confirmed_by: mongoose.Types.ObjectId | null;
    auto: boolean;
  } | null;
  // Append-only status audit trail, feeding the multi-agency order timeline.
  status_history: IShipmentStatusHistoryEntry[];
  // Agent-acceptance workflow state (see IShipmentAssignmentInfo). Null/absent
  // on shipments predating the workflow — treat that as `unassigned`.
  assignment?: IShipmentAssignmentInfo | null;
  // Reassignment-handover collection point (see IShipmentHandover). Set when the
  // shipment is reassigned agent → agent; null otherwise.
  handover?: IShipmentHandover | null;
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
    enum: ['pending', 'assigned', 'handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment'],
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
      note: { type: String, default: null, trim: true, maxlength: 200 },
      rejectedAt: { type: Date, required: true },
      rejectedBy: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    },
    required: false,
    default: null,
  },
  customer_confirmation: {
    type: {
      confirmed_at: { type: Date, required: true },
      // null when auto-confirmed: nobody clicked.
      confirmed_by: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
      auto: { type: Boolean, required: true, default: false },
    },
    required: false,
    default: null,
  },
  status_history: {
    type: [{
      status: {
        type: String,
        enum: ['pending', 'assigned', 'handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'failed', 'returned', 'rejected', 'pending_agency_reassignment'],
        required: true,
      },
      changed_at: { type: Date, required: true },
      changed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
      changed_by_role: { type: String, required: true },
    }],
    default: [],
  },
  assignment: {
    type: new Schema<IShipmentAssignmentInfo>(
      {
        state: {
          type: String,
          enum: ['unassigned', 'offered', 'accepted'],
          required: true,
          default: 'unassigned',
        },
        current_offer_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT_ASSIGNMENT_OFFER, default: null },
        offered_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
        updated_at: { type: Date, default: Date.now },
      },
      { _id: false }
    ),
    default: null,
  },
  handover: {
    type: new Schema<IShipmentHandover>(
      {
        pickup: {
          type: new Schema<IShipmentHandoverPickup>(
            {
              source: {
                type: String,
                enum: ['previous_agent_location', 'original_pickup', 'agency_business', 'manual'],
                required: true,
              },
              label: { type: String, default: null, trim: true },
              address: {
                type: new Schema<IShipmentHandoverPickupAddress>(
                  {
                    line1: { type: String, default: null, trim: true },
                    line2: { type: String, default: null, trim: true },
                    city: { type: String, default: null, trim: true },
                    state: { type: String, default: null, trim: true },
                    country: { type: String, default: null, trim: true },
                  },
                  { _id: false }
                ),
                default: null,
              },
              location: { type: GeoPointSchema, default: null },
              geo: { type: GeoAddressSchema, default: null },
              note: { type: String, default: null, trim: true, maxlength: 500 },
              is_fallback: { type: Boolean, default: false },
            },
            { _id: false }
          ),
          required: true,
        },
        from_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
        from_status: { type: String, required: true },
        reassigned_at: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: null,
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
