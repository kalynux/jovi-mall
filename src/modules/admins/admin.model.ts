import mongoose, { Schema, Document } from 'mongoose';
import { FixedOnboardingStep } from '../../core/constants/onboarding-steps';

export interface IAdmin extends Document {
  user_id: mongoose.Types.ObjectId;
  name: string;
  email?: string;
  avatar_url: string | null;
  job_title: string | null;
  department: string | null;
  two_factor_enabled: boolean;
  last_login_ip: string | null;
  timezone: string;
  /**
   * Always 0 for admins — no onboarding flow.
   * Stored for API consistency with other roles.
   */
  onboarding_step: number;
  created_at: Date;
  updated_at: Date;
}

const AdminSchema = new Schema<IAdmin>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true },
    avatar_url: { type: String, default: null },
    job_title: { type: String, default: null, trim: true },
    department: { type: String, default: null, trim: true },
    two_factor_enabled: { type: Boolean, default: false },
    /**
     * SECURITY: last_login_ip is never returned in public profile responses.
     * Only the authenticated admin can see their own last_login_ip.
     * Updated by auth middleware on successful login.
     */
    last_login_ip: { type: String, default: null },
    timezone: { type: String, default: 'Africa/Douala', required: true },
    onboarding_step: {
      type: Number,
      default: FixedOnboardingStep.COMPLETED,
      min: 0,
      max: 0,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export const AdminModel = mongoose.model<IAdmin>('Admin', AdminSchema);
