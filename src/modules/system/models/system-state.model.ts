import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { MAINTENANCE_MODES, MaintenanceMode } from '../domain/maintenance-mode';

/**
 * `system_state` — a single document, `_id: 'maintenance'`.
 *
 * ── Why Mongo and not somewhere cheaper ───────────────────────────────────────
 * Maintenance mode has two requirements that together rule out the obvious options: it must
 * survive a restart, and it must converge across instances. This service has no cross-instance
 * coordination at all today (`dev-tools/worker-registry.ts` documents that gap explicitly).
 *
 *   env var / file   survives restart, does not converge, needs a deploy to change. No.
 *   Redis            converges instantly — but this service connects to Redis lazily and its
 *                    persistence is not guaranteed here, so a Redis restart would SILENTLY DROP
 *                    maintenance mode. That is the worst available failure direction: the
 *                    platform reopens for writes in the middle of a migration and nobody is
 *                    told.
 *   Mongo            already a hard dependency — if it is down nothing serves anyway, so this
 *                    adds no new failure mode — and durable across restart by definition.
 *
 * Reads do not hit Mongo per request; `services/maintenance.service.ts` caches for a few
 * seconds and states the convergence bound on the wire.
 *
 * The `_id` is a literal string rather than an ObjectId because there is exactly one row and
 * `findById('maintenance')` is then the whole read. A collection that can only ever hold one
 * document should not need a query to find it.
 */

export const MAINTENANCE_STATE_ID = 'maintenance';

/**
 * `Document<string>` rather than the bare `Document`: the `_id` is a literal string here, and
 * Mongoose's default generic pins it to `ObjectId`.
 */
export interface ISystemState extends Document<string> {
  _id: string;
  mode: MaintenanceMode;
  reason: string | null;
  block_webhooks: boolean;
  pause_workers: boolean;
  started_at: Date | null;
  expires_at: Date | null;
  /**
   * Who set it. An `admin`-source id (see `core/types/actor-source.types.ts`): administrators
   * live in wi-admin's database and hold no row here, so this resolves to nothing locally and
   * the name is snapshotted beside it because a cross-database join cannot exist.
   */
  actor_id: string | null;
  actor_name: string | null;
  updated_at: Date;
}

const SystemStateSchema = new Schema<ISystemState>(
  {
    _id: { type: String, required: true },
    mode: { type: String, enum: [...MAINTENANCE_MODES], default: 'off' },
    reason: { type: String, default: null },
    block_webhooks: { type: Boolean, default: false },
    pause_workers: { type: Boolean, default: false },
    started_at: { type: Date, default: null },
    expires_at: { type: Date, default: null },
    actor_id: { type: String, default: null },
    actor_name: { type: String, default: null },
  },
  {
    timestamps: { createdAt: false, updatedAt: 'updated_at' },
    // The `_id` is ours, not Mongoose's.
    _id: false,
  },
);

export const SystemStateModel = mongoose.model<ISystemState>(
  MODELS.SYSTEM_STATE,
  SystemStateSchema,
  COLLECTIONS.SYSTEM_STATE,
);
