import { Schema } from 'mongoose';
import { ActorSource, actorStampFields } from './actor-source.types';

/**
 * An administrator's cash-on-delivery restriction on one account — the stored shape and its
 * sub-schema, shared by the two role entities that carry it (`customers.cod_restriction`,
 * `delivery_agencies.cod_restriction`). The rule is `modules/cod/domain/cod-restriction.ts`.
 *
 * `null` (and an absent field, on every document written before 2026-10-10) means NOT
 * restricted. Embed it with `default: null` — never `default: () => ({})`: an empty
 * sub-document would spell "never restricted" and "restricted, fields missing" the same way.
 */
export interface ICodRestriction {
  /** Required — an unexplained restriction is unreviewable. Never shown to the restricted party. */
  reason: string;
  restricted_at: Date;
  restricted_by_user_id: string | null;
  restricted_by_source: ActorSource;
  restricted_by_name: string | null;
}

export const COD_RESTRICTION_REASON_MIN = 3;
export const COD_RESTRICTION_REASON_MAX = 500;

export const CodRestrictionSchema = new Schema(
  {
    reason: { type: String, required: true, trim: true, maxlength: COD_RESTRICTION_REASON_MAX },
    restricted_at: { type: Date, required: true },
    // Declared explicitly: `actorStampFields` supplies only `_source` and `_name`, and an
    // undeclared id is stripped by strict mode on write. A String, because an administrator's
    // id resolves in wi-admin, not here (same as the agency's cash-limit pin).
    restricted_by_user_id: { type: String, default: null },
    ...actorStampFields('restricted_by'),
  },
  { _id: false }
);
