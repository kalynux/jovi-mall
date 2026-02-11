import mongoose, { Schema, Document } from 'mongoose';

export interface IVendor extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  business_name: string;
  display_name?: string; // Optional user-facing display name
  legit_verified: boolean;
  default_delivery_agency_id?: mongoose.Types.ObjectId | null;
  wa?: {
    verified: boolean;
    wa_phone_id?: string;
    name?: string;
    bound_at?: Date;
    last_seen_at?: Date;
  };
  notification_preferences: {
    email: boolean;
    whatsapp: boolean; // Feature-flagged OFF
    phone: boolean;    // Feature-flagged OFF
  };
  two_factor_enabled: boolean; // Placeholder for future 2FA
  version: number; // Optimistic locking
  timezone: string; // IANA timezone for vendor-specific date boundaries (analytics, notifications)
  status: 'active' | 'pending_verification' | 'inactive';
  created_at: Date;
  updated_at: Date;
}

const VendorSchema = new Schema<IVendor>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    business_name: { type: String, required: true },
    display_name: { type: String }, // Optional display name
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    email_verified: { type: Boolean, default: false },
    phone_verified: { type: Boolean, default: false },
    legit_verified: { type: Boolean, default: false },
    default_delivery_agency_id: { type: Schema.Types.ObjectId, ref: 'DeliveryAgency', default: null },
    wa: {
      verified: { type: Boolean, default: false },
      wa_phone_id: { type: String },
      name: { type: String },
      bound_at: { type: Date },
      last_seen_at: { type: Date }
    },
    notification_preferences: {
      email: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
      phone: { type: Boolean, default: false }
    },
    two_factor_enabled: { type: Boolean, default: false },
    version: { type: Number, default: 0 }, // Optimistic locking
    timezone: { type: String, default: 'Africa/Douala', required: true },
    status: {
      type: String,
      enum: ['active', 'pending_verification', 'inactive'],
      default: 'pending_verification'
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export const VendorModel = mongoose.model<IVendor>('Vendor', VendorSchema);
