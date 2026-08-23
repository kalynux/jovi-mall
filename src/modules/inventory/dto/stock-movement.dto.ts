import { Types } from 'mongoose';
import { IAgencyStockMovement, StockMovementType, StockMovementActorRole } from '../models/agency-stock-movement.model';

export interface StockMovementDto {
  id: string;
  type: StockMovementType;
  /** Signed. `-3` means three units left the shelf. */
  onHandDelta: number;
  reservedDelta: number;
  /** The balances this movement produced — what the shelf read immediately after it. */
  onHandAfter: number;
  reservedAfter: number;
  reason: string | null;
  actorRole: StockMovementActorRole;
  refType: string | null;
  refId: string | null;
  createdAt: Date | null;
}

/**
 * One movement, as an agency reads it.
 *
 * ⚠ **`actor_user_id` is deliberately NOT on the wire**, and `idempotency_key` is not either.
 * The first is an internal id an agency cannot resolve to a person (a system movement carries
 * none at all, and an agency movement carries a `users` id it has no lookup for) — `actorRole`
 * is the answer to the question they are actually asking, which is *"did somebody here do this,
 * or did an order?"*. The second is an internal dedup token and publishing it invites a client
 * to construct one.
 */
export function toMovementDto(movement: IAgencyStockMovement): StockMovementDto {
  return {
    id: (movement._id as Types.ObjectId).toString(),
    type: movement.type,
    onHandDelta: movement.on_hand_delta,
    reservedDelta: movement.reserved_delta,
    onHandAfter: movement.on_hand_after,
    reservedAfter: movement.reserved_after,
    reason: movement.reason ?? null,
    actorRole: movement.actor_role,
    refType: movement.ref_type ?? null,
    refId: movement.ref_id ? movement.ref_id.toString() : null,
    createdAt: (movement as unknown as { createdAt?: Date }).createdAt ?? null,
  };
}
