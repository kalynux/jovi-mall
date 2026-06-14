import mongoose, { Document, Schema } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../../core/database/collections';

export interface IConnectedCalendarAccount extends Document {
  userId: mongoose.Types.ObjectId;
  vendorId?: mongoose.Types.ObjectId; // Optional: only set if user is a vendor
  provider: 'google';
  googleAccountId: string;
  email: string;
  accessToken: string; // Encrypted
  refreshToken: string; // Encrypted
  expiresAt: Date;
  scope: string;
  calendarId: string; // Which calendar to use, defaults to 'primary'
  requiresReauth?: boolean; // Set to true if access is revoked or refresh fails
  createdAt: Date;
  updatedAt: Date;
}

const ConnectedCalendarAccountSchema = new Schema<IConnectedCalendarAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.USER, // Assuming a User model exists
      required: true,
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.VENDOR,
      required: false,
    },
    provider: {
      type: String,
      required: true,
      enum: ['google'],
      default: 'google',
    },
    googleAccountId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    scope: {
      type: String,
      required: true,
    },
    calendarId: {
      type: String,
      required: true,
      default: 'primary',
    },
    requiresReauth: {
      type: Boolean,
      required: false,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index to prevent multiple Google connections for the same user
// and to ensure fast lookups by user+provider
ConnectedCalendarAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });

// Index for looking up by googleAccountId (useful for checking if an account is already linked to another user, if strict logic requires)
ConnectedCalendarAccountSchema.index({ googleAccountId: 1 });

// Index for fast vendor calendar lookups
ConnectedCalendarAccountSchema.index({ vendorId: 1, provider: 1 });

export const ConnectedCalendarAccount = mongoose.model<IConnectedCalendarAccount>(MODELS.CONNECTED_CALENDAR_ACCOUNT, ConnectedCalendarAccountSchema, COLLECTIONS.CONNECTED_CALENDAR_ACCOUNT);
