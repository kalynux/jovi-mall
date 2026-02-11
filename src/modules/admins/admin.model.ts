import mongoose, { Schema, Document } from 'mongoose';

export interface IAdmin extends Document {
  user_id: mongoose.Types.ObjectId;
  name: string;
  email?: string;
  timezone: string;
  created_at: Date;
  updated_at: Date;
}

const AdminSchema = new Schema<IAdmin>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, trim: true, lowercase: true },
    timezone: { type: String, default: 'Africa/Douala', required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export const AdminModel = mongoose.model<IAdmin>('Admin', AdminSchema);
