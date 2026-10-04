import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { GeoAddressSchema, IGeoAddress } from '../../core/types/geo-address.types';
import { ACTOR_SOURCES, ActorSource } from '../../core/types/actor-source.types';

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
 * "Unterminated" shipments for the billing/plan cap: every status except the
 * genuinely terminal ones (`delivered`/`returned`/`failed`) and `rejected` (a
 * rejected shipment has left this agency — its items are re-homed to a *new*
 * shipment on another agency). Used by the agency soft-cap sweep. Distinct from
 * `ACTIVE_SHIPMENT_STATUSES` (agent capacity) and `TRACKABLE_SHIPMENT_STATUSES`
 * (geo-tracker visibility) — those disagree on `pending`/`failed`.
 */
export const UNTERMINATED_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'pending',
  'assigned',
  'handing_over',
  'picked_up',
  'in_transit',
  'agent_delivered',
  'pending_agency_reassignment',
];

/**
 * Reason an agency declined an assigned shipment. Fixed set (mirrors
 * ProductSuspensionReason) so rejections can be reported/analysed, not free text.
 */
export type ShipmentRejectionReason =
  | 'out_of_coverage_area'
  | 'capacity_exceeded'
  | 'invalid_address'
  | 'vendor_item_not_ready'
  | 'platform_intervention'
  | 'other';

/**
 * The reason vocabulary, spread into the schema enum and the validator so the three
 * cannot drift — the rule `AGENT_CANCELLATION_REASONS` and `SHIPMENT_FAILURE_REASONS`
 * beside it already follow, and which the notification stacks paid for once by keeping
 * two copies that diverged.
 *
 * `platform_intervention` is the administrator's, and it is deliberately DISJOINT from
 * every agency-driven reason. Same argument as `ProductSuspensionReason`'s
 * `platform_oversight` (ADR-008): a reason an administrator owns must be tellable apart
 * from an agency's, or a later reader cannot distinguish "the agency could not carry
 * this" from "the platform pulled it". Folding it into `other` would erase exactly that.
 */
export const SHIPMENT_REJECTION_REASONS: ShipmentRejectionReason[] = [
  'out_of_coverage_area',
  'capacity_exceeded',
  'invalid_address',
  'vendor_item_not_ready',
  'platform_intervention',
  'other',
];

/**
 * Reason an ASSIGNED agent cancels a shipment mid-delivery (the agent-initiated
 * cancellation flow). Fixed enum so cancellations are reportable/analysable, with
 * a bounded free-text `note` (≤200 chars) for the specifics. Distinct from
 * `ShipmentRejectionReason`, which is the agency declining a shipment before an
 * agent ever took it — this is an agent walking away from one they had accepted.
 */
export type AgentCancellationReason =
  | 'vehicle_breakdown'
  | 'personal_emergency'
  | 'customer_unreachable'
  | 'address_not_found'
  | 'package_issue'
  | 'safety_concern'
  | 'too_far'
  | 'other';

export const AGENT_CANCELLATION_REASONS: AgentCancellationReason[] = [
  'vehicle_breakdown',
  'personal_emergency',
  'customer_unreachable',
  'address_not_found',
  'package_issue',
  'safety_concern',
  'too_far',
  'other',
];

/**
 * Why a delivery attempt did not complete, recorded by the AGENT when they set
 * `failed` or `returned` via POST /api/agent/shipments/:id/status. Optional — an
 * agent may report the outcome without choosing a reason.
 *
 * Deliberately NOT `AgentCancellationReason`, which it partly overlaps. That enum
 * is why an agent WALKS AWAY from a job — the shipment is released and re-offered
 * to someone else. This one is why THIS delivery attempt did not land, with the
 * shipment staying on the same agent. Offering `vehicle_breakdown` here would
 * invite an agent to strand a parcel at `failed` when they should have cancelled.
 */
export type ShipmentFailureReason =
  | 'customer_unreachable'
  | 'customer_absent'
  | 'customer_refused'
  | 'address_not_found'
  | 'address_inaccessible'
  /** COD only: the customer will not pay. */
  | 'payment_refused'
  | 'package_damaged'
  | 'rescheduled_by_customer'
  | 'other';

export const SHIPMENT_FAILURE_REASONS: ShipmentFailureReason[] = [
  'customer_unreachable',
  'customer_absent',
  'customer_refused',
  'address_not_found',
  'address_inaccessible',
  'payment_refused',
  'package_damaged',
  'rescheduled_by_customer',
  'other',
];

/**
 * The last agent-initiated cancellation on this shipment. Overwritten if the
 * shipment is cancelled again by a later agent (resume can hand it to a new
 * agent who also cancels); the durable per-cancellation audit is the emitted
 * `shipment.agent_cancelled` event + the agent-action audit in geo-tracker.
 */
export interface IShipmentAgentCancellation {
  reason: AgentCancellationReason;
  note: string | null;
  cancelled_by_agent_id: mongoose.Types.ObjectId;
  from_status: ShipmentStatus;
  cancelled_at: Date;
}

/**
 * ONE agent-reported non-delivery outcome. Stored as an APPEND-ONLY array on the
 * shipment, not an overwritten sub-doc like `agent_cancellation` above:
 * `failed → in_transit → failed → returned` is an allowed cycle, and each
 * attempt's reason is the operational record (two `customer_unreachable`
 * attempts then a return is a different story from one).
 *
 * The overwrite that `agent_cancellation` gets away with is justified there by
 * "the durable audit is the emitted event + geo-tracker". That does NOT hold
 * here — the event bus is in-memory with no persistence, and the geo-tracker
 * audit row carries only a free-text reason with no enum. This array IS the
 * durable record.
 *
 * `returned` entries live here too: a return is a delivery that did not happen.
 */
export interface IShipmentDeliveryFailure {
  /** Which outcome this entry records. */
  status: 'failed' | 'returned';
  /** Optional: an agent may report an outcome without choosing a reason. */
  reason: ShipmentFailureReason | null;
  /** Bounded free text (≤200), required by the validator when reason is 'other'. */
  note: string | null;
  /** The status the shipment was in when the agent reported this. */
  from_status: ShipmentStatus;
  reported_by_agent_id: mongoose.Types.ObjectId;
  reported_by_user_id: mongoose.Types.ObjectId | null;
  reported_at: Date;
}

export interface IShipmentItem {
  order_item_id: mongoose.Types.ObjectId;
  product_id: mongoose.Types.ObjectId;
  /**
   * The variant that actually shipped — the SELLABLE unit, and the thing stock
   * hangs off (`ProductVariant.stock`). Without it a delivered shipment cannot
   * say which variant left the shelf, which is what blocked decrementing stock
   * on delivery.
   *
   * **Nullable, and it stays that way.** Shipments written before this field
   * existed have none, and `ShipmentRepository.addItem` appends via a raw
   * `$push` that no schema default reaches — a `required: true` would reject
   * writes to historical shipments. Readers must treat null as "legacy" and fall
   * back to joining `order_item_id` against the order's items, which is what
   * every reader here already does for title/sku/variantTitle anyway.
   */
  variant_id: mongoose.Types.ObjectId | null;
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

/** The vendor-approved fee on one shipment — see `IShipment.delivery_fee_override`. */
export interface IShipmentDeliveryFeeOverride {
  amount: number;
  proposal_id: mongoose.Types.ObjectId;
  approved_at: Date;
}

/** `computeShipmentFee`'s itemisation, snapshotted at checkout — see `IShipment.fee_components`. */
export interface IShipmentFeeComponents {
  pickup_base: number;
  weight_extra: number;
  region_surcharge: number;
  storage: number;
  cap_applied: boolean;
  kg: number;
  weight_grams: number;
  out_of_region: boolean;
  /** True when the agency had no pricing policy and the flat fallback was charged. */
  flat_fallback: boolean;
}

/**
 * The two COD caps above the agent (see `cod/domain/cod-limits.ts`). Duplicated here as a
 * literal rather than imported so the shipment model does not depend on the cod module;
 * `test:cod-limits` asserts the two lists are equal.
 */
export const COD_LIMIT_KINDS = ['agency_limit', 'vendor_terms'] as const;
export type ShipmentCodLimitKind = (typeof COD_LIMIT_KINDS)[number];

export interface IShipmentCodLimitHold {
  kind: ShipmentCodLimitKind;
  /** The agency's (or the vendor's-share) exposure when evaluated. */
  current: number;
  /** This shipment's COD amount. */
  additional: number;
  limit: number;
  evaluated_at: Date;
}

export interface IShipmentCodLimitForce {
  kind: ShipmentCodLimitKind;
  /** The vendor's user id (or an administrator's, which resolves in wi-admin). */
  forced_by_user_id: string | null;
  forced_by_role: string;
  forced_at: Date;
  current: number;
  additional: number;
  limit: number;
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
  /**
   * The shipment's public handle — `ACR-YYMMDD-HHMMSS-XXXXX`, e.g.
   * `FDO-260730-142309-K7Q2M`.
   *
   * **Auto-generated and read-only.** It is stamped by
   * `TrackingNumberGenerator` inside `ShipmentRepository.create`, so every
   * shipment has one from the instant it exists, and there is no API that sets
   * or replaces it (the agency/agent PATCH endpoints that used to were removed
   * when it became generated — a handle a carrier can rewrite is not a handle).
   *
   * The `ACR` prefix is the owning agency's acronym, SNAPSHOTTED from its
   * Magazin business name at creation: an agency that renames itself keeps its
   * existing shipments' numbers, because a tracking number that changes is
   * worthless to the customer holding it.
   *
   * Nullable only for shipments written before generation existed — the
   * backfill script (`npm run backfill:shipment-tracking-numbers`) fills those
   * in, and the unique index below tolerates nulls so it can run gradually.
   */
  tracking_number?: string | null;
  // Set when the agency declines the assignment (status = 'rejected'). Keeps a
  // permanent record even after the affected items move to a new agency. `note`
  // is a free-text explanation — required when `reason` is 'other' (enforced by
  // the request validator), optional otherwise; null when none was given.
  rejection?: {
    reason: ShipmentRejectionReason;
    note?: string | null;
    rejectedAt: Date;
    rejectedBy: mongoose.Types.ObjectId;
    /** Which identity space `rejectedBy` resolves in. `admin` ids resolve nowhere here. */
    rejectedBySource?: ActorSource;
    /** Snapshot of who rejected it — the only record when the source is `admin`. */
    rejectedByName?: string | null;
  } | null;
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
  /**
   * Optional single delivery-proof image an agent may attach at/after the
   * delivery outcome (agent_delivered / delivered / failed). The File is owned by
   * the shipment's AGENCY (charged to the agency's media storage), not the agent
   * who uploaded it. Null until a proof is attached; replaced wholesale on
   * re-upload; cleared on delete. Referenced via file_references
   * (entityType 'shipment', field 'delivery_proof').
   */
  delivery_proof_file_id?: mongoose.Types.ObjectId | null;
  // Append-only status audit trail, feeding the multi-agency order timeline.
  status_history: IShipmentStatusHistoryEntry[];
  // Agent-acceptance workflow state (see IShipmentAssignmentInfo). Null/absent
  // on shipments predating the workflow — treat that as `unassigned`.
  assignment?: IShipmentAssignmentInfo | null;
  // Reassignment-handover collection point (see IShipmentHandover). Set when the
  // shipment is reassigned agent → agent; null otherwise.
  handover?: IShipmentHandover | null;
  // Last agent-initiated cancellation (see IShipmentAgentCancellation). Set when
  // an assigned agent cancels mid-delivery; null otherwise.
  agent_cancellation?: IShipmentAgentCancellation | null;
  // Append-only log of agent-reported non-delivery outcomes (see
  // IShipmentDeliveryFailure). Empty on shipments predating this field, and on
  // any shipment whose failures/returns were driven by the agency — the agency
  // status endpoint is deliberately reason-less.
  delivery_failures: IShipmentDeliveryFailure[];
  /**
   * The delivery fee (minor units) this shipment was quoted at, snapshotted at
   * the moment it was charged to the vendor.
   *
   * The fee itself is derived from the agency's `policies.pricing`, which the
   * agency may edit at any time — so for a PREPAID order, where the vendor's net
   * is reduced by the fee at payment but the agency and agent are not paid until
   * delivery, recomputing it later could divide a different number than the one
   * the vendor was charged. This field is the contract between the two moments:
   * `splitOrder` writes what it charged, `splitShipmentDelivery` divides exactly
   * that. COD writes it too (there it is computed once, at collection, so it
   * cannot drift) purely so the number is auditable — nothing else persists it.
   *
   * ⚠ Since ADR-A11 (2026-10-03) it is written AT CHECKOUT for every physical
   * shipment — the posted price the payer (vendor or customer) was quoted — and the
   * splits keep it (`computeShipmentDeliveryFee` reads override → this → formula).
   * Null only on shipments created before that and on shipments created after
   * checkout (an item moved to another agency); the delivery split then falls back
   * to a live computation and logs.
   */
  delivery_fee_snapshot?: number | null;
  /**
   * A per-shipment delivery fee the VENDOR approved (modules/delivery-fee-proposals),
   * replacing what the agency's `policies.pricing` formula would charge. Read by
   * `EarningsQuoteService.computeShipmentDeliveryFee` BEFORE the formula, so every consumer
   * of the fee — the prepaid and COD splits, the agent's and the agency's quotes — charges
   * the approved number. Null when no proposal was ever approved.
   *
   * ⚠ The 30% delivery-cost cap (ADR-A07) does NOT apply to it — only `vendorNet > 0`,
   * checked when the proposal is raised and again at approval.
   */
  delivery_fee_override?: IShipmentDeliveryFeeOverride | null;
  /**
   * The pending delivery-fee proposal on this shipment, or null. Set and cleared by
   * compare-and-set in the same transaction as the proposal's own write; the pickup
   * transition's CAS requires it null, which is what makes "no pickup while a fee change is
   * awaiting the vendor" a property of the write rather than of a read beforehand.
   */
  pending_delivery_fee_proposal_id?: mongoose.Types.ObjectId | null;
  /**
   * Who pays this shipment's delivery fee (ADR-A11), copied from its order at creation. `null`
   * on shipments before ADR-A11 — read as `vendor` (`orders/domain/delivery-payer.ts`).
   */
  delivery_payer?: 'vendor' | 'customer' | null;
  /**
   * What the CUSTOMER was charged for this run (ADR-A11): the checkout fee on a customer-paid
   * shipment, 0 on a vendor-paid one. Distinct from `delivery_fee_snapshot` (what the agency
   * is paid) on purpose — a fee change awaiting the customer's money must not make the split
   * read a number the customer has not paid. Customer-approved fee changes (W-E) move it.
   * Null on shipments created after checkout (an item moved to another agency) and on older ones.
   */
  customer_delivery_fee?: number | null;
  /**
   * The formula's itemisation at checkout, for display (base / weight / region / ceiling).
   * Informational only — no money path reads it; `delivery_fee_snapshot` is the number.
   */
  fee_components?: IShipmentFeeComponents | null;
  /**
   * Delivery-fee money the platform holds that is owed BACK to the customer (ADR-A11): the
   * unspent `reserved − earned` of a customer-paid return (RTO), plus anything the customer
   * paid above the fee finally charged. Written (idempotently, `$set`) by the earnings splits;
   * the refund itself is W-E's (customer-paid fee changes and refunds). 0 / absent = nothing owed.
   */
  customer_fee_refundable?: number | null;
  /**
   * Why this COD shipment was NOT handed to its agency (owner decision 2026-10-02).
   * Written by the vendor's auto-redirect when the hand-off would push the agency over
   * its own cash limit (`agency_limit`) or over the vendor's `maxCashPerAgency`
   * (`vendor_terms`); the shipment stays `pending` for the vendor to dispatch (with
   * `force`) once cash comes back. Cleared by any successful dispatch. `null` otherwise.
   */
  cod_limit_hold?: IShipmentCodLimitHold | null;
  /**
   * Who pushed this shipment past a COD limit with `force: true`, and which limit. The
   * record survives the hand-off; a second forced dispatch overwrites it. `null` when
   * no limit was ever overridden.
   */
  cod_limit_force?: IShipmentCodLimitForce | null;
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
  delivery_proof_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
  rejection: {
    type: {
      reason: {
        type: String,
        enum: SHIPMENT_REJECTION_REASONS,
        required: true,
      },
      note: { type: String, default: null, trim: true, maxlength: 200 },
      rejectedAt: { type: Date, required: true },
      rejectedBy: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
      // The actor stamp. `rejectedBy` is `ref: MODELS.USER`, but an administrator acting
      // through `/api/internal/admin` holds no `users` row — that id resolves to nothing
      // in this database. These two make the difference legible instead of looking like
      // a bug. See `core/types/actor-source.types.ts`.
      //
      // camelCase rather than `actorStampFields()`'s snake_case, deliberately: putting
      // `rejected_by_source` beside `rejectedBy` would be worse than the local casing
      // split. The RULE is still shared — the value comes from `actorSourceOfRole()`.
      rejectedBySource: { type: String, enum: ACTOR_SOURCES, default: 'platform' },
      rejectedByName: { type: String, default: null, trim: true, maxlength: 200 },
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
  agent_cancellation: {
    type: new Schema<IShipmentAgentCancellation>(
      {
        reason: {
          type: String,
          enum: AGENT_CANCELLATION_REASONS,
          required: true,
        },
        note: { type: String, default: null, trim: true, maxlength: 200 },
        cancelled_by_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
        from_status: { type: String, required: true },
        cancelled_at: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: null,
  },
  // Append-only — never cleared. A `failed → in_transit` retry writes nothing
  // and removes nothing, so `delivery_failures.length` is a truthful count of
  // reported non-delivery outcomes. `reason` is nullable-by-default rather than
  // required: Mongoose rejects an explicit null on a required enum, and an agent
  // may report an outcome without choosing a reason.
  delivery_failures: {
    type: [new Schema<IShipmentDeliveryFailure>(
      {
        status: { type: String, enum: ['failed', 'returned'], required: true },
        reason: { type: String, enum: SHIPMENT_FAILURE_REASONS, default: null },
        note: { type: String, default: null, trim: true, maxlength: 200 },
        from_status: { type: String, required: true },
        reported_by_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
        reported_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
        reported_at: { type: Date, required: true },
      },
      { _id: false }
    )],
    default: [],
  },
  delivery_fee_snapshot: { type: Number, default: null, min: 0 },
  delivery_fee_override: {
    type: new Schema<IShipmentDeliveryFeeOverride>(
      {
        amount: { type: Number, required: true, min: 0 },
        proposal_id: { type: Schema.Types.ObjectId, required: true },
        approved_at: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: null,
  },
  // No index: read only by id. See IShipment.pending_delivery_fee_proposal_id.
  pending_delivery_fee_proposal_id: { type: Schema.Types.ObjectId, default: null },
  // Customer-paid delivery (ADR-A11) — see IShipment. No index: read with the shipment.
  delivery_payer: { type: String, enum: ['vendor', 'customer', null], default: null },
  customer_delivery_fee: { type: Number, default: null, min: 0 },
  fee_components: {
    type: new Schema<IShipmentFeeComponents>(
      {
        pickup_base: { type: Number, default: 0 },
        weight_extra: { type: Number, default: 0 },
        region_surcharge: { type: Number, default: 0 },
        storage: { type: Number, default: 0 },
        cap_applied: { type: Boolean, default: false },
        kg: { type: Number, default: 1 },
        weight_grams: { type: Number, default: 0 },
        out_of_region: { type: Boolean, default: false },
        flat_fallback: { type: Boolean, default: false },
      },
      { _id: false }
    ),
    default: null,
  },
  customer_fee_refundable: { type: Number, default: null, min: 0 },
  // COD limits above the agent (2026-10-02) — see IShipment.cod_limit_hold / cod_limit_force.
  // No index: read with the shipment, never queried on.
  cod_limit_hold: {
    type: new Schema<IShipmentCodLimitHold>(
      {
        kind: { type: String, enum: COD_LIMIT_KINDS, required: true },
        current: { type: Number, required: true },
        additional: { type: Number, required: true },
        limit: { type: Number, required: true },
        evaluated_at: { type: Date, required: true },
      },
      { _id: false }
    ),
    default: null,
  },
  cod_limit_force: {
    type: new Schema<IShipmentCodLimitForce>(
      {
        kind: { type: String, enum: COD_LIMIT_KINDS, required: true },
        forced_by_user_id: { type: String, default: null },
        forced_by_role: { type: String, required: true },
        forced_at: { type: Date, required: true },
        current: { type: Number, required: true },
        additional: { type: Number, required: true },
        limit: { type: Number, required: true },
      },
      { _id: false }
    ),
    default: null,
  },
  items: [{
    order_item_id: { type: Schema.Types.ObjectId, required: true },
    product_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true },
    // Nullable by design — see IShipmentItem. Legacy rows carry none.
    variant_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_VARIANT, default: null },
    quantity: { type: Number, required: true }
  }]
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// ── Indexes ────────────────────────────────────────────────────────────────
// The Shipment collection previously carried no indexes; every dispatch/agent
// query scanned. These back the hot access patterns:
//   • the agency dispatch board + auto-assignment candidate lookups (by agency
//     and status), • an agent's work queue (by agent and status), • and the
//     order → shipments join used all over the order/fulfillment code.
ShipmentSchema.index({ agency_id: 1, status: 1 });
ShipmentSchema.index({ agent_id: 1, status: 1 });
ShipmentSchema.index({ order_id: 1 });
// The tracking number is a public handle quoted by customers and support, so it
// must resolve to exactly one shipment. PARTIAL rather than plainly unique:
// legacy shipments carry `null`, and a plain unique index treats every null as
// the same value — it would refuse to build on any existing database. The
// generator pre-checks candidates, but this is what actually guarantees it.
ShipmentSchema.index(
  { tracking_number: 1 },
  { unique: true, partialFilterExpression: { tracking_number: { $type: 'string' } } }
);

// ── Platform-wide administrative oversight ──────────────────────────────────
// wi-admin's `/api/v1/shipments` is the first surface to query this collection without an
// agency or agent scope. The two `{x, status}` indexes above stay: they serve the dispatch
// board's status-equality queries, and folding `created_at` into them would not serve an
// agency filter WITHOUT a status, which is exactly the administrative case.
//
// Four more B-trees on a hot write collection is a real cost, taken deliberately. The
// alternative is a platform-wide list that blocking-sorts the whole collection per page.
ShipmentSchema.index({ created_at: -1 });                 // the unfiltered admin list
ShipmentSchema.index({ status: 1, created_at: -1 });      // status filter + default sort
ShipmentSchema.index({ agency_id: 1, created_at: -1 });   // one agency's, newest first
ShipmentSchema.index({ agent_id: 1, created_at: -1 });    // one agent's, newest first

// No index is added for the tracking-number search: wi-admin anchors that regex (`^`) and
// leaves it case-SENSITIVE precisely so the partial-unique index above serves it. An
// unanchored, case-insensitive `contains` there would silently be the scan these indexes
// exist to avoid.

export const ShipmentModel = mongoose.model<IShipment>(MODELS.SHIPMENT, ShipmentSchema, COLLECTIONS.SHIPMENT);
