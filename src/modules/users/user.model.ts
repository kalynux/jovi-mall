import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import { ActorSource, actorStampFields } from '../../core/types/actor-source.types';

export type UserRole = 'admin' | 'vendor' | 'agency' | 'agent' | 'customer';
export type UserStatus = 'active' | 'suspended';

export interface IUser extends Document {
  login_email?: string;
  login_phone?: string;
  password_hash: string;
  roles: UserRole[];
  status: UserStatus;

  /**
   * Why the account is in its current status, and who put it there.
   *
   * `status` alone answers "may this person sign in"; it cannot answer "why not", which
   * is the first thing both the suspended person and the next administrator ask. The
   * fields are cleared on reinstatement — the durable record of the suspension itself
   * lives in wi-admin's audit trail, which is append-only and cannot be cleared, so
   * erasing the columns loses nothing that matters.
   *
   * `suspended_by_user_id` carries an actor stamp (`_source` + `_name`) because an
   * administrator's id belongs to the wi-admin database and resolves to nothing here.
   * See `core/types/actor-source.types.ts`.
   */
  suspended_at: Date | null;
  suspended_reason: string | null;
  suspended_by_user_id: mongoose.Types.ObjectId | null;
  suspended_by_source: ActorSource;
  suspended_by_name: string | null;

  /**
   * When the password was last changed — the instant every token is measured against.
   *
   * This service issues stateless JWTs and keeps no record of them, so there is nothing to
   * delete when a password changes. This field IS the revocation list: a token whose `iat`
   * predates it was minted under the old password and is refused, on both the access and
   * the refresh path. Without it, changing a password — the standard remedy after a
   * compromise — evicts nobody, and an attacker's 30-day refresh cookie goes on minting
   * fresh access tokens while the victim believes they have locked the door.
   *
   * `null` means "never changed since this column existed", which is the correct reading
   * for every row that predates it: nothing to be behind, so no backfill is needed. See
   * `core/auth/password-epoch.ts`.
   */
  password_changed_at: Date | null;

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

    // Suspension provenance. Written together by AdminUserService.setStatus — never
    // one at a time, or a reason ends up describing a suspension that was lifted.
    suspended_at: { type: Date, default: null },
    suspended_reason: { type: String, default: null, trim: true, maxlength: 500 },
    suspended_by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('suspended_by'),

    // Written by UserRepository.updatePassword in the same $set as the hash — never apart.
    // A hash that lands without its stamp is the whole defect: the new password is live and
    // every token issued under the old one still works.
    password_changed_at: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } // snake_case timestamps
  }
);

/**
 * The admin user list sorts by `created_at` and filters on `roles` + `status`.
 *
 * Without this the platform's largest people-collection is scanned on every page of the
 * admin directory. `status` leads because it is the most selective of the three in
 * practice (almost everything is `active`, so the suspended list is tiny), and
 * `created_at` closes the index so the default `-createdAt` ordering is served from it.
 */
UserSchema.index({ status: 1, roles: 1, created_at: -1 });

export const UserModel = mongoose.model<IUser>(MODELS.USER, UserSchema, COLLECTIONS.USER);
