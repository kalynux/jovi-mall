import { IRoleClosureRequest } from './models/role-closure-request.model';
import { RoleClosureBlocker, RoleClosureRequestStatus } from './role-closure.types';

/**
 * Two projections of one request — the administrator's and the user's.
 *
 * ── `status` is EFFECTIVE, not stored ─────────────────────────────────────────
 * Expiry is lazy (see the model), so a row can be stored `pending` and be past its expiry.
 * Both DTOs report `expired` for it; nothing on the wire ever shows a pending request that
 * can no longer be answered.
 *
 * ── The user's view names no administrator ────────────────────────────────────
 * The administrator's id belongs to the wi-admin database and their name is staff identity;
 * the notice says "an administrator", and so does this.
 */

export function effectiveStatus(request: IRoleClosureRequest, now: Date = new Date()): RoleClosureRequestStatus {
  if (request.status === 'pending' && request.expires_at.getTime() <= now.getTime()) return 'expired';
  return request.status;
}

function outcomeOf(request: IRoleClosureRequest) {
  return request.outcome
    ? {
      closedAt: request.outcome.closed_at.toISOString(),
      accountClosed: request.outcome.account_closed,
      endedRelationships: request.outcome.ended_relationships,
    }
    : null;
}

function warningsOf(request: IRoleClosureRequest) {
  return (request.warnings ?? []).map((w) => ({
    code: w.code,
    planCode: w.planCode ?? null,
    expiresAt: w.expiresAt ? new Date(w.expiresAt).toISOString() : null,
    amount: w.amount ?? null,
  }));
}

export function toAdminRoleClosureDto(request: IRoleClosureRequest) {
  return {
    id: request._id.toString(),
    userId: request.user_id.toString(),
    role: request.role,
    roleEntityId: request.role_entity_id.toString(),
    status: effectiveStatus(request),
    reason: request.reason,
    requestedBy: {
      id: request.requested_by_user_id.toString(),
      name: request.requested_by_name ?? null,
    },
    requestedAt: request.requested_at.toISOString(),
    expiresAt: request.expires_at.toISOString(),
    warnings: warningsOf(request),
    resolvedAt: request.resolved_at ? request.resolved_at.toISOString() : null,
    resolvedBy: request.resolved_by_user_id
      ? { id: request.resolved_by_user_id.toString(), source: request.resolved_by_source, name: request.resolved_by_name ?? null }
      : null,
    declineNote: request.decline_note ?? null,
    outcome: outcomeOf(request),
  };
}

export function toSelfRoleClosureDto(request: IRoleClosureRequest, blockers: RoleClosureBlocker[] | null) {
  return {
    id: request._id.toString(),
    role: request.role,
    status: effectiveStatus(request),
    reason: request.reason,
    requestedAt: request.requested_at.toISOString(),
    expiresAt: request.expires_at.toISOString(),
    warnings: warningsOf(request),
    /** Live, so a client can show "settle these first" before offering the button. */
    blockers,
    canConfirm: blockers !== null && blockers.length === 0 && effectiveStatus(request) === 'pending',
    outcome: outcomeOf(request),
  };
}
