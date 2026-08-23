import { StockMovementType } from '../../models/agency-stock-movement.model';

/**
 * What each movement type does to a depot row's two counters, and who may write it.
 *
 * **The deltas live here and nowhere else.** Both writers — the agency's count verbs
 * and the order-path projection — go through `deltasFor`, so "a sale takes it off the
 * shelf AND off the hold" is stated once. The failure mode this prevents is the one
 * that cannot be spotted by reading either writer alone: two call sites that agree
 * about `receipt` and disagree about `sale`.
 *
 * Pure — no I/O, no clock — so every rule below is testable without Mongo.
 */

export interface MovementDeltas {
  onHand: number;
  reserved: number;
}

export interface MovementRule {
  /** Multiplier applied to the (always positive) quantity a caller supplies. */
  onHandSign: -1 | 0 | 1;
  reservedSign: -1 | 0 | 1;
  /** `count_adjustment` is the one type whose quantity is signed by the caller. */
  signedQuantity?: boolean;
  writer: 'agency' | 'system';
  requiresReason?: boolean;
}

export const MOVEMENT_RULES: Readonly<Record<StockMovementType, MovementRule>> = Object.freeze({
  // ── The agency's own count ──────────────────────────────────────────────────
  receipt: { onHandSign: 1, reservedSign: 0, writer: 'agency' },
  return_to_vendor: { onHandSign: -1, reservedSign: 0, writer: 'agency' },
  count_adjustment: { onHandSign: 1, reservedSign: 0, writer: 'agency', signedQuantity: true, requiresReason: true },
  transfer_out: { onHandSign: -1, reservedSign: 0, writer: 'agency' },
  transfer_in: { onHandSign: 1, reservedSign: 0, writer: 'agency' },

  // ── The order lifecycle, projected ─────────────────────────────────────────
  // A reservation does NOT move on-hand: the units are still on the shelf, they are
  // just spoken for. `available = on_hand − reserved` is the same split
  // `InventoryAvailabilityCalculator` already computes for the catalogue counter.
  reservation: { onHandSign: 0, reservedSign: 1, writer: 'system' },
  reservation_released: { onHandSign: 0, reservedSign: -1, writer: 'system' },
  // The sale is the moment both move: the hold ends because the units left.
  sale: { onHandSign: -1, reservedSign: -1, writer: 'system' },
  // A return is NOT the inverse of a sale — the hold was already consumed, so only
  // the shelf moves. Getting this wrong drives `reserved` permanently positive.
  customer_return: { onHandSign: 1, reservedSign: 0, writer: 'system' },
});

/**
 * The signed deltas a movement of `quantity` produces.
 *
 * `quantity` is a positive magnitude for every type except `count_adjustment`,
 * which is the one verb where the caller knows the direction (the shelf held two
 * fewer than the record said) and a magnitude would lose it.
 */
export function deltasFor(type: StockMovementType, quantity: number): MovementDeltas {
  const rule = MOVEMENT_RULES[type];
  const magnitude = rule.signedQuantity ? quantity : Math.abs(quantity);
  return {
    onHand: rule.onHandSign * magnitude,
    reserved: rule.reservedSign * magnitude,
  };
}

/** Every type an agency user may post directly. */
export function isAgencyWritable(type: StockMovementType): boolean {
  return MOVEMENT_RULES[type].writer === 'agency';
}

/**
 * True when this movement, applied to these balances, would drive a counter below
 * zero.
 *
 * **Only agency movements are refused on it.** A system movement is allowed
 * through, and that is deliberate: if the shelf record says 0 and an order sells
 * one, the truth is that the record was wrong, and clamping would make
 * `quantity_on_hand === Σ deltas` false — the one invariant the reconciler checks.
 * A negative balance is the platform saying "more went out than was ever recorded
 * in", which is exactly the variance an agency needs to see and settle with a
 * `count_adjustment`. See `AgencyStockLevelRepository.applyMovement`.
 */
export function wouldGoNegative(
  current: { onHand: number; reserved: number },
  deltas: MovementDeltas,
): boolean {
  return current.onHand + deltas.onHand < 0 || current.reserved + deltas.reserved < 0;
}
