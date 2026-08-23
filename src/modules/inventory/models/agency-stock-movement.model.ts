import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Why a depot row's quantities changed.
 *
 * Nine values in three groups, and the group a value is in decides who may write
 * it — see `MOVEMENT_RULES` for the deltas and `AgencyStockCountService` /
 * `AgencyStockProjectionService` for the two writers.
 *
 * ## The agency's own count (`actor_role: 'agency'`)
 *
 * - `receipt` — goods physically arrived. **This is the intake D-6 asks for**, and
 *   until one happens a row has no counted quantity at all.
 * - `return_to_vendor` — goods left, back to the vendor who owns them.
 * - `count_adjustment` — somebody walked the shelf and the record was wrong. Signed,
 *   reason required. This is the *variance* verb: the whole point of D-6's
 *   independent count is that the depot number may disagree with the catalogue, and
 *   this is where a human says which one was right.
 * - `transfer_out` / `transfer_in` — the same goods, a different building of the
 *   same agency. Written as a PAIR in one transaction, never alone.
 *
 * ## The order lifecycle (`actor_role: 'system'`)
 *
 * Projected from the four moments `OrderStockService` already owns — see
 * `AgencyStockProjectionService`, which is the only thing that writes these.
 *
 * - `reservation` — a checkout is holding units.
 * - `reservation_released` — that hold was given up (cancelled or swept).
 * - `sale` — the units are sold and leave the shelf.
 * - `customer_return` — a returned shipment put them back.
 */
export type StockMovementType =
  | 'receipt'
  | 'return_to_vendor'
  | 'count_adjustment'
  | 'transfer_out'
  | 'transfer_in'
  | 'reservation'
  | 'reservation_released'
  | 'sale'
  | 'customer_return';

/** Who caused the movement. Not an authorization field — a provenance one. */
export type StockMovementActorRole = 'agency' | 'system';

export interface IAgencyStockMovement extends IBaseDocument {
  agency_id: Types.ObjectId;
  /** The row whose counters this moved. */
  stock_level_id: Types.ObjectId;
  /** Denormalised so the order path can find a SKU's movements without a join. */
  variant_id: Types.ObjectId;
  /** Denormalised, and null exactly when the row's `location_id` is. */
  location_id: Types.ObjectId | null;

  type: StockMovementType;

  /**
   * Signed. The counter after this movement is `before + delta`, which is what
   * makes `quantity_on_hand === Σ on_hand_delta` checkable by summing this column.
   */
  on_hand_delta: number;
  reserved_delta: number;

  /**
   * The balances this movement produced, snapshotted the way `EarningsLedger` and
   * `CodCashLedger` snapshot theirs. Redundant with the sum — deliberately. It is
   * what turns "the numbers disagree" into "they diverged at this row".
   */
  on_hand_after: number;
  reserved_after: number;

  /** Required on `count_adjustment`, free on everything else. */
  reason: string | null;

  actor_role: StockMovementActorRole;
  /** Null for system movements; the agency user for the rest. */
  actor_user_id: Types.ObjectId | null;

  /** What this movement was about, when it was about something. */
  ref_type: 'order' | 'shipment' | 'reservation' | 'transfer' | null;
  ref_id: Types.ObjectId | null;

  /**
   * The idempotency key for a system movement.
   *
   * `"<type>:<reservationId>"`, where the reservation id is the one
   * `OrderStockService` already derives as `"<cartId>:<variantId>"`. A retried
   * payment webhook therefore re-posts the same key and the unique index refuses
   * it, rather than selling the same units twice.
   *
   * Null on an agency movement: two identical receipts on the same day are two
   * real deliveries, not a double-submit, and the platform must not merge them.
   */
  idempotency_key: string | null;
}

const AgencyStockMovementSchema = new Schema<IAgencyStockMovement>({
  agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
  stock_level_id: { type: Schema.Types.ObjectId, ref: MODELS.AGENCY_STOCK_LEVEL, required: true },
  variant_id: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_VARIANT, required: true },
  // No `ref` — a subdocument of magazin.headquarters_addresses[], same as the row's.
  location_id: { type: Schema.Types.ObjectId, default: null },

  type: {
    type: String,
    enum: [
      'receipt',
      'return_to_vendor',
      'count_adjustment',
      'transfer_out',
      'transfer_in',
      'reservation',
      'reservation_released',
      'sale',
      'customer_return',
    ],
    required: true,
  },

  on_hand_delta: { type: Number, required: true, default: 0 },
  reserved_delta: { type: Number, required: true, default: 0 },
  on_hand_after: { type: Number, required: true },
  reserved_after: { type: Number, required: true },

  reason: { type: String, default: null, maxlength: 500, trim: true },

  actor_role: { type: String, enum: ['agency', 'system'], required: true },
  actor_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },

  ref_type: { type: String, enum: ['order', 'shipment', 'reservation', 'transfer', null], default: null },
  ref_id: { type: Schema.Types.ObjectId, default: null },

  idempotency_key: { type: String, default: null },

  ...BaseSchemaFields,
}, BaseSchemaOptions);

/**
 * The ledger this collection is: one row per movement, never updated.
 *
 * ⚠ **There is no `deletedAt: null` filter on the reconciler's sum**, and there
 * must not be: a soft-deleted ledger row would silently change a balance that a
 * hundred later rows already snapshotted. Nothing in this module deletes one.
 */
AgencyStockMovementSchema.index({ stock_level_id: 1, createdAt: -1 });
AgencyStockMovementSchema.index({ agency_id: 1, createdAt: -1 });
AgencyStockMovementSchema.index({ variant_id: 1, createdAt: -1 });

/**
 * Sparse, so the agency movements — which all carry null — do not collide with
 * each other on it. Partial rather than plain-sparse because Mongo indexes null
 * as a value: `{ idempotency_key: { $type: 'string' } }` is what excludes them.
 */
AgencyStockMovementSchema.index(
  { idempotency_key: 1 },
  { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } },
);

export const AgencyStockMovementModel = model<IAgencyStockMovement>(
  MODELS.AGENCY_STOCK_MOVEMENT,
  AgencyStockMovementSchema,
  COLLECTIONS.AGENCY_STOCK_MOVEMENT,
);
