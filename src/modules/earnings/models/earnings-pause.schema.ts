import { Schema } from 'mongoose';
import { actorStampFields, ActorSource } from '../../../core/types/actor-source.types';
import { EARNINGS_PAUSE_REASONS, EarningsPauseReason } from '../domain/earnings-hold';

/**
 * The earnings pause carried by an Order and by a Booking — the single source of truth
 * for "is this money paused". The `paused_at` copied onto each held allocation is only an
 * index for the release worker's query; this record is what it is copied from.
 *
 * Imports nothing but `core/` and the pure hold rules, so both models can embed it
 * without an import cycle.
 */
export interface IEarningsPause {
  active: boolean;
  reason: EarningsPauseReason | null;
  note: string | null;
  paused_at: Date | null;
  paused_by_user_id: string | null;
  paused_by_source: ActorSource;
  paused_by_name: string | null;
  resumed_at: Date | null;
  resumed_by_user_id: string | null;
  resumed_by_source: ActorSource;
  resumed_by_name: string | null;
  resume_note: string | null;
}

export const EarningsPauseSchema = new Schema<IEarningsPause>(
  {
    active: { type: Boolean, default: false },
    reason: { type: String, enum: [...EARNINGS_PAUSE_REASONS, null], default: null },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    paused_at: { type: Date, default: null },
    // A string, not an ObjectId: an administrator's id resolves in wi-admin's database,
    // never here (see actor-source.types.ts). `null` for a pause the system raised.
    paused_by_user_id: { type: String, default: null },
    ...actorStampFields('paused_by'),
    resumed_at: { type: Date, default: null },
    resumed_by_user_id: { type: String, default: null },
    ...actorStampFields('resumed_by'),
    resume_note: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: false }
);
