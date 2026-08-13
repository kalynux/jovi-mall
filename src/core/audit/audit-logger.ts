import { ClientSession } from 'mongoose';
import { recordAdminAction } from './admin-action.recorder';

/**
 * Audit Log Entry Interface
 * 
 * Captures critical actions for compliance, security, and debugging.
 */
export interface AuditLogEntry {
  /** Who performed the action */
  actor: {
    userId: string;
    role: string;
    /** Optional: IP address, user agent, etc. */
    metadata?: Record<string, any>;
  };
  /** What action was performed (e.g., 'VENDOR_PROFILE_UPDATED', 'PASSWORD_CHANGED') */
  action: string;
  /** What resource was affected */
  resource: {
    type: string; // e.g., 'Vendor', 'User', 'Order'
    id: string;
  };
  /** Optional: What changed (before/after diff) */
  changes?: Record<string, any>;
  /** Optional: Additional context */
  metadata?: Record<string, any>;
  /** When the action occurred */
  timestamp: Date;
}

/**
 * Audit Logger
 *
 * ── It was a `console.log` stub from Day 1 until Phase 12 ────────────────────
 * This class logged to the console, `query()` returned `[]`, and its own header listed the
 * compliance requirements it did not meet. Fourteen call sites awaited it believing
 * something was being recorded. `admin/docs/IMPLEMENTATION-BLUEPRINT.md` §5 cites it by
 * name as the reason audit was sequenced BEFORE the endpoints that need it — "retrofitting
 * an audit trail onto working endpoints is exactly how the legacy console.log stub
 * happened".
 *
 * It is now an ADAPTER onto `admin-action.recorder.ts`. Deliberately an adapter rather than
 * a rewrite: `AuditLogEntry` and all fourteen call-site shapes are untouched, so this was
 * one edit instead of fourteen, and the seam stays where it already was.
 *
 * ── What persists, and what still does not ───────────────────────────────────
 * **Only `actor.role === 'admin'`.** The other twelve call sites are vendor, store, magazin
 * and agency SELF-SERVICE profile writes — `vendor-profile.service.ts` fires on every
 * profile save, `user.service.ts` on every password change. Persisting those would turn a
 * Phase-12 admin audit into an unbounded platform event stream with no retention owner, no
 * export path and no consumer, in a collection wi-admin's feed would then have to filter.
 *
 * They keep the console behaviour they have always had. `stream` on the row exists so
 * turning them on later is additive rather than a schema change.
 *
 * ── The session parameter ────────────────────────────────────────────────────
 * Optional, and the two admin call sites pass it. A row written outside the transaction it
 * describes can assert a change that rolled back, which is worse than no row. See the
 * recorder's header for why this is NOT the `destroyAllSessions` post-commit pattern.
 */
export class AuditLogger {
  /**
   * Record an audit entry.
   *
   * @param entry   the action, unchanged from the original interface
   * @param session the caller's transaction, where there is one. Pass it — an audit row
   *                that survives a rollback is a lie, and one that vanishes with it is the
   *                truth.
   */
  async log(entry: AuditLogEntry, session?: ClientSession): Promise<void> {
    if (entry.actor.role !== 'admin') {
      // Self-service. Console only, exactly as before — see the header for why.
      console.log('[Audit]', JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        actor: `${entry.actor.role}:${entry.actor.userId}`,
        action: entry.action,
        resource: `${entry.resource.type}:${entry.resource.id}`,
        ...(entry.changes && { changes: entry.changes }),
      }));
      return;
    }

    await recordAdminAction(
      {
        action: entry.action,
        resourceType: entry.resource.type,
        resourceId: entry.resource.id,
        actor: {
          userId: entry.actor.userId,
          role: entry.actor.role,
          name: typeof entry.actor.metadata?.name === 'string' ? entry.actor.metadata.name : null,
        },
        changes: entry.changes ?? null,
        metadata: entry.metadata ?? null,
      },
      session,
    );
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();
