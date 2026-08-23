import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { AgencyStockLevelModel } from '../models/agency-stock-level.model';
import {
  AgencyStockMovementModel,
  IAgencyStockMovement,
  StockMovementType,
  StockMovementActorRole,
} from '../models/agency-stock-movement.model';
import { MOVEMENT_RULES, deltasFor } from '../domain/services/stock-movement.rules';

export interface ApplyMovementInput {
  agencyId: string;
  stockLevelId: string;
  type: StockMovementType;
  /** Positive magnitude, except on `count_adjustment` where the sign is the answer. */
  quantity: number;
  reason?: string | null;
  actorUserId?: string | null;
  refType?: 'order' | 'shipment' | 'reservation' | 'transfer' | null;
  refId?: string | null;
  /** Required for system movements; see the model's field docstring. */
  idempotencyKey?: string | null;
  /** Join the caller's transaction — a transfer writes two movements in one. */
  session?: ClientSession;
}

export interface AppliedMovement {
  movement: IAgencyStockMovement;
  onHand: number;
  reserved: number;
  /** False when an idempotency key had already been spent — nothing moved. */
  applied: boolean;
}

export interface MovementLedgerSums {
  onHand: number;
  reserved: number;
}

/**
 * The only writer of a depot row's counted quantities.
 *
 * ## Why the counters are not written anywhere else
 *
 * A counter and its ledger have to move together or the ledger is decoration. Both
 * writes happen here, in one transaction, and the balance the counter lands on is
 * what gets snapshotted onto the movement — so `quantity_on_hand === Σ on_hand_delta`
 * is true by construction rather than by everybody remembering. The reconciler
 * checks it anyway (`AgencyInventoryReconciler.findDrift`), because "true by
 * construction" is a claim about code that will be edited.
 *
 * That is the same shape `CodCashLedger` uses, and P-14 is the reason it is copied
 * rather than improvised: the invariant an application maintains is
 * `balance === Σ its ledger`, never a re-derivation from some other collection.
 *
 * ## The non-negative rule is asymmetric, and deliberately
 *
 * An **agency** movement that would drive a counter below zero is refused (422): a
 * human is claiming to have shipped out more than the shelf holds, and the honest
 * answer is that one of the two numbers is wrong.
 *
 * A **system** movement is applied regardless. If the shelf record says 0 and an
 * order sells one, refusing would either break checkout for a bookkeeping gap or —
 * worse — clamp, which makes the invariant above false and hides the gap for good.
 * A negative balance is a *variance the agency can see and settle* with a
 * `count_adjustment`, and that is the point of D-6's independent count.
 */
export class AgencyStockMovementRepository {
  /**
   * Move a row's counters and record why, atomically.
   *
   * The counter write is a **compare-and-set**, not a read-then-write: the
   * non-negative bound is in the filter, so two concurrent sales cannot both pass a
   * check and then both apply. A filter miss is disambiguated by a follow-up read —
   * a missing row is a 404 for the caller, an insufficient one a 422.
   */
  async apply(input: ApplyMovementInput): Promise<AppliedMovement> {
    const run = <T>(fn: (s: ClientSession) => Promise<T>): Promise<T> =>
      input.session ? fn(input.session) : transactionManager.runInTransactionWithRetry(fn);

    return run(async (session) => {
      const rule = MOVEMENT_RULES[input.type];
      const deltas = deltasFor(input.type, input.quantity);

      if (input.idempotencyKey) {
        const spent = await AgencyStockMovementModel.findOne({ idempotency_key: input.idempotencyKey })
          .session(session)
          .exec();
        if (spent) {
          return {
            movement: spent,
            onHand: spent.on_hand_after,
            reserved: spent.reserved_after,
            applied: false,
          };
        }
      }

      const filter: Record<string, unknown> = {
        _id: new Types.ObjectId(input.stockLevelId),
        agency_id: new Types.ObjectId(input.agencyId),
        deletedAt: null,
      };

      // The bound goes in the FILTER for an agency movement, which is what makes it
      // a compare-and-set. A system movement carries no bound at all — see the class
      // docstring for why it is allowed to go negative.
      if (rule.writer === 'agency') {
        if (deltas.onHand < 0) filter.quantity_on_hand = { $gte: -deltas.onHand };
        if (deltas.reserved < 0) filter.quantity_reserved = { $gte: -deltas.reserved };
      }

      const update: Record<string, unknown> = {
        $inc: { quantity_on_hand: deltas.onHand, quantity_reserved: deltas.reserved },
      };
      // The first agency movement is what makes a row COUNTED. A system movement
      // never promotes one — `AgencyStockProjectionService` only ever addresses rows
      // that are counted already, so a row nobody has counted stays honestly derived.
      if (rule.writer === 'agency') {
        (update as { $set?: Record<string, unknown> }).$set = { source: 'counted' };
      }

      const row = await AgencyStockLevelModel.findOneAndUpdate(filter, update, {
        new: true,
        session,
      }).exec();

      if (!row) {
        const exists = await AgencyStockLevelModel.findOne({
          _id: new Types.ObjectId(input.stockLevelId),
          agency_id: new Types.ObjectId(input.agencyId),
          deletedAt: null,
        })
          .session(session)
          .exec();

        if (!exists) {
          throw createAppError(
            ERROR_CODES.INVENTORY_STOCK_LEVEL_NOT_FOUND,
            404,
            'Inventory record not found.',
          );
        }

        throw createAppError(
          ERROR_CODES.INVENTORY_INSUFFICIENT_STOCK,
          422,
          undefined,
          {
            quantityOnHand: exists.quantity_on_hand,
            quantityReserved: exists.quantity_reserved,
            requested: Math.abs(deltas.onHand || deltas.reserved),
          },
        );
      }

      const [movement] = await AgencyStockMovementModel.create(
        [
          {
            agency_id: row.agency_id,
            stock_level_id: row._id,
            variant_id: row.variant_id,
            location_id: row.location_id,
            type: input.type,
            on_hand_delta: deltas.onHand,
            reserved_delta: deltas.reserved,
            on_hand_after: row.quantity_on_hand,
            reserved_after: row.quantity_reserved,
            reason: input.reason ?? null,
            actor_role: rule.writer as StockMovementActorRole,
            actor_user_id: input.actorUserId ? new Types.ObjectId(input.actorUserId) : null,
            ref_type: input.refType ?? null,
            ref_id: input.refId && Types.ObjectId.isValid(input.refId) ? new Types.ObjectId(input.refId) : null,
            idempotency_key: input.idempotencyKey ?? null,
          },
        ],
        { session },
      );

      return {
        movement,
        onHand: row.quantity_on_hand,
        reserved: row.quantity_reserved,
        applied: true,
      };
    });
  }

  /** One row's movements, newest first. The audit an agency reads on a shelf. */
  async listForStockLevel(
    agencyId: string,
    stockLevelId: string,
    limit: number,
    skip: number,
  ): Promise<{ data: IAgencyStockMovement[]; total: number }> {
    const query = {
      agency_id: new Types.ObjectId(agencyId),
      stock_level_id: new Types.ObjectId(stockLevelId),
    };
    const [data, total] = await Promise.all([
      AgencyStockMovementModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
      AgencyStockMovementModel.countDocuments(query).exec(),
    ]);
    return { data, total };
  }

  /**
   * What the ledger says each of these rows should hold.
   *
   * The reconciler's input. Rows with no movements are ABSENT from the map, which
   * is not the same as zero — a derived row has no ledger and is not in drift.
   */
  async sumByStockLevels(stockLevelIds: Types.ObjectId[]): Promise<Map<string, MovementLedgerSums>> {
    if (stockLevelIds.length === 0) return new Map();

    const rows = await AgencyStockMovementModel.aggregate<{
      _id: Types.ObjectId;
      onHand: number;
      reserved: number;
    }>([
      { $match: { stock_level_id: { $in: stockLevelIds } } },
      {
        $group: {
          _id: '$stock_level_id',
          onHand: { $sum: '$on_hand_delta' },
          reserved: { $sum: '$reserved_delta' },
        },
      },
    ]).exec();

    return new Map(rows.map(r => [r._id.toString(), { onHand: r.onHand, reserved: r.reserved }]));
  }
}

export const agencyStockMovementRepository = new AgencyStockMovementRepository();
