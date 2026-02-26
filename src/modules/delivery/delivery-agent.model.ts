import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { AgentOnboardingStep } from '../../core/constants/onboarding-steps';

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
  wa?: {
    name?: string;
    wa_phone_id?: string;
    verified: boolean;
    bound_at?: Date;
    last_seen_at?: Date;
  };
  timezone: string;
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
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    agency_id: { type: Schema.Types.ObjectId, ref: 'DeliveryAgency' },
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
    wa: {
      name: String,
      wa_phone_id: String,
      verified: { type: Boolean, default: false },
      bound_at: Date,
      last_seen_at: Date,
    },
    timezone: { type: String, default: 'Africa/Douala', required: true },
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

export const DeliveryAgentModel = mongoose.model<IDeliveryAgent>('DeliveryAgent', DeliveryAgentSchema);
