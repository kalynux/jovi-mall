import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../../core/types/geo.types';
import { AgentOnboardingStep } from '../../../core/constants/onboarding-steps';
import { SUPPORTED_LANGUAGES, Language } from '../../../core/constants/languages';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { PayoutMethodSchema, IPayoutMethod } from '../../../core/types/payout.types';
import { AGENT_CONFIG } from '../config/agent.config';
import { ActorSource, actorStampFields } from '../../../core/types/actor-source.types';

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
    photo_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
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
  /**
   * Lowercase English token from `VEHICLE_COLORS` (see `domain/vehicle-info.ts`),
   * or whatever the agent typed when it is not one — the field is a documented
   * vocabulary, not an enum. Never localized on the wire.
   */
  color: string;
  /**
   * Photo of the vehicle. A File reference, modelled on `avatar_file_id`:
   * reference-counted under `entityType: 'agent', field: 'vehicle_photo'`, and
   * surfaced as a resolved `FileDetail` (`vehicle_info.photo`), never a bare id.
   */
  photo_file_id: mongoose.Types.ObjectId | null;
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
  /** Which identity space `changed_by_user_id` belongs to. See `actor-source.types.ts`. */
  changed_by_source?: ActorSource;
  changed_by_name?: string | null;
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
  /**
   * A human-readable name for `last_position` — "Bonapriso, Douala".
   *
   * Resolved ONCE per position, on the way in, and cached against the rounded
   * coordinate. Not on the way out: reverse-geocoding per read would be a bill per
   * operator who opens a screen, and would hand the same person's coordinates to a
   * geocoding provider once per viewer rather than once per position.
   *
   * `null` when nothing resolved — never `''`, and never a coordinate pair dressed up
   * as a name. `source` is an open string so a future "nearest landmark" or "agency
   * coverage region" resolution is additive; readers render it and must not `switch`.
   *
   * ⚠ It inherits the position's disclosure. A coordinate pair needs a tool to read;
   * "Bonapriso, Douala" does not. Anything that decides whether to show the position
   * decides the same thing about this.
   */
  last_place: IAgentLastKnownPlace | null;
}

/** A resolved name for a position, with the provenance and age of the resolution. */
export interface IAgentLastKnownPlace {
  label: string;
  source: string;
  resolved_at: Date;
}

/**
 * Agent-chosen preferences — client-consumed only.
 *
 * Nothing on the server branches on these; the app reads them back from
 * GET /api/agent/profile. Notification delivery is NOT configured here: that is
 * `AgentNotificationPreference`, and the two `notify_*` flags that used to sit
 * here gated nothing while looking exactly as if they did.
 */
export interface IAgentPreferences {
  /** Preferred navigation app deep-link target. Read by the agent app, not the server. */
  navigation_app: 'google_maps' | 'waze' | 'apple_maps' | 'none';
}

/** Operational configuration that affects dispatch. */
export interface IAgentSettings {
  /**
   * Accept assignment offers without prompting the agent. Read on both offer
   * paths in ShipmentAssignmentService (broadcast + manual): the offer row is
   * still written first, then immediately accepted, so this is not a bypass of
   * the offer record.
   */
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
  verified_by_source?: ActorSource;
  verified_by_name?: string | null;
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
  banned_by_source?: ActorSource;
  banned_by_name?: string | null;
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

  /**
   * The composite score AgentTrustService computes from the fields above — and
   * **the score nothing acts on yet.**
   *
   * ── Why there are two scores, and which one is live ──────────────────────────
   * `cod.trust_score` is LIVE: `CodTrustService.applyEvent` writes it on every COD
   * discrepancy and admin adjustment, and `CodExposureService` reads it to set an
   * agent's cash limit. This field is the SHADOW: the nightly recompute writes it
   * and writes nothing else, so the composite can be compared against the live
   * number before it replaces it.
   *
   * The shadow exists because the cutover is not free. Three of the composite's
   * five factors are ratings (50 of 100 weight) and **nothing rates an agent yet**,
   * so today they all blend to the seed. Flipping without looking would re-score
   * every agent from half-invented inputs and move real cash exposure with it —
   * `TRUST_FULL_THRESHOLD` (80) and `TRUST_REDUCED_THRESHOLD` (50) are the two
   * numbers that would move. Phase 6 Step 11 is the flip, and it is taken against
   * a table of who crosses those thresholds, not against an argument.
   *
   * `null` until the first recompute visits this agent.
   */
  composite_score: number | null;

  computed_at: Date | null;
}

export interface IDeliveryAgent extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  name: string;
  /**
   * Profile avatar as a File reference — registers in `file_references` and is
   * deletion-protected. Canonical going forward; `avatar_url` is the deprecated
   * read-fallback for legacy string avatars.
   */
  avatar_file_id: mongoose.Types.ObjectId | null;
  /** @deprecated Prefer `avatar_file_id`. Kept as a read-fallback for legacy avatars. */
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
    /**
     * `changed_by_role` is not the same question as `changed_by_source`, and keeping both
     * is deliberate. The role says WHAT KIND of actor decided — it is already `'admin'` for
     * every write on this path, since there is no agency or agent write path at all. The
     * source says WHICH DATABASE the id beside it lives in, and that is the one a reader
     * needs to know before trying to resolve it. See `actor-source.types.ts`.
     */
    ...actorStampFields('changed_by'),
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
    // KYC is admin-written on every path — eligibility passes only on `verified`, so this
    // is the field that decides whether an agent may work at all, and it is the one whose
    // actor a dispute is most likely to ask about.
    ...actorStampFields('verified_by'),
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
    // Lifting a ban CLEARS the reason and the timestamp, so between the two the audit row
    // in wi-admin is the only record it happened. While a ban stands, this stamp is the
    // only thing on the agent's own document naming who imposed it.
    ...actorStampFields('banned_by'),
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
    /** The SHADOW score — see `IAgentTrustSignals.composite_score`. Nothing acts on it yet. */
    composite_score: { type: Number, default: null, min: 0, max: 100 },
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

/**
 * The resolved name of a position. `_id: false` like every other embedded block here.
 *
 * `label` and `source` are both required: a place with no name is `last_place: null`,
 * not a row with an empty label, and a name with no provenance cannot be judged.
 */
const LastKnownPlaceSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    source: { type: String, required: true },
    resolved_at: { type: Date, required: true },
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
    last_place: { type: LastKnownPlaceSchema, default: null },
  },
  { _id: false }
);

const PreferencesSchema = new Schema(
  {
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
    last_place: null,
  }),
  preferences: (): IAgentPreferences => ({
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
    composite_score: null,
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
    avatar_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
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

// The agent's DECLARED operating area — distinct from the position mirror
// above, which is where they physically were. Backs the `near` filter on the
// agency-facing directory (AgentRepository.findAvailableForAgencies). Sparse:
// home base is optional and many agents never set one.
DeliveryAgentSchema.index({ 'home_base.location': '2dsphere' }, { sparse: true });

// The directory query: the four gates every browsable agent must clear, with
// the default sort key trailing so it is served from the index.
DeliveryAgentSchema.index({
  status: 1,
  'kyc.status': 1,
  'platform_ban.banned': 1,
  'cod.trust_score': -1,
});

// Lookups by email — auth/account resolution (AgentRepository.findByEmail).
DeliveryAgentSchema.index({ email: 1 }, { sparse: true });

// ── The administrative directory (wi-admin `GET /api/v1/agents`) ────────────
//
// Every index above serves a query that FILTERS first: dispatch, the browsable
// directory, an email lookup. The admin list is the opposite shape — its whole
// point is finding the agents those queries exclude (unverified, banned,
// suspended, mid-onboarding), so its common case is no filter at all and its
// default order is `-created_at`. With nothing here that is a collection scan
// plus a blocking in-memory sort, requestable from a query string.
//
// Both the bare and the status-compound form, deliberately. A single-field index
// is walkable in either direction, so `{created_at: -1}` also serves an ascending
// sort; a compound one is not, so `{status, created_at: -1}` serves
// `?status=active&sort=-createdAt` and not its ascending twin — which the bare
// index then covers.
DeliveryAgentSchema.index({ created_at: -1 });
DeliveryAgentSchema.index({ status: 1, created_at: -1 });
DeliveryAgentSchema.index({ updated_at: -1 });

export const DeliveryAgentModel = mongoose.model<IDeliveryAgent>(
  MODELS.DELIVERY_AGENT,
  DeliveryAgentSchema,
  COLLECTIONS.DELIVERY_AGENT
);
