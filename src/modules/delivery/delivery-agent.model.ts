import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { AgentOnboardingStep } from '../../core/constants/onboarding-steps';
import { SUPPORTED_LANGUAGES, Language } from '../../core/constants/languages';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

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

// ─── Live State Sub-Schema ────────────────────────────────────────────────────

const LiveStateSchema = new Schema(
  {
    last_known_location: { type: GeoPointSchema, default: null },
    current_capacity_status: {
      type: String,
      enum: ['available', 'busy', 'offline'],
      default: 'offline',
    },
  },
  { _id: false }
);

// ─── Interfaces ────────────────────────────────────────────────────────────────

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

export interface IAgentLiveState {
  last_known_location: IGeoPoint | null;
  current_capacity_status: 'available' | 'busy' | 'offline';
}

export interface IAgentCodProfile {
  /**
   * 0–100 (default 100). Degraded by late deposits / cash shortfalls, restored
   * by admin adjustment. Below COD_CONFIG.TRUST_REDUCED_THRESHOLD the agent is
   * blocked from COD shipments; between the thresholds their exposure limit is
   * multiplied down. History lives in CodTrustEvent (append-only).
   */
  trust_score: number;
  /**
   * Agency-set cap (minor units) on this agent's cash exposure, overriding
   * COD_CONFIG.AGENT_MAX_EXPOSURE_DEFAULT. null = platform default.
   */
  max_exposure_override: number | null;
}

export interface IDeliveryAgent extends Document {
  user_id: mongoose.Types.ObjectId;
  agency_id?: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  name: string;
  avatar_url: string | null;
  vehicle_info: IAgentVehicleInfo | null;
  legal_identity: IAgentLegalIdentity;
  emergency_contact: IAgentEmergencyContact | null;
  live_state: IAgentLiveState;
  cod: IAgentCodProfile;
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
  status: 'active' | 'pending_verification' | 'inactive';
  /**
   * Onboarding progress. See AgentOnboardingStep constants.
   * Recalculated from field presence after every write.
   */
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const DeliveryAgentSchema = new Schema<IDeliveryAgent>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true, unique: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY },
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
    live_state: {
      type: LiveStateSchema,
      default: () => ({ last_known_location: null, current_capacity_status: 'offline' }),
    },
    cod: {
      type: new Schema(
        {
          trust_score: { type: Number, required: true, default: 100, min: 0, max: 100 },
          max_exposure_override: { type: Number, default: null, min: 0 },
        },
        { _id: false }
      ),
      default: () => ({ trust_score: 100, max_exposure_override: null }),
    },
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
      enum: ['active', 'pending_verification', 'inactive'],
      default: 'pending_verification',
    },
    onboarding_step: {
      type: Number,
      default: AgentOnboardingStep.VEHICLE_SETUP,
      min: 0,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Geospatial index for live location tracking
DeliveryAgentSchema.index({ 'live_state.last_known_location': '2dsphere' }, { sparse: true });

export const DeliveryAgentModel = mongoose.model<IDeliveryAgent>(MODELS.DELIVERY_AGENT, DeliveryAgentSchema, COLLECTIONS.DELIVERY_AGENT);
