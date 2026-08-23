import { ClientSession, Types } from 'mongoose';
import { logger } from '../../../core/logging';
import { AgencyStockLevelRepository } from '../repositories/agency-stock-level.repository';
import {
  AgencyStockMovementRepository,
  agencyStockMovementRepository,
} from '../repositories/agency-stock-movement.repository';
import { StockMovementType } from '../models/agency-stock-movement.model';

/** One order line, as the order module already knows it. */
export interface ProjectableLine {
  variantId: string;
  quantity: number;
}

/**
 * The order lifecycle, projected onto depot shelves.
 *
 * `OrderStockService` owns four moments — reserve at checkout, commit at payment
 * success and at COD order creation, release on cancel and on the unpaid sweep,
 * restock on a returned shipment — and each of them moves the CATALOGUE counter
 * (`ProductVariant.stock`), which has no location dimension. For a SKU an agency
 * warehouses, the same event also moved something physical in a specific building.
 * This service is that second write, and nothing else performs it.
 *
 * ## Three properties, and each is load-bearing
 *
 * **1 · It never throws at its caller.** Every method swallows and logs. The order
 * path is a money path: a checkout that 500s because a depot row could not be updated
 * would refuse a sale over bookkeeping, and a payment webhook that throws here would
 * report an error for money that already moved. This is the same best-effort
 * discipline `OrderStockService.commitForOrder` already applies to the catalogue
 * counter, for the same reason.
 *
 * ⚠ The one honest caveat: when a caller hands over **its own transaction**, a failed
 * write inside it dooms that transaction whatever this service does with the
 * exception — swallowing an error does not un-abort a Mongo session. That is accepted
 * rather than worked around, because the alternative is worse: writing the hold
 * outside the checkout's transaction means a checkout that rolls back leaves a
 * `reservation` movement standing, and nothing will ever release it. A loud, retryable
 * failure beats a shelf that is permanently short by units nobody ordered.
 *
 * **2 · It only ever touches COUNTED rows.** A `derived` row is one nobody has
 * counted, and D-6 is explicit that the platform claims nothing about its quantity.
 * Projecting a sale onto it would invent a −1 for a shelf whose contents were never
 * recorded. Rows are skipped silently, and that is the ordinary case for an agency
 * that has not started doing intake.
 *
 * **3 · Every write is idempotent**, keyed on the reservation id `OrderStockService`
 * already derives (`"<cartId>:<variantId>"`). A retried webhook, a re-run sweep or a
 * double-committed order re-posts the same key and the unique index refuses the
 * second — so the shelf cannot be sold twice.
 */
export class AgencyStockProjectionService {
  constructor(
    private readonly stockLevels: AgencyStockLevelRepository = new AgencyStockLevelRepository(),
    private readonly movements: AgencyStockMovementRepository = agencyStockMovementRepository,
  ) { }

  /** A checkout is holding units on a shelf. */
  async reserve(cartId: string, lines: ProjectableLine[], session?: ClientSession): Promise<void> {
    await this.project('reservation', cartId, lines, null, null, session);
  }

  /** The hold was given up — the order was cancelled or swept unpaid. */
  async release(cartId: string, lines: ProjectableLine[], session?: ClientSession): Promise<void> {
    await this.project('reservation_released', cartId, lines, null, null, session);
  }

  /** Sold: the units leave the shelf and the hold ends with them. */
  async sell(
    cartId: string,
    lines: ProjectableLine[],
    orderId: string | null,
    session?: ClientSession,
  ): Promise<void> {
    await this.project('sale', cartId, lines, 'order', orderId, session);
  }

  /**
   * A returned shipment put units back.
   *
   * Keyed on the SHIPMENT, not the cart: a return is scoped to the parcel that came
   * back, and an order can produce several. Keying it on the cart would let the first
   * returned parcel's key swallow the second one's restock.
   */
  async restock(
    shipmentId: string,
    lines: ProjectableLine[],
    session?: ClientSession,
  ): Promise<void> {
    await this.project('customer_return', `shipment:${shipmentId}`, lines, 'shipment', shipmentId, session);
  }

  private async project(
    type: StockMovementType,
    keyPrefix: string,
    lines: ProjectableLine[],
    refType: 'order' | 'shipment' | null,
    refId: string | null,
    session?: ClientSession,
  ): Promise<void> {
    for (const line of lines) {
      if (!line.variantId || line.quantity <= 0) continue;

      try {
        const row = await this.stockLevels.findCountedByVariant(line.variantId);
        if (!row) continue;

        await this.movements.apply({
          agencyId: row.agency_id.toString(),
          stockLevelId: (row._id as Types.ObjectId).toString(),
          type,
          quantity: line.quantity,
          actorUserId: null,
          refType,
          refId,
          idempotencyKey: `${type}:${keyPrefix}:${line.variantId}`,
          session,
        });
      } catch (error) {
        // Never rethrown — see property 1 on the class. A missed projection leaves the
        // shelf reading high or low until the agency's next count_adjustment, which is
        // recoverable; failing the order that triggered it is not.
        logger().warn(
          { variantId: line.variantId, movementType: type, err: error },
          'agency stock projection skipped for order line',
        );
      }
    }
  }
}

export const agencyStockProjectionService = new AgencyStockProjectionService();
