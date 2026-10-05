import { IAdminSnapshot } from './admin-snapshot.types';

/**
 * The platform itself, as the author of what it does on its own: a refund-owed ticket, a
 * dispute ticket, an automatic payout request.
 *
 * ── Why a built-in identity and not a configured account ────────────────────
 * This used to be `SUPPORT_ADMIN_USER_ID`, documented as "an admin `users._id`". Since the
 * Phase 5 cutover no administrator has a `users` row — they all live in wi-admin's database —
 * so there was nothing correct to put in it, and while it was unset every system ticket was
 * silently skipped: a chargeback processed and nobody told, a refund owed and no ticket.
 * Owner decision 2026-10-05: the system signs its own tickets.
 *
 * ── How it reads everywhere ──────────────────────────────────────────────────
 * The id resolves to nothing in either database. That is the same arrangement as every ticket
 * an administrator opens through wi-admin (`requireAdminCaller` writes their wi-admin id where
 * a `users` id would go), and it is safe for the same reason: nothing dereferences a ticket's
 * creator id. Every reader — wi-admin's dashboard, the seller's and customer's apps — renders
 * the creator from the SNAPSHOT stored on the ticket, which is `SYSTEM_ADMIN_SNAPSHOT`.
 *
 * Never reuse this id for a person, and never let a request claim it: it is written only by
 * code paths that act on the platform's own behalf.
 */
export const SYSTEM_ACTOR_ID = '000000000000000000000001';

export const SYSTEM_ADMIN_SNAPSHOT: IAdminSnapshot = Object.freeze({
  id: SYSTEM_ACTOR_ID,
  source: 'admin',
  name: 'Wi-Mall (automatic)',
  // Tier 1 because the platform acts with full authority. No read scope keys on a ticket's
  // CREATOR's tier (wi-admin scopes on the assigned administrator), so this decides nothing.
  tier: 1,
  job_title: 'Automatic notice',
  department: null,
  avatar_url: null,
}) as IAdminSnapshot;

export function isSystemActor(userId: string | null | undefined): boolean {
  return userId === SYSTEM_ACTOR_ID;
}
