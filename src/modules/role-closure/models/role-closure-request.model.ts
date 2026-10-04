import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { actorStampFields, ActorSource } from '../../../core/types/actor-source.types';
import {
  CLOSABLE_ROLES,
  ClosableRole,
  ROLE_CLOSURE_REQUEST_STATUSES,
  ROLE_CLOSURE_WARNING_CODES,
  RoleClosureRequestStatus,
  RoleClosureWarning,
} from '../role-closure.types';

/**
 * An administrator's request to close ONE role of a user — ADR-A10.
 *
 * ── Why a request at all, rather than an admin verb that closes ────────────────
 * Closure is irreversible (the identifiers are destroyed, not archived), so the person whose
 * role it is must agree to it (owner decision O-3). The row is the two-step handshake: wi-admin
 * creates it, the user answers it signed in as that role, and the anonymisation runs inside
 * the confirm. Nothing about the role changes while it is `pending`.
 *
 * ── Expiry is LAZY ──────────────────────────────────────────────────────────────
 * `expires_at` decides; nothing sweeps. Every read treats a `pending` row past its expiry as
 * expired, the confirm is a compare-and-set on `expires_at > now`, and a new request first
 * retires a stale pending row so the partial unique index does not refuse it. A worker would
 * be one more thing to register, lock and inventory for a state no one acts on until they look.
 *
 * ── `role_entity_id` is SNAPSHOTTED ──────────────────────────────────────────────
 * Every role collection is unique on `user_id`, so the entity cannot change under the request —
 * but the confirm checks it anyway, because a request naming one profile must never close another.
 */
export interface IRoleClosureRequest extends Document {
  _id: Types.ObjectId;
  user_id: Types.ObjectId;
  role: ClosableRole;
  role_entity_id: Types.ObjectId;
  status: RoleClosureRequestStatus;

  /** The administrator's reason, shown to the user in the notice. Required. */
  reason: string;

  /** A wi-admin `admin_accounts._id`. No `ref` — it does not resolve in this database. */
  requested_by_user_id: Types.ObjectId;
  requested_by_source: ActorSource;
  requested_by_name: string | null;
  requested_at: Date;
  expires_at: Date;

  /** O-6, frozen at request time so the user confirms against what they were told. */
  warnings: RoleClosureWarning[];

  resolved_at: Date | null;
  /** Who moved it out of `pending`: the user (confirm/decline), an administrator (cancel). */
  resolved_by_user_id: Types.ObjectId | null;
  resolved_by_source: ActorSource;
  resolved_by_name: string | null;
  /** The user's optional words when declining. */
  decline_note: string | null;

  /** Set on `confirmed`. */
  outcome: {
    closed_at: Date;
    account_closed: boolean;
    ended_relationships: number;
  } | null;

  created_at: Date;
  updated_at: Date;
}

const WarningSchema = new Schema<RoleClosureWarning>(
  {
    code: { type: String, enum: ROLE_CLOSURE_WARNING_CODES, required: true },
    planCode: { type: String, default: undefined },
    expiresAt: { type: Date, default: undefined },
    amount: { type: Number, default: undefined },
  },
  { _id: false },
);

const RoleClosureRequestSchema = new Schema<IRoleClosureRequest>(
  {
    user_id: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: CLOSABLE_ROLES, required: true },
    role_entity_id: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ROLE_CLOSURE_REQUEST_STATUSES, required: true, default: 'pending' },
    reason: { type: String, required: true, trim: true, maxlength: 500 },

    requested_by_user_id: { type: Schema.Types.ObjectId, required: true },
    ...actorStampFields('requested_by'),
    requested_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },

    warnings: { type: [WarningSchema], default: [] },

    resolved_at: { type: Date, default: null },
    resolved_by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('resolved_by'),
    decline_note: { type: String, default: null, trim: true, maxlength: 500 },

    outcome: {
      type: new Schema(
        {
          closed_at: { type: Date, required: true },
          account_closed: { type: Boolean, required: true },
          ended_relationships: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

/**
 * One PENDING request per (user, role). The readable face is `ROLE_CLOSURE_ALREADY_PENDING`;
 * this is what makes it true under a race. Built by `npm run migrate:role-closure-indexes`
 * (autoIndex is off in production).
 */
RoleClosureRequestSchema.index(
  { user_id: 1, role: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
    name: 'role_closure_one_pending_per_role',
  },
);

/** The user's history and the admin's per-user list, newest first. */
RoleClosureRequestSchema.index({ user_id: 1, created_at: -1 });

export const RoleClosureRequestModel = mongoose.model<IRoleClosureRequest>(
  MODELS.ROLE_CLOSURE_REQUEST,
  RoleClosureRequestSchema,
  COLLECTIONS.ROLE_CLOSURE_REQUEST,
);
