import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../../core/types/geo.types';
import { AgentOnboardingStep } from '../../../core/constants/onboarding-steps';
import { SUPPORTED_LANGUAGES, Language } from '../../../core/constants/languages';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PayoutMethodSchema, IPayoutMethod } from '../../../core/types/payout.types';
import { AGENT_CONFIG } from '../config/agent.config';

/**
 * DeliveryAgent — the person who physically moves packages.
 *
 * The agent is a platform-level identity, NOT an agency-owned record: an agent
 * signs up independently and may serve several agencies at once. Everything
 * agency-scoped (employment terms, COD exposure caps, approval state) lives on
 * AgentAgencyMembership, never here. If a field would have a different value
 * per agency, it belongs on the membership.
 *
 * Four distinct state axes are deliberately kept apart, because they answer
 * different questions and are written by different actors:
 *
 *   status          — is this account allowed to exist and work?   (admin)
 *   availability    — does the agent want work right now?          (agent)
 *   working_state   — how loaded is the agent right now?           (system, derived)
 *   tracking        — is this agent permitted to be tracked?       (admin/agency)
 *
 * Collapsing any two of these (as the old `live_state.current_capacity_status`
 * did with availability + load) makes it impossible to answer "is he offline,
 * or just full?" — which the assignment rules need to distinguish.
 */

// ─── Vehicle Info Sub-Schema ──────────────────────────────────────────────────

const VehicleInfoSchema = new Schema(
  {
    vehicle_type: {
      type: String,
      required: true,
      enum: ['bike', 'car', 'van', 'truck'],
    },
    plate_number: { type: String, default: null, trim: true },
    color: { type: String, required: true, trim: true },
  },
  { _id: false }
);

// ─── Legal Identity Sub-Schema ────────────────────────────────────────────────

const LegalIdentitySchema = new Schema(
  {
    drivers_license_number: { type: String, default: null, trim: true },
    national_id_number: { type: String, default: null, trim: true },
  },
  { _id: false }
);

// ─── Emergency Contact Sub-Schema ─────────────────────────────────────────────

const EmergencyContactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
  },
  { _id: false }
);

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus = 'pending_verification' | 'active' | 'inactive' | 'suspended';
export type AgentAvailabilityState = 'online' | 'offline' | 'on_break';
export type AgentWorkingState = 'idle' | 'working' | 'at_capacity';
export type AgentDevicePlatform = 'android' | 'ios' | 'web' | 'unknown';
export type AgentLocationPermission = 'always' | 'while_in_use' | 'denied' | 'unknown';
export type AgentTrackingStateStatus = 'unknown' | 'streaming' | 'stale' | 'disconnected';

export interface IAgentVehicleInfo {
  vehicle_type: 'bike' | 'car' | 'van' | 'truck';
  plate_number: string | null;
  color: string;
}

export interface IAgentLegalIdentity {
  drivers_license_number: string | null;
  national_id_number: string | null;
}

export interface IAgentEmergencyContact {
  name: string;
  phone: string;
}

/** The agent's own declared intent to receive work. Written by the agent. */
export interface IAgentAvailability {
  state: AgentAvailabilityState;
  changed_at: Date;
  /** Free-text note for on_break/offline (e.g. "lunch"). */
  reason: string | null;
}

/** Derived load. Written by the system after shipment assignment/settlement. */
export interface IAgentWorkingState {
  state: AgentWorkingState;
  /** Count of shipments currently in flight. An agent MAY hold several. */
  active_shipment_count: number;
  computed_at: Date;
}

/**
 * The tracking permission flag. jovi-mall owns whether tracking is ALLOWED;
 * geo-tracker owns tracking EXECUTION and merely enforces this.
 */
export interface IAgentTracking {
  allowed: boolean;
  reason: string | null;
  changed_at: Date;
  changed_by_user_id: mongoose.Types.ObjectId | null;
  changed_by_role: string | null;
}

/**
 * What the agent's device can do. Self-reported by the mobile app, and
 * (for location) corroborated by geo-tracker once wired.
 */
export interface IAgentDeviceCapabilities {
  platform: AgentDevicePlatform;
  app_version: string | null;
  location_permission: AgentLocationPermission;
  /** null = never reported. Distinct from false = reported as disabled. */
  location_services_enabled: boolean | null;
  background_location_enabled: boolean | null;
  battery_optimization_exempt: boolean | null;
  push_enabled: boolean | null;
  reported_at: Date | null;
}

/**
 * Business-reference mirror of what geo-tracker last observed.
 *
 * NOT a source of truth and never to be treated as one: geo-tracker owns live
 * position and liveness. This exists so business screens and assignment rules
 * can reason coarsely ("has this agent ever streamed?") without a synchronous
 * call to geo-tracker, and so the data survives a geo-tracker outage.
 */
export interface IAgentLastKnownTrackingState {
  status: AgentTrackingStateStatus;
  last_position: IGeoPoint | null;
  last_reported_at: Date | null;
  /** Which component reported this. Only geo-tracker writes it today. */
  source: string | null;
}

/** Agent-chosen preferences. */
export interface IAgentPreferences {
  notify_on_assignment: boolean;
  notify_on_shipment_update: boolean;
  /** Preferred navigation app deep-link target. */
  navigation_app: 'google_maps' | 'waze' | 'apple_maps' | 'none';
}

/** Operational configuration that affects dispatch. */
export interface IAgentSettings {
  /** Reserved for future auto-dispatch; assignment is agency-driven today. */
  auto_accept_assignments: boolean;
}

/**
 * Concurrent-shipment capacity.
 *
 * Unlike the COD threshold (which is a pool sub-allocated per contract),
 * capacity is a SINGLE agent-level cap shared across every agency. There is no
 * agency-side capacity allocation: an agent full with agency A's work simply
 * cannot absorb agency B's, because there is one agent and one vehicle.
 *
 * `active_shipment_count` is a maintained counter rather than a derived count.
 * That is a deliberate reversal of the earlier design: only a counter can be
 * atomically checked-and-incremented in one operation, which is what stops two
 * concurrent assignments both reading "capacity available" and over-committing
 * the agent. The cost is drift, which `reconcileCapacity` corrects from the
 * shipment collection — see AgentCapacityService.
 */
export interface IAgentCapacity {
  /** Bounded by AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_{MIN,MAX}. Agent-settable. */
  max_active_shipments: number;
  /** Shipments currently in flight, across ALL agencies. Never negative. */
  active_shipment_count: number;
  /** Last time the counter was reconciled against actual shipments. */
  reconciled_at: Date | null;
}

export interface IAgentCodProfile {
  /**
   * 0–100. Platform-wide agent trust — deliberately NOT per-agency: the agent
   * holds one pot of cash regardless of who dispatched it, so trust follows
   * the person.
   *
   * This is now a COMPOSITE, recomputed nightly from the five factors in
   * `trust_signals` (see AgentTrustService). It is no longer a running balance
   * that penalty events mutate directly — CodTrustEvent remains the append-only
   * signal log, and its penalty history feeds the COD factor rather than
   * writing the score. Anything that writes this field outside
   * AgentTrustService will be overwritten at the next recompute.
   */
  trust_score: number;
  /**
   * The agent's GLOBAL COD threshold: the maximum cash-in-hand they may hold
   * across every agency combined. Set by the agent, bounded by
   * AGENT_CONFIG.COD_THRESHOLD_{MIN,MAX}.
   *
   * Every contract's `cod.threshold` is a sub-allocation of this pool, and the
   * sum across allocating contracts may never exceed it. See
   * AgentCodThresholdService — the constraint is enforced from both directions
   * (agent lowering, agency raising).
   */
  max_threshold: number;
}

/** KYC / identity verification — a platform-wide gate, not an agency's call. */
export type AgentKycStatus = 'unverified' | 'pending' | 'verified' | 'rejected';

export interface IAgentKyc {
  status: AgentKycStatus;
  verified_at: Date | null;
  verified_by_user_id: mongoose.Types.ObjectId | null;
  rejection_reason: string | null;
  /** Free-form reference to whatever document set was checked, off-platform. */
  reference: string | null;
}

/**
 * Platform-wide suspension. Distinct from a per-contract pause/suspend: this is
 * the platform removing the person, and it overrides every contract at once
 * rather than requiring each to be paused individually.
 */
export interface IAgentPlatformBan {
  banned: boolean;
  reason: string | null;
  banned_at: Date | null;
  banned_by_user_id: mongoose.Types.ObjectId | null;
}

/**
 * Payout details — where the PLATFORM sends the agent's money.
 *
 * The same `IPayoutMethod[]` shape vendors and agencies use, and deliberately
 * so: the agent is a first-class payout owner, earning an `owner_type: 'agent'`
 * allocation out of the delivery fee and withdrawing it through the ordinary
 * payout pipeline. That pipeline snapshots an `IPayoutMethod` onto every
 * PayoutRequest, so a bespoke agent-shaped record would only have to be
 * translated — and translated lossily, since it carries no bank `country`.
 *
 * (This field previously described where the *agency* sent the agent's money,
 * from a period when agencies were assumed to pay their agents off-platform.)
 *
 * Ordered; the FIRST entry is the preferred method. Empty until the agent adds
 * one — a payout request with no method is refused rather than guessed at.
 *
 * SENSITIVE. Mirrors the treatment of existing financial fields: never exposed
 * by the agent profile DTO (like legal_identity), only through the dedicated
 * payout endpoint, and account numbers are masked on read.
 */
export type IAgentPayoutDetails = IPayoutMethod[];

/**
 * The agent's own operating area, independent of any contract. A contract's
 * coverage (agency-set) must fall INSIDE this — an agency cannot grant an agent
 * coverage the agent never agreed to work.
 */
export interface IAgentHomeBase {
  location: IGeoPoint | null;
  /** How far from home base the agent will operate, in kilometres. */
  service_radius_km: number | null;
  /** Human label for support/ops ("Douala — Akwa"). */
  label: string | null;
}

/**
 * Raw signals behind the composite trust score.
 *
 * Stored rather than computed on read because they aggregate across modules
 * (ratings, shipments, COD settlements) that no single query spans, and the
 * score recomputes nightly rather than per-request. Each rating factor carries
 * its observation count so a single review cannot define a reputation.
 */
export interface IAgentTrustSignals {
  /** On-time pickup/delivery rate, 0–1. */
  on_time_rate: number | null;
  /** Assignments accepted vs offered, 0–1. */
  assignment_response_rate: number | null;
  completed_shipments: number;

  customer_rating_avg: number | null;
  customer_rating_count: number;
  agency_rating_avg: number | null;
  agency_rating_count: number;
  vendor_rating_avg: number | null;
  vendor_rating_count: number;

  /** COD settled with no discrepancy vs total settlements. */
  cod_clean_return_count: number;
  cod_discrepancy_count: number;
  /** Lifetime cash handled and returned cleanly (minor units) — scale matters. */
  cod_volume_returned: number;

  computed_at: Date | null;
}

export interface IDeliveryAgent extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  name: string;
  avatar_url: string | null;
  vehicle_info: IAgentVehicleInfo | null;
  legal_identity: IAgentLegalIdentity;
  emergency_contact: IAgentEmergencyContact | null;
  cod: IAgentCodProfile;
  capacity: IAgentCapacity;
  kyc: IAgentKyc;
  platform_ban: IAgentPlatformBan;
  payout_details: IAgentPayoutDetails;
  home_base: IAgentHomeBase;
  trust_signals: IAgentTrustSignals;
  availability: IAgentAvailability;
  working_state: IAgentWorkingState;
  tracking: IAgentTracking;
  device: IAgentDeviceCapabilities;
  last_known_tracking_state: IAgentLastKnownTrackingState;
  preferences: IAgentPreferences;
  settings: IAgentSettings;
  wa?: {
    name?: string;
    wa_phone_id?: string;
    verified: boolean;
    bound_at?: Date;
    last_seen_at?: Date;
  };
  timezone: string;
  /** Preferred language for notifications/messaging (ISO 639-1). */
  preferred_language: Language;
  /** Account lifecycle. Only `active` may be assigned work. */
  status: AgentStatus;
  /** Why the account was suspended/deactivated (admin action). */
  status_reason: string | null;
  /**
   * Onboarding progress. See AgentOnboardingStep constants.
   * Recalculated from field presence after every write.
   */
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const AvailabilitySchema = new Schema(
  {
    state: { type: String, enum: ['online', 'offline', 'on_break'], default: 'offline', required: true },
    changed_at: { type: Date, default: Date.now, required: true },
    reason: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const WorkingStateSchema = new Schema(
  {
    state: { type: String, enum: ['idle', 'working', 'at_capacity'], default: 'idle', required: true },
    active_shipment_count: { type: Number, default: 0, min: 0, required: true },
    computed_at: { type: Date, default: Date.now, required: true },
  },
  { _id: false }
);

const TrackingSchema = new Schema(
  {
    allowed: { type: Boolean, default: AGENT_CONFIG.TRACKING_ALLOWED_BY_DEFAULT, required: true },
    reason: { type: String, default: null, trim: true },
    changed_at: { type: Date, default: Date.now, required: true },
    changed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    changed_by_role: { type: String, default: null },
  },
  { _id: false }
);

const CapacitySchema = new Schema(
  {
    max_active_shipments: {
      type: Number,
      default: AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_DEFAULT,
      min: AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MIN,
      max: AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX,
      required: true,
    },
    active_shipment_count: { type: Number, default: 0, min: 0, required: true },
    reconciled_at: { type: Date, default: null },
  },
  { _id: false }
);

const KycSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['unverified', 'pending', 'verified', 'rejected'],
      default: 'unverified',
      required: true,
    },
    verified_at: { type: Date, default: null },
    verified_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    rejection_reason: { type: String, default: null, trim: true },
    reference: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const PlatformBanSchema = new Schema(
  {
    banned: { type: Boolean, default: false, required: true },
    reason: { type: String, default: null, trim: true },
    banned_at: { type: Date, default: null },
    banned_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
  },
  { _id: false }
);

const HomeBaseSchema = new Schema(
  {
    location: { type: GeoPointSchema, default: null },
    service_radius_km: { type: Number, default: null, min: 0 },
    label: { type: String, default: null, trim: true },
  },
  { _id: false }
);

const TrustSignalsSchema = new Schema(
  {
    on_time_rate: { type: Number, default: null, min: 0, max: 1 },
    assignment_response_rate: { type: Number, default: null, min: 0, max: 1 },
    completed_shipments: { type: Number, default: 0, min: 0 },
    customer_rating_avg: { type: Number, default: null, min: 0, max: 5 },
    customer_rating_count: { type: Number, default: 0, min: 0 },
    agency_rating_avg: { type: Number, default: null, min: 0, max: 5 },
    agency_rating_count: { type: Number, default: 0, min: 0 },
    vendor_rating_avg: { type: Number, default: null, min: 0, max: 5 },
    vendor_rating_count: { type: Number, default: 0, min: 0 },
    cod_clean_return_count: { type: Number, default: 0, min: 0 },
    cod_discrepancy_count: { type: Number, default: 0, min: 0 },
    cod_volume_returned: { type: Number, default: 0, min: 0 },
    computed_at: { type: Date, default: null },
  },
  { _id: false }
);

const DeviceCapabilitiesSchema = new Schema(
  {
    platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], default: 'unknown', required: true },
    app_version: { type: String, default: null, trim: true },
    location_permission: {
      type: String,
      enum: ['always', 'while_in_use', 'denied', 'unknown'],
      default: 'unknown',
      required: true,
    },
    location_services_enabled: { type: Boolean, default: null },
    background_location_enabled: { type: Boolean, default: null },
    battery_optimization_exempt: { type: Boolean, default: null },
    push_enabled: { type: Boolean, default: null },
    reported_at: { type: Date, default: null },
  },
  { _id: false }
);

const LastKnownTrackingStateSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['unknown', 'streaming', 'stale', 'disconnected'],
      default: 'unknown',
      required: true,
    },
    last_position: { type: GeoPointSchema, default: null },
    last_reported_at: { type: Date, default: null },
    source: { type: String, default: null },
  },
  { _id: false }
);

const PreferencesSchema = new Schema(
  {
    notify_on_assignment: { type: Boolean, default: true, required: true },
    notify_on_shipment_update: { type: Boolean, default: true, required: true },
    navigation_app: {
      type: String,
      enum: ['google_maps', 'waze', 'apple_maps', 'none'],
      default: 'google_maps',
      required: true,
    },
  },
  { _id: false }
);

const SettingsSchema = new Schema(
  {
    auto_accept_assignments: { type: Boolean, default: false, required: true },
  },
  { _id: false }
);

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const agentDefaults = {
  availability: (): IAgentAvailability => ({ state: 'offline', changed_at: new Date(), reason: null }),
  workingState: (): IAgentWorkingState => ({ state: 'idle', active_shipment_count: 0, computed_at: new Date() }),
  tracking: (): IAgentTracking => ({
    allowed: AGENT_CONFIG.TRACKING_ALLOWED_BY_DEFAULT,
    reason: null,
    changed_at: new Date(),
    changed_by_user_id: null,
    changed_by_role: null,
  }),
  device: (): IAgentDeviceCapabilities => ({
    platform: 'unknown',
    app_version: null,
    location_permission: 'unknown',
    location_services_enabled: null,
    background_location_enabled: null,
    battery_optimization_exempt: null,
    push_enabled: null,
    reported_at: null,
  }),
  lastKnownTrackingState: (): IAgentLastKnownTrackingState => ({
    status: 'unknown',
    last_position: null,
    last_reported_at: null,
    source: null,
  }),
  preferences: (): IAgentPreferences => ({
    notify_on_assignment: true,
    notify_on_shipment_update: true,
    navigation_app: 'google_maps',
  }),
  settings: (): IAgentSettings => ({
    auto_accept_assignments: false,
  }),
  capacity: (): IAgentCapacity => ({
    max_active_shipments: AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_DEFAULT,
    active_shipment_count: 0,
    reconciled_at: null,
  }),
  kyc: (): IAgentKyc => ({
    status: 'unverified',
    verified_at: null,
    verified_by_user_id: null,
    rejection_reason: null,
    reference: null,
  }),
  platformBan: (): IAgentPlatformBan => ({
    banned: false,
    reason: null,
    banned_at: null,
    banned_by_user_id: null,
  }),
  payoutDetails: (): IAgentPayoutDetails => [],
  homeBase: (): IAgentHomeBase => ({ location: null, service_radius_km: null, label: null }),
  trustSignals: (): IAgentTrustSignals => ({
    on_time_rate: null,
    assignment_response_rate: null,
    completed_shipments: 0,
    customer_rating_avg: null,
    customer_rating_count: 0,
    agency_rating_avg: null,
    agency_rating_count: 0,
    vendor_rating_avg: null,
    vendor_rating_count: 0,
    cod_clean_return_count: 0,
    cod_discrepancy_count: 0,
    cod_volume_returned: 0,
    computed_at: null,
  }),
  /**
   * A new agent starts trusted (matching the previous delta model, which seeded
   * everyone at 100 and subtracted) and with zero COD threshold — they must
   * opt in to holding cash before any agency can allocate against them.
   */
  cod: (): IAgentCodProfile => ({
    trust_score: AGENT_CONFIG.TRUST_SCORE_SEED,
    max_threshold: AGENT_CONFIG.COD_THRESHOLD_MIN,
  }),
};

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const DeliveryAgentSchema = new Schema<IDeliveryAgent>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    email_verified: { type: Boolean, default: false },
    phone: { type: String, trim: true },
    phone_verified: { type: Boolean, default: false },
    name: { type: String, required: true },
    avatar_url: { type: String, default: null },
    vehicle_info: { type: VehicleInfoSchema, default: null },
    legal_identity: {
      type: LegalIdentitySchema,
      default: () => ({ drivers_license_number: null, national_id_number: null }),
    },
    emergency_contact: { type: EmergencyContactSchema, default: null },
    cod: {
      type: new Schema(
        {
          trust_score: {
            type: Number,
            required: true,
            default: AGENT_CONFIG.TRUST_SCORE_SEED,
            min: AGENT_CONFIG.TRUST_SCORE_MIN,
            max: AGENT_CONFIG.TRUST_SCORE_MAX,
          },
          max_threshold: {
            type: Number,
            required: true,
            default: AGENT_CONFIG.COD_THRESHOLD_MIN,
            min: AGENT_CONFIG.COD_THRESHOLD_MIN,
            max: AGENT_CONFIG.COD_THRESHOLD_MAX,
          },
        },
        { _id: false }
      ),
      default: agentDefaults.cod,
    },
    capacity: { type: CapacitySchema, default: agentDefaults.capacity },
    kyc: { type: KycSchema, default: agentDefaults.kyc },
    platform_ban: { type: PlatformBanSchema, default: agentDefaults.platformBan },
    payout_details: { type: [PayoutMethodSchema], default: agentDefaults.payoutDetails },
    home_base: { type: HomeBaseSchema, default: agentDefaults.homeBase },
    trust_signals: { type: TrustSignalsSchema, default: agentDefaults.trustSignals },
    availability: { type: AvailabilitySchema, default: agentDefaults.availability },
    working_state: { type: WorkingStateSchema, default: agentDefaults.workingState },
    tracking: { type: TrackingSchema, default: agentDefaults.tracking },
    device: { type: DeviceCapabilitiesSchema, default: agentDefaults.device },
    last_known_tracking_state: {
      type: LastKnownTrackingStateSchema,
      default: agentDefaults.lastKnownTrackingState,
    },
    preferences: { type: PreferencesSchema, default: agentDefaults.preferences },
    settings: { type: SettingsSchema, default: agentDefaults.settings },
    wa: {
      name: String,
      wa_phone_id: String,
      verified: { type: Boolean, default: false },
      bound_at: Date,
      last_seen_at: Date,
    },
    timezone: { type: String, default: 'Africa/Douala', required: true },
    preferred_language: { type: String, enum: SUPPORTED_LANGUAGES, default: 'en' },
    status: {
      type: String,
      enum: ['pending_verification', 'active', 'inactive', 'suspended'],
      default: 'pending_verification',
    },
    status_reason: { type: String, default: null, trim: true },
    onboarding_step: {
      type: Number,
      default: AgentOnboardingStep.VEHICLE_SETUP,
      min: 0,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Geospatial index on the business-reference position mirror. Sparse: most
// agents have never streamed.
DeliveryAgentSchema.index({ 'last_known_tracking_state.last_position': '2dsphere' }, { sparse: true });

// The dispatch query: "which of these agents can take work right now?"
DeliveryAgentSchema.index({ status: 1, 'availability.state': 1, 'tracking.allowed': 1 });

// Roster/eligibility lookups by email (invites match on email).
DeliveryAgentSchema.index({ email: 1 }, { sparse: true });

export const DeliveryAgentModel = mongoose.model<IDeliveryAgent>(
  MODELS.DELIVERY_AGENT,
  DeliveryAgentSchema,
  COLLECTIONS.DELIVERY_AGENT
);
