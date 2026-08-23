import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import { ActorSource, actorStampFields } from '../../core/types/actor-source.types';

export type UserRole = 'admin' | 'vendor' | 'agency' | 'agent' | 'customer';
/**
 * `closed` is the account-closure terminal (ADR-A02 D-1), and it is deliberately a THIRD
 * value rather than a reuse of `suspended`.
 *
 * The two mean different things and are undone differently: a suspension is an
 * administrator's decision with a `restore` verb behind it; a closure is the account
 * owner's, and has none. Reusing `suspended` would have left `AdminUserService.restore` —
 * which compare-and-sets from `suspended` — one click away from un-closing an anonymised
 * account whose identifiers no longer exist. As a separate value, every
 * `status !== 'active'` guard in the service already refuses it, and both admin verbs miss
 * their compare-and-set and answer 409.
 */
export type UserStatus = 'active' | 'suspended' | 'closed';

/** A requested email change, pending proof of the new address. See `IUser.pending_email`. */
export interface IPendingEmailChange {
  /** The address being proved. Normalised (lowercased, trimmed) before it lands here. */
  address: string;
  /** SHA-256 of the confirmation token. The plaintext never touches this collection. */
  token_hash: string;
  requested_at: Date;
  expires_at: Date;
}

/** A requested phone change, pending proof of control. See `IUser.pending_phone`. */
export interface IPendingPhoneChange {
  /** The number being proved, in strict E.164. */
  number: string;
  requested_at: Date;
  expires_at: Date;
}

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

  /**
   * When the account owner closed this account — the only durable record here that they did
   * (ADR-A02 D-1).
   *
   * Null on every account that has not been closed. The row itself is what survives closure:
   * it keeps its `_id` so orders, tickets and bookings that reference it stay resolvable, and
   * loses every identifier. So this stamp plus `status: 'closed'` is the whole of what a
   * later reader gets — no identifier, no name, no reason. Written by
   * `AccountClosureRepository.anonymiseUser` in the same `$set` as the status, never apart.
   */
  closed_at: Date | null;

  /**
   * A self-service email change waiting on the new address to prove itself.
   *
   * ⚠ **`login_email` is NOT touched while this is set**, and that is the whole point of the
   * sub-document existing at all. Writing the new address straight onto the identifier and
   * marking it unverified would lock a mistyped address out of its own account with no
   * self-service path back — the account can no longer be signed into and the correction
   * form is behind the sign-in.
   *
   * The token is stored **hashed**. A reader of this collection — a backup, an export, a
   * `/system/database` sample — must not come away holding a live credential; the plaintext
   * exists only in the message sent to the address being proved.
   *
   * Cleared in the SAME `$set` that swaps the identifier (`applyEmailChange`), never in a
   * second write: a pending block that outlives its own confirmation is a token that can be
   * spent twice.
   */
  pending_email: IPendingEmailChange | null;

  /**
   * A self-service phone change waiting on proof that this account controls the number.
   *
   * Carries no token, and that asymmetry with `pending_email` is deliberate rather than an
   * omission. An email token is *itself* the proof — only the holder of the address receives
   * it. There is no equivalent for a phone here: this service sends no SMS, and a WhatsApp
   * message to a cold number needs an approved paid template. So the proof is the inbound
   * direction the platform already has — a `channel_connections` row binding this account to
   * that number on WhatsApp, which exists only because a message arrived *from* it. See
   * `services/contact-change.service.ts`.
   *
   * `expires_at` is therefore bounding an INTENT rather than a secret: it is what stops a
   * request made months ago being completed by a connection established for another reason.
   */
  pending_phone: IPendingPhoneChange | null;

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
      enum: ['active', 'suspended', 'closed'],
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

    // Account closure. Written with `status: 'closed'` in ONE $set, for the same reason the
    // suspension stamp above is written whole: a date that outlives its status describes a
    // closure that did not happen.
    closed_at: { type: Date, default: null },

    /**
     * Pending contact changes. `_id: false` on both — a sub-document with no identity of its
     * own does not need one, and an `_id` here would be a second handle on a record whose
     * only correct addressing is "the pending change on this account".
     *
     * `default: null` rather than `default: () => ({})`: absent and empty must not be two
     * spellings of "nothing in flight", because `$set: { pending_email: null }` is how the
     * confirm and the cancel both clear it.
     */
    pending_email: {
      type: new Schema<IPendingEmailChange>(
        {
          address: { type: String, required: true, trim: true, lowercase: true },
          token_hash: { type: String, required: true },
          requested_at: { type: Date, required: true },
          expires_at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },

    pending_phone: {
      type: new Schema<IPendingPhoneChange>(
        {
          number: { type: String, required: true, trim: true },
          requested_at: { type: Date, required: true },
          expires_at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, // snake_case timestamps

    /**
     * ── `password_hash` NEVER leaves this process (added 2026-08-21) ──────────
     *
     * `POST /api/auth/login` and `POST /api/auth/mobile/login` answered
     * `sendSuccess(res, { user, role, role_entity })` with the Mongoose document itself, so
     * the bcrypt hash of the caller's password was in the response body — verified on a
     * running server, not inferred. `/auth/me`, `/auth/auth-me` and `addRole` shipped the
     * same object.
     *
     * A bcrypt hash is a credential. It is offline-crackable at leisure, it lands in
     * browser devtools, proxy logs, error reporters and anything that captures a response
     * body, and no client has ever had a use for it.
     *
     * ── Why here, and not in five controllers ────────────────────────────────
     * This is the ONE place every serialisation passes through, so it cannot be forgotten
     * by a route added later — which is exactly how it got out: `admin-user.service.ts`
     * already knew the risk and defended it with a named projection on its own surface,
     * while the auth surface shipped the raw document beside it.
     *
     * Nothing internal breaks, because nothing internal reads this field through JSON:
     * `AuthService.login`, `UserService.changePassword` and `verifyPassword` all read
     * `user.password_hash` off the document, where it is untouched. A census of every
     * `password_hash` reference in `src/` confirmed it before this was added.
     *
     * ⚠ **Deleting the field here does not stop it being SELECTED.** This is a
     * serialisation guard, not `select: false` — chosen deliberately, because `select: false`
     * would silently give `bcrypt.compare` an `undefined` hash at every call site that
     * forgot `.select('+password_hash')`, and *that* failure direction is "authentication
     * quietly stops working" rather than "a field is missing from a response".
     */
    toJSON: {
      transform: (_doc: unknown, ret: Record<string, unknown>) => {
        delete ret.password_hash;
        return ret;
      },
    },
    toObject: {
      transform: (_doc: unknown, ret: Record<string, unknown>) => {
        delete ret.password_hash;
        return ret;
      },
    },
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

/**
 * The email-change confirmation resolves an account from a token and nothing else.
 *
 * Sparse, because the field is null on every account with no change in flight — which is
 * effectively all of them — so a full index would carry one entry per user to serve a
 * lookup that happens a handful of times a day. **Not unique**: two accounts holding the
 * same hash is a 2^256 collision, and claiming uniqueness would turn that impossibility
 * into a write failure on an unrelated account.
 */
UserSchema.index({ 'pending_email.token_hash': 1 }, { sparse: true });

export const UserModel = mongoose.model<IUser>(MODELS.USER, UserSchema, COLLECTIONS.USER);
