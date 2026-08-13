import mongoose, { Document, Schema, Types } from 'mongoose';
import { COLLECTIONS } from '../database/collections';

/**
 * Administrative actions performed on THIS service, until the cutover deletes the surface.
 *
 * ── What this is, and what it is emphatically not ─────────────────────────────
 * wi-admin's `admin_audit_log` is the compliance record. This is a **stop-gap**: until the
 * Phase 8 cutover the dashboard still calls admin endpoints here directly, and those actions
 * were recorded nowhere at all. This collection is what makes them visible in the meantime.
 *
 * The difference is not cosmetic and shows up in the retention rule below.
 *
 * ── Why it lives in `jovi_mall` rather than being posted to wi-admin ──────────
 * Nothing in this service knows wi-admin exists — the dependency runs one way, admin →
 * platform, and inverting it for this would be a real architectural change for a temporary
 * feature. An HTTP ingest into `admin_audit_log` would also be a forgery surface, destroying
 * the property that `audit.writer.ts` is the only thing that can write an audit row.
 *
 * So: written here, read by wi-admin over the direct-read path ADR-004 already sanctions,
 * and served on its own clearly-labelled endpoint rather than merged into the real feed.
 */
export interface IAdminActionLog extends Document {
    _id: Types.ObjectId;
    occurred_at: Date;
    /** `X-Request-Id` where the caller sent one, so a row joins this service's own logs. */
    correlation_id: string;

    /** `request` = the coarse middleware row. `service` = an explicit `auditLogger.log`. */
    source: 'request' | 'service';
    /** `admin` = an administrative action. `self_service` is reserved and unused today. */
    stream: 'admin' | 'self_service';

    // ── The actor. NOT a wi-admin administrator — see the header note below ──
    actor_kind: 'platform_admin_user' | 'platform_user' | 'anonymous';
    actor_user_id: Types.ObjectId | null;
    actor_role: string | null;
    actor_name: string | null;
    ip: string | null;
    user_agent: string | null;

    method: string;
    path: string;
    status_code: number | null;
    duration_ms: number | null;

    /** Set on `source: 'service'` rows — the verb the service named, e.g. `AGENCY_DEACTIVATED`. */
    action: string | null;
    resource_type: string | null;
    resource_id: string | null;

    params: Record<string, unknown> | null;
    query: Record<string, unknown> | null;
    /** KEY NAMES ONLY. Never values. See the middleware header. */
    body_keys: string[];
    changes: Record<string, unknown> | null;
    error_code: string | null;
}

const AdminActionLogSchema = new Schema<IAdminActionLog>(
    {
        occurred_at: { type: Date, required: true, default: () => new Date() },
        correlation_id: { type: String, required: true },

        source: { type: String, required: true, enum: ['request', 'service'] },
        stream: { type: String, required: true, enum: ['admin', 'self_service'], default: 'admin' },

        /**
         * `platform_admin_user` deliberately does NOT exist in wi-admin's
         * `AUDIT_ACTOR_KINDS`. These callers hold a `users` row with `role: 'admin'` in THIS
         * database; a wi-admin administrator has no `users` row at all (ADR-004 D-1). Two id
         * spaces, and the vocabulary says so rather than letting a reader assume they are
         * the same people.
         */
        actor_kind: {
            type: String,
            required: true,
            enum: ['platform_admin_user', 'platform_user', 'anonymous'],
        },
        actor_user_id: { type: Schema.Types.ObjectId, default: null },
        actor_role: { type: String, default: null },
        actor_name: { type: String, default: null },
        ip: { type: String, default: null },
        user_agent: { type: String, default: null },

        method: { type: String, required: true },
        path: { type: String, required: true },
        status_code: { type: Number, default: null },
        duration_ms: { type: Number, default: null },

        action: { type: String, default: null },
        resource_type: { type: String, default: null },
        resource_id: { type: String, default: null },

        params: { type: Schema.Types.Mixed, default: null },
        query: { type: Schema.Types.Mixed, default: null },
        body_keys: { type: [String], required: true, default: [] },
        changes: { type: Schema.Types.Mixed, default: null },
        error_code: { type: String, default: null },
    },
    {
        collection: COLLECTIONS.ADMIN_ACTION_LOG,
        // No `timestamps`: `occurred_at` is the only time that matters and a second one
        // invites the "which do I sort by" mistake wi-admin's row already had to answer.
        timestamps: false,
    },
);

// The feed, newest first.
AdminActionLogSchema.index({ occurred_at: -1, _id: -1 });
// "What did this administrator do."
AdminActionLogSchema.index({ actor_user_id: 1, occurred_at: -1 });
// "What was done to this record" — only meaningful on `source: 'service'` rows.
AdminActionLogSchema.index({ resource_type: 1, resource_id: 1, occurred_at: -1 });
// Joins a row to this service's own request logs, and to wi-admin's if the id came from it.
AdminActionLogSchema.index({ correlation_id: 1 });

/**
 * ── The TTL, and why it is UNCONDITIONAL ──────────────────────────────────────
 *
 * wi-admin's `admin_audit_log` has a *partial* TTL requiring `export_id`, so a row leaves
 * only once it has been exported to a durable file AND aged out (ADR-006 D-3). That is
 * right for the compliance record.
 *
 * This is not the compliance record. It is a stop-gap for a surface being deleted at
 * cutover, in a database wi-admin does not own, with no export manifest to point a vanished
 * row at. The realistic alternatives were an unconditional TTL or an unbounded, unowned
 * collection growing forever in the platform database — and the second is worse.
 *
 * Which is exactly why this collection must never be treated as the compliance record. 400
 * days, deliberately longer than `ADMIN_AUDIT_RETENTION_DAYS` (365), so nothing here
 * disappears before its wi-admin counterpart would have.
 */
export const ADMIN_ACTION_LOG_TTL_DAYS = 400;

AdminActionLogSchema.index(
    { occurred_at: 1 },
    { expireAfterSeconds: ADMIN_ACTION_LOG_TTL_DAYS * 24 * 60 * 60 },
);

/**
 * Two indexes on `occurred_at` — a descending compound for the feed and this ascending one
 * for the TTL — is correct and necessary. Mongo will not drive a TTL off the compound
 * index. Do not "tidy" one away.
 */
export const AdminActionLogModel = mongoose.model<IAdminActionLog>(
    'AdminActionLog',
    AdminActionLogSchema,
);
