import mongoose, { Schema, Document } from 'mongoose';

export interface IDeliveryAgency extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  agency_name: string;
  legit_verified: boolean;
  wa?: {
    name?: string;
    wa_phone_id?: string;
    verified: boolean;
    bound_at?: Date;
    last_seen_at?: Date;
  };
  timezone: string;
  status: 'active' | 'pending_verification' | 'inactive';
  created_at: Date;
  updated_at: Date;
}

const DeliveryAgencySchema = new Schema<IDeliveryAgency>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    email_verified: { type: Boolean, default: false },
    phone: { type: String, trim: true },
    phone_verified: { type: Boolean, default: false },
    agency_name: { type: String, required: true },
    legit_verified: { type: Boolean, default: false },
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
      default: 'pending_verification'
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export const DeliveryAgencyModel = mongoose.model<IDeliveryAgency>('DeliveryAgency', DeliveryAgencySchema);
