import { ClientSession, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { AdminActionLogModel, IAdminActionLog } from './admin-action.model';
import { currentAdminActionContext, markServiceRecorded } from './admin-action.context';
import { redact } from './redact';

/**
 * Persisting an administrative action performed on THIS service.
 *
 * ── The session parameter is the whole design ─────────────────────────────────
 * Several call sites sit INSIDE an open transaction — `admin-agency.service.ts` records a
 * deactivation after four session-scoped writes. Writing the row outside that session would
 * leave a record asserting a change that rolled back, which is worse than no record: it is
 * confidently wrong.
 *
 * So the session is passed and the insert joins it. Note this is NOT the fix that
 * `destroyAllSessions` got in wi-admin — that moved post-commit because **Redis cannot join
 * a Mongo session**. An insert on this connection can, and therefore must. Post-commit is
 * the remedy for a non-transactional side effect, not for an audit row.
 *
 * ── ⚠️ Never call this from inside `runInTransactionWithRetry` ────────────────
 * That helper re-invokes its callback on a transient error, so a row written inside would be
 * written again per retry. `runInTransaction` (no retry) is what the admin paths use, which
 * is why this is safe there. A source scan in `test:admin-audit` asserts the two never
 * appear in one file.
 */

export interface RecordAdminActionInput {
    action: string;
    resourceType: string;
    resourceId: string;
    actor: { userId: string | null; role: string | null; name?: string | null };
    changes?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
}

/**
 * Write a specific administrative action.
 *
 * Fills the request context from AsyncLocalStorage where there is one — the service knows
 * what happened, the middleware's scope knows who asked and from where, and the row needs
 * both.
 */
export async function recordAdminAction(
    input: RecordAdminActionInput,
    session?: ClientSession,
): Promise<void> {
    const context = currentAdminActionContext();

    const changes = redact({ ...(input.changes ?? {}), ...(input.metadata ?? {}) });

    const row: Partial<IAdminActionLog> = {
        occurred_at: new Date(),
        correlation_id: context?.correlationId ?? `svc-${randomUUID()}`,
        source: 'service',
        stream: 'admin',

        actor_kind: input.actor.userId ? 'platform_admin_user' : 'anonymous',
        actor_user_id: toObjectId(input.actor.userId),
        actor_role: input.actor.role,
        actor_name: input.actor.name ?? context?.actor.name ?? null,
        ip: context?.ip ?? null,
        user_agent: context?.userAgent ?? null,

        // `SERVICE` rather than a fabricated verb when there is no request — a background
        // path that records an admin action is rare but must not claim to be an HTTP call.
        method: context?.method ?? 'SERVICE',
        path: context?.path ?? `service:${input.action}`,
        status_code: null,
        duration_ms: null,

        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId,

        params: null,
        query: null,
        body_keys: [],
        changes: changes.value,
        error_code: null,
    };

    // Array form, always. `create(doc, options)` is read as a SECOND DOCUMENT by some
    // Mongoose versions, which would write outside the session and defeat the point.
    await AdminActionLogModel.create([row], session ? { session } : undefined);

    // Told AFTER the insert: if it threw, the middleware should still write its coarse row
    // rather than stand down for a record that does not exist.
    markServiceRecorded();
}

function toObjectId(value: string | null | undefined): Types.ObjectId | null {
    if (!value || !Types.ObjectId.isValid(value)) return null;
    return new Types.ObjectId(value);
}
