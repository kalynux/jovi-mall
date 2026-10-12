import { ActorSource } from '../../../core/types/actor-source.types';
import { ICodRestriction } from '../../../core/types/cod-restriction.types';

export { COD_RESTRICTION_REASON_MAX, COD_RESTRICTION_REASON_MIN } from '../../../core/types/cod-restriction.types';
export type { ICodRestriction } from '../../../core/types/cod-restriction.types';

/**
 * ─── The administrator's COD restriction: the rule, as pure functions ────────
 *
 * Owner decision, 2026-10-10. An administrator may switch cash on delivery OFF for one
 * CUSTOMER or one delivery AGENCY, and back on. Nothing else changes: with no restriction
 * recorded — the state of every account written before this existed — COD behaves exactly
 * as it did.
 *
 *   customer   a restricted customer cannot PLACE a cash-on-delivery order. The Returns
 *              policy (§ 3.4) says refusing parcels without a valid reason "may lead us to
 *              restrict cash on delivery on your account"; this is that lever.
 *   agency     a restricted agency receives NO NEW cash-on-delivery work: checkout refuses
 *              COD for a basket it would carry, and a COD shipment is never handed to it
 *              (auto-redirect holds, a manual hand-off refuses — and `force` does not waive
 *              it, because `force` waives AMOUNT limits and this is not an amount).
 *
 * ── What a restriction does NOT touch ───────────────────────────────────────
 *   - orders already placed and parcels already with the agency — they run to the end;
 *   - the cash chain (collections, deposits, remittances) — a restricted agency still
 *     owes, and can still hand over, the cash it holds;
 *   - prepaid orders, and the delivery fee paid to the rider in cash on a prepaid order;
 *   - the agency's own `policies.cod.enabled` switch and its cash limit — the restriction
 *     sits ABOVE both and rewrites neither, so lifting it returns the agency to exactly
 *     what it had configured.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 * One sub-document on the role entity (`customers.cod_restriction`,
 * `delivery_agencies.cod_restriction`; stored shape in `core/types/cod-restriction.types.ts`),
 * `null` when unrestricted. Same posture as the
 * agency's `cod_limit_override` and the agent's pool pin: a separate field only
 * `CodRestrictionService` writes, reason required, actor stamped.
 *
 * Nothing here reads a database.
 */

export const COD_RESTRICTION_SUBJECTS = ['customer', 'agency'] as const;
export type CodRestrictionSubject = (typeof COD_RESTRICTION_SUBJECTS)[number];

/**
 * Is cash on delivery restricted? An absent field (every document written before
 * 2026-10-10) and `null` both read as NOT restricted — the baseline is "as it was".
 */
export function isCodRestricted(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const at = (stored as { restricted_at?: unknown }).restricted_at;
  return at !== null && at !== undefined;
}

/** The administrator's view of one restriction. */
export interface CodRestrictionView {
  reason: string;
  restrictedAt: Date;
  restrictedByUserId: string | null;
  restrictedBySource: ActorSource;
  restrictedByName: string | null;
}

export function codRestrictionViewOf(stored: unknown): CodRestrictionView | null {
  if (!isCodRestricted(stored)) return null;
  const r = stored as Partial<ICodRestriction>;
  return {
    reason: r.reason ?? '',
    restrictedAt: r.restricted_at as Date,
    restrictedByUserId: r.restricted_by_user_id ?? null,
    restrictedBySource: r.restricted_by_source ?? 'platform',
    restrictedByName: r.restricted_by_name ?? null,
  };
}

/**
 * What the RESTRICTED PARTY may see: that it is restricted and since when. The reason and
 * the author are the administrator's — the same split the agency's limit pin makes
 * (`CodLimitsService.reportForAgency`).
 */
export interface CodRestrictionPublicView {
  restricted: boolean;
  restrictedAt: Date | null;
}

export function codRestrictionPublicViewOf(stored: unknown): CodRestrictionPublicView {
  const view = codRestrictionViewOf(stored);
  return { restricted: view !== null, restrictedAt: view?.restrictedAt ?? null };
}
