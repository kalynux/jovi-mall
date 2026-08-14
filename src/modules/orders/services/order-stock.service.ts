/**
 * An order's stock-reservation lifecycle, in one place.
 *
 * Before this, **nothing in the order path ever changed `variant.stock`**. Adding to cart
 * reserved nothing, order creation did not read or write it, payment success touched
 * `lastOrderedAt` and not stock, and the unpaid-order sweep said so in its own comment.
 * `variant.stock` was a number a vendor typed in, and overselling was completely
 * unconstrained. A `StockReservation` model and three services existed with the right
 * shape and had **zero call sites anywhere** — this is what wires them.
 *
 * ── Why an orchestrator rather than calls at each site ──────────────────────
 *
 * The four moments that move stock are in four different files (checkout, payment success,
 * cancellation, the unpaid sweep), and each needs the same two things: the reservation id
 * for a line, and the decision about which lines even have one. Spreading that across the
 * call sites is how the id convention drifts and a path quietly stops releasing. Here, the
 * convention is one function and every caller is one line.
 *
 * ── The reservation id is DERIVED, never stored ─────────────────────────────
 *
 * `reservationId = "<cartId>:<variantId>"`. Both halves are already on the order
 * (`order.cart_id`, `item.variant_id`), so commit and release can reconstruct the exact id
 * checkout used with no new column and no migration. It is also the natural idempotency
 * key: `StockReservationService` returns the existing row when the same id is reserved
 * twice, so a retried checkout holds units once rather than twice.
 *
 * A cart id is unique per checkout group and a variant appears at most once per cart, so
 * the pair cannot collide — including across the several per-vendor orders that share one
 * cart, since those differ in their variants.
 *
 * ── What "release" does and does not cover ──────────────────────────────────
 *
 * Release applies to a hold that has not been committed — an unpaid order, cancelled or
 * swept. Once committed, the units are sold and `StockReleaseService` refuses by design.
 * A refund or a returned shipment is therefore **not** a release: the goods physically come
 * back, which is a restock. `restockForOrder` is that operation, and it is deliberately a
 * different method with a different name so the two are never confused.
 */
import { ClientSession } from 'mongoose';
import { logger } from '../../../core/logging';
import { transactionManager } from '../../../core/database/transaction.manager';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { StockReservationRepositoryMongo } from '../../catalog/repositories/mongo/stock-reservation.repository.mongo';
import { DigitalAssetRepositoryMongo } from '../../catalog/repositories/mongo/digital-asset.repository.mongo';
import { AvailabilityRepositoryMongo } from '../../catalog/repositories/mongo/availability.repository.mongo';
import { StockReservationService } from '../../catalog/domain/services/pricing-inventory/StockReservationService';
import { StockCommitService } from '../../catalog/domain/services/pricing-inventory/StockCommitService';
import { StockReleaseService } from '../../catalog/domain/services/pricing-inventory/StockReleaseService';
import { IOrder } from '../order.model';

/**
 * How long a checkout holds its units before the hold lapses.
 *
 * It bounds the window in which an abandoned checkout keeps stock off sale. It is
 * deliberately generous relative to a card payment (seconds) because the mobile-money flows
 * this platform runs on are a person leaving the browser to approve a push on their phone —
 * a short TTL would release units out from under someone who is actively paying.
 *
 * An expired hold frees its units immediately (see `countActiveByVariant`), so the cost of
 * being generous is only that stock is held slightly longer than strictly necessary; the
 * cost of being stingy is a checkout that fails after the customer has already paid.
 */
const CHECKOUT_HOLD_MINUTES = 30;

export interface ReservableLine {
    productId: string;
    variantId: string;
    vendorId: string;
    quantity: number;
}

export class OrderStockService {
    constructor(
        private readonly productRepository = new ProductRepositoryMongo(),
        private readonly variantRepository = new VariantRepositoryMongo(),
        private readonly reservationRepository = new StockReservationRepositoryMongo(),
        private readonly reservationService = new StockReservationService(
            new ProductRepositoryMongo(),
            new VariantRepositoryMongo(),
            new StockReservationRepositoryMongo(),
            new DigitalAssetRepositoryMongo(),
            new AvailabilityRepositoryMongo(),
            transactionManager,
        ),
        private readonly commitService = new StockCommitService(
            new ProductRepositoryMongo(),
            new StockReservationRepositoryMongo(),
            new VariantRepositoryMongo(),
            transactionManager,
        ),
        private readonly releaseService = new StockReleaseService(
            new ProductRepositoryMongo(),
            new StockReservationRepositoryMongo(),
            new VariantRepositoryMongo(),
            new DigitalAssetRepositoryMongo(),
            new AvailabilityRepositoryMongo(),
            transactionManager,
        ),
    ) { }

    /** `"<cartId>:<variantId>"` — see the class header. */
    static reservationIdFor(cartId: string, variantId: string): string {
        return `${cartId}:${variantId}`;
    }

    /**
     * Hold every line of a checkout, or fail the whole checkout.
     *
     * **Runs inside the caller's transaction and must.** A partial hold is worse than none:
     * if line three is out of stock, lines one and two must not stay held for an order that
     * was never created. Passing the session makes the reservations roll back with the
     * orders, which is why `ReserveStockCommand.session` exists at all.
     *
     * Throws `CATALOG_INSUFFICIENT_STOCK` (422) with
     * `details: { variantId, sku, requested, available }` on the first line that cannot be
     * satisfied — the code the registry has carried since before anything raised it.
     */
    async reserveForCheckout(
        cartId: string,
        lines: ReservableLine[],
        session: ClientSession,
    ): Promise<void> {
        for (const line of lines) {
            await this.reservationService.execute({
                productId: line.productId,
                variantId: line.variantId,
                vendorId: line.vendorId,
                quantity: line.quantity,
                reservationId: OrderStockService.reservationIdFor(cartId, line.variantId),
                ttlMinutes: CHECKOUT_HOLD_MINUTES,
                session,
            });
        }
    }

    /**
     * The sale is real — take the units off the shelf.
     *
     * Called at payment success for a prepaid order, and at **order creation** for a
     * cash-on-delivery one: COD fulfils before payment, so the goods leave the shelf when
     * the order is placed, not when the cash arrives at the door.
     *
     * **Best-effort, and deliberately so.** It runs post-commit on a path where the money
     * has already moved; throwing here would fail a request whose payment succeeded, and the
     * customer would be charged for an order that reported an error. A missed commit leaves
     * a hold that expires on its own — stock reads slightly low for the TTL and then
     * corrects. Both failure modes are recoverable; failing the payment response is not.
     */
    async commitForOrder(order: IOrder, session?: ClientSession): Promise<void> {
        const cartId = order.cart_id?.toString();
        if (!cartId) return;

        for (const item of order.items) {
            const variantId = item.variant_id?.toString();
            if (!variantId) continue;

            try {
                await this.commitService.execute({
                    reservationId: OrderStockService.reservationIdFor(cartId, variantId),
                    vendorId: order.vendor_id.toString(),
                    session,
                });
            } catch (error) {
                // Includes the ordinary case of an order that predates this feature and has
                // no reservation at all — a 404, not a fault.
                logger().warn(
                    { orderId: String(order._id), variantId, err: error },
                    'stock commit skipped for order line',
                );
            }
        }
    }

    /**
     * Give up the holds on an order that will not be fulfilled.
     *
     * For an unpaid order — cancelled by the customer, or swept by
     * `UnpaidOrderCancelWorker`. A committed reservation is refused by
     * `StockReleaseService` and lands in the warn below, which is correct: a paid order's
     * units are sold, and undoing that is `restockForOrder`.
     *
     * Best-effort for the same reason as commit: an unreleased hold expires on its own.
     */
    async releaseForOrder(order: IOrder, session?: ClientSession): Promise<void> {
        const cartId = order.cart_id?.toString();
        if (!cartId) return;

        for (const item of order.items) {
            const variantId = item.variant_id?.toString();
            if (!variantId) continue;

            try {
                await this.releaseService.execute({
                    reservationId: OrderStockService.reservationIdFor(cartId, variantId),
                    vendorId: order.vendor_id.toString(),
                    session,
                });
            } catch (error) {
                logger().warn(
                    { orderId: String(order._id), variantId, err: error },
                    'stock release skipped for order line',
                );
            }
        }
    }

    /**
     * Put returned goods back on the shelf.
     *
     * **Not a release**, and the distinction is the whole reason this is a separate method.
     * A release gives up a hold that was never taken; a restock reverses a completed sale
     * because the physical items came back. `StockReleaseService` refuses a committed
     * reservation by design, so calling it here would silently do nothing.
     *
     * ⚠️ **Scoped to the lines that actually came back, never the whole order.** An order
     * splits into one shipment per delivery agency, so a returned parcel is frequently only
     * part of it — restocking `order.items` would put items still out for delivery back on
     * the shelf, and the vendor would oversell them. `lines` is the returned shipment's own
     * items.
     *
     * The reservation row is left `committed`: it is the record that the sale happened, and
     * the return is a separate later fact. Only the counter moves.
     */
    async restockLines(
        orderId: string,
        lines: Array<{ variantId: string | null; quantity: number }>,
        session?: ClientSession,
    ): Promise<void> {
        for (const line of lines) {
            if (!line.variantId) continue;

            try {
                const variant = await this.variantRepository.findById(line.variantId, { session });
                // Nothing is counted for an infinite-stock line, so there is nothing to
                // put back — the same escape the commit takes.
                if (!variant || variant.isInfiniteStock) continue;

                await this.variantRepository.update(
                    line.variantId,
                    { stock: { $inc: line.quantity } as never },
                    { session },
                );
            } catch (error) {
                logger().warn(
                    { orderId, variantId: line.variantId, err: error },
                    'stock restock skipped for line',
                );
            }
        }
    }

    /**
     * Restock one returned shipment.
     *
     * A shipment item carries its own `variant_id` and `quantity`, so the parcel says exactly
     * what came back. Legacy shipments predate `variant_id` and carry null — those lines are
     * skipped rather than guessed at, because joining `order_item_id` back to the order to
     * recover the variant would be a guess about goods nobody can now identify.
     */
    async restockForShipment(
        orderId: string,
        shipment: { items?: Array<{ variant_id?: unknown; quantity: number }> },
        session?: ClientSession,
    ): Promise<void> {
        const lines = (shipment.items ?? []).map((item) => ({
            variantId: item.variant_id ? String(item.variant_id) : null,
            quantity: item.quantity,
        }));
        await this.restockLines(orderId, lines, session);
    }

    /**
     * What a shopper can actually buy right now: `stock − units held mid-checkout`.
     *
     * Exposed so a read path can answer honestly without duplicating the arithmetic. Note
     * this is NOT what the public catalogue publishes — that returns `inStock` as a boolean
     * (see `public-product.dto.ts`), because a precise count invites a promise the platform
     * should not make on a cached, unauthenticated endpoint.
     */
    async availableUnits(variantId: string): Promise<number | null> {
        const variant = await this.variantRepository.findById(variantId);
        if (!variant) return null;
        if (variant.isInfiniteStock) return Number.POSITIVE_INFINITY;

        const held = await this.reservationRepository.countActiveByVariant(variantId);
        return variant.stock - held;
    }
}

export const orderStockService = new OrderStockService();
