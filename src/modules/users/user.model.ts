import mongoose, { Schema, Document } from 'mongoose';

export type UserRole = 'admin' | 'vendor' | 'agency' | 'agent' | 'customer';
export type UserStatus = 'active' | 'suspended';

export interface IUser extends Document {
  login_email?: string;
  login_phone?: string;
  password_hash: string;
  roles: UserRole[];
  status: UserStatus;
  created_at: Date;
  updated_at: Date;
}

const UserSchema = new Schema<IUser>(
  {
    login_email: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
    login_phone: { type: String, unique: true, sparse: true, trim: true },
    password_hash: { type: String, required: true },
    roles: {
      type: [String],
      enum: ['admin', 'vendor', 'agency', 'agent', 'customer'],
      default: ['customer'],
    },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active', // Auth account is active by default, role limits access
    },
  },
  { 
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } // snake_case timestamps
  }
);

export const UserModel = mongoose.model<IUser>('User', UserSchema);
