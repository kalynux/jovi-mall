import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { AgencyStockLevelRepository } from '../repositories/agency-stock-level.repository';
import {
  AgencyStockMovementRepository,
  agencyStockMovementRepository,
} from '../repositories/agency-stock-movement.repository';
import { IAgencyStockMovement } from '../models/agency-stock-movement.model';

export interface CountVerbResult {
  stockLevelId: string;
  quantityOnHand: number;
  quantityReserved: number;
  movementId: string;
  /** Signed, so a client can render "−3" without recomputing it. */
  appliedDelta: number;
}

export interface TransferResult {
  from: CountVerbResult;
  to: CountVerbResult;
}

export interface CountVerbActor {
  agencyId: string;
  userId: string | null;
}

/**
 * The agency's own count of what is on its shelves.
 *
 * ## Why this is a separate service from `AgencyStoredProductService`
 *
 * That one is **product-level and configuration-shaped** — which depot a product is
 * assigned to, whether it is storage-suspended. These verbs are **row-level and
 * physical**: this many units arrived at this shelf. They authorise the same way and
 * they act on the same collection, but conflating them would put "the vendor's
 * arrangement changed" and "a pallet turned up" behind one surface, and only one of
 * those needs a ledger entry.
 *
 * ## Intake is what makes a row counted (D-6)
 *
 * A row starts `derived`: the catalogue says a product is warehoused here, and the
 * platform claims nothing about quantity. The first `receipt` or `count_adjustment`
 * promotes it to `counted`, and from then on the order path projects sales onto it
 * (`AgencyStockProjectionService`) and the storage invoice bills against it. **Nothing
 * promotes a row automatically**, which is the operational cost D-6 accepted: an
 * agency that never records intake keeps a roster and no counts, exactly as before.
 */
export class AgencyStockCountService {
  constructor(
    private readonly stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
    private readonly movements: AgencyStockMovementRepository = agencyStockMovementRepository,
    private readonly magazins: MagazinRepository = new MagazinRepository(),
    /**
     * The transaction runner, injected.
     *
     * Two of these verbs read the row and write it in one transaction — the adjustment,
     * because the difference it applies is computed from what it just read, and the transfer,
     * because two movements must land together or neither. Both would otherwise reach
     * `transactionManager` through a module import and drag Mongo into a suite whose whole
     * value is being DB-free. Injecting it costs one parameter and makes the ordering rules
     * — out before in, refuse before credit — assertable.
     */
    private readonly runInTransaction: <T>(fn: (session: ClientSession) => Promise<T>) => Promise<T> =
      (fn) => transactionManager.runInTransactionWithRetry(fn),
  ) { }

  /** Goods arrived. The intake verb; the only way a row first becomes counted. */
  async recordReceipt(
    actor: CountVerbActor,
    stockLevelId: string,
    input: { quantity: number; reason?: string | null },
  ): Promise<CountVerbResult> {
    const applied = await this.movements.apply({
      agencyId: actor.agencyId,
      stockLevelId,
      type: 'receipt',
      quantity: input.quantity,
      reason: input.reason ?? null,
      actorUserId: actor.userId,
    });
    return toResult(applied.movement, applied.onHand, applied.reserved);
  }

  /** Goods went back to the vendor who owns them. */
  async recordReturnToVendor(
    actor: CountVerbActor,
    stockLevelId: string,
    input: { quantity: number; reason?: string | null },
  ): Promise<CountVerbResult> {
    const applied = await this.movements.apply({
      agencyId: actor.agencyId,
      stockLevelId,
      type: 'return_to_vendor',
      quantity: input.quantity,
      reason: input.reason ?? null,
      actorUserId: actor.userId,
    });
    return toResult(applied.movement, applied.onHand, applied.reserved);
  }

  /**
   * Somebody counted the shelf and the record was wrong.
   *
   * **The caller supplies what they counted, not a delta**, and the difference is
   * computed here — inside the transaction that applies it, so a concurrent sale
   * cannot land between the read and the write and turn a correction into a second
   * error. A delta-shaped API would also be the wrong question to ask a human
   * standing at a shelf: they know there are twelve, not that there are three fewer
   * than a number they cannot see.
   *
   * A count that matches the record is not an error and not a no-op — it writes a
   * zero-delta movement, because "we checked, and it was right" is worth having in
   * the ledger. It is the only movement type allowed to be zero.
   */
  async recordCountAdjustment(
    actor: CountVerbActor,
    stockLevelId: string,
    input: { countedQuantity: number; reason: string },
  ): Promise<CountVerbResult> {
    return this.runInTransaction(async (session) => {
      const row = await this.stockLevels.findRawByIdForAgency(stockLevelId, actor.agencyId, session);
      if (!row) {
        throw createAppError(
          ERROR_CODES.INVENTORY_STOCK_LEVEL_NOT_FOUND,
          404,
          'Inventory record not found.',
        );
      }

      const delta = input.countedQuantity - row.quantity_on_hand;
      const applied = await this.movements.apply({
        agencyId: actor.agencyId,
        stockLevelId,
        type: 'count_adjustment',
        quantity: delta,
        reason: input.reason,
        actorUserId: actor.userId,
        session,
      });
      return toResult(applied.movement, applied.onHand, applied.reserved);
    });
  }

  /**
   * The same goods, a different building of the same agency.
   *
   * Two movements, one transaction, so units are never in both places or neither.
   * The destination row is created if this agency has never held that SKU there.
   *
   * ⚠ **This moves stock, not configuration.** The product still names the depot its
   * vendor chose, so the next reconcile re-derives the source row — which is correct:
   * the arrangement is unchanged and only the goods moved. Repointing the arrangement
   * is `AgencyStoredProductService.changeDepot`, which refuses while counted stock is
   * sitting on the row precisely so the two cannot be confused.
   */
  async transfer(
    actor: CountVerbActor,
    stockLevelId: string,
    input: { toLocationId: string | null; quantity: number; reason?: string | null },
  ): Promise<TransferResult> {
    if (input.toLocationId !== null) {
      const depots = await this.magazins.findHqAddressIdsByAgencyId(actor.agencyId);
      if (!(depots ?? []).includes(input.toLocationId)) {
        throw createAppError(
          ERROR_CODES.INVENTORY_LOCATION_UNKNOWN,
          422,
          'That depot is not one of yours.',
          { locationId: input.toLocationId },
        );
      }
    }

    return this.runInTransaction(async (session) => {
      const source = await this.stockLevels.findRawByIdForAgency(stockLevelId, actor.agencyId, session);
      if (!source) {
        throw createAppError(
          ERROR_CODES.INVENTORY_STOCK_LEVEL_NOT_FOUND,
          404,
          'Inventory record not found.',
        );
      }

      const currentLocation = source.location_id ? source.location_id.toString() : null;
      if (currentLocation === input.toLocationId) {
        throw createAppError(
          ERROR_CODES.INVENTORY_TRANSFER_SAME_LOCATION,
          422,
          'That stock is already at this depot.',
        );
      }

      const destination = await this.stockLevels.findOrCreateCountedRow(
        actor.agencyId,
        input.toLocationId,
        {
          vendorId: source.vendor_id,
          productId: source.product_id,
          variantId: source.variant_id,
        },
        session,
      );

      // Out first: a transfer that cannot be paid for by the source shelf must fail
      // before anything is credited to the destination. The 422 rolls the whole
      // transaction back, so the destination row created a moment ago goes with it.
      const out = await this.movements.apply({
        agencyId: actor.agencyId,
        stockLevelId,
        type: 'transfer_out',
        quantity: input.quantity,
        reason: input.reason ?? null,
        actorUserId: actor.userId,
        refType: 'transfer',
        refId: (destination._id as Types.ObjectId).toString(),
        session,
      });

      const into = await this.movements.apply({
        agencyId: actor.agencyId,
        stockLevelId: (destination._id as Types.ObjectId).toString(),
        type: 'transfer_in',
        quantity: input.quantity,
        reason: input.reason ?? null,
        actorUserId: actor.userId,
        refType: 'transfer',
        refId: stockLevelId,
        session,
      });

      return {
        from: toResult(out.movement, out.onHand, out.reserved),
        to: toResult(into.movement, into.onHand, into.reserved),
      };
    });
  }

  /** One shelf's movement history, newest first. */
  async listMovements(
    agencyId: string,
    stockLevelId: string,
    page: number,
    limit: number,
  ): Promise<{ data: IAgencyStockMovement[]; total: number }> {
    const row = await this.stockLevels.findRawByIdForAgency(stockLevelId, agencyId);
    if (!row) {
      throw createAppError(
        ERROR_CODES.INVENTORY_STOCK_LEVEL_NOT_FOUND,
        404,
        'Inventory record not found.',
      );
    }
    return this.movements.listForStockLevel(agencyId, stockLevelId, limit, (page - 1) * limit);
  }
}

function toResult(
  movement: IAgencyStockMovement,
  onHand: number,
  reserved: number,
): CountVerbResult {
  return {
    stockLevelId: movement.stock_level_id.toString(),
    quantityOnHand: onHand,
    quantityReserved: reserved,
    movementId: (movement._id as Types.ObjectId).toString(),
    appliedDelta: movement.on_hand_delta,
  };
}

export const agencyStockCountService = new AgencyStockCountService();
