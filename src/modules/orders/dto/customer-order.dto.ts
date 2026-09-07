/**
 * An order, as its customer sees it.
 *
 * ── What this adds, and why each of it was missing ──────────────────────────
 *
 * The old inline projection returned enough to list an order and not enough to *recognise*
 * one. Everything below already existed on the model and simply was not projected:
 *
 *  - **Store name and slug.** Only `vendorId` was returned, so a receipt read "Order from
 *    507f1f77bcf86cd799439aaa". The Store is the source of truth for a vendor's business
 *    identity (`business-identity-store-magazin-split`), so that is where the name comes
 *    from — and the slug ships with it so the UI can link back to the storefront.
 *  - **A product image per line.** Order history with no pictures is close to unusable on a
 *    phone. Resolved live rather than snapshotted: `resolveProductImages`' own header
 *    explains why (an image is an aid to recognising the object, not a term of the sale), and
 *    live resolution means every order that already exists gets images with no backfill.
 *  - **`price_breakdown`.** Only `total` was shown. The breakdown IS the receipt.
 *  - **`delivery_address`.** The customer could not see where their own order was going.
 *  - **`items[].delivery.status` and `shipment_id`.** Per-line delivery state, and the id
 *    that makes the shipment endpoints reachable.
 *  - **`updatedAt`.** "Last updated" on the order card.
 *  - **`completion`.** Whether the order has already been confirmed. Orthogonal to
 *    `fulfillment_status`, which does not move when a customer confirms — so without this a
 *    client that re-reads the order after a successful confirm gets a byte-identical body and
 *    cannot tell the click landed. That is exactly what happened: the storefront went on
 *    offering "Confirm delivery" on an order it had just completed, into a guaranteed
 *    `409 EARNINGS_ALREADY_COMPLETED`.
 *  - **`cartId`.** Not decoration: `POST /api/payments/initiate` takes a `cartId` to pay a
 *    whole checkout group, so surfacing it here is what makes an unpaid order *resumable*.
 *    A customer whose payment failed had lost their basket AND had no way back to the orders
 *    they were supposed to pay for; this is the way back.
 *
 * ── One projection, two endpoints ───────────────────────────────────────────
 *
 * `GET /orders/groups/:cartId` and `GET /orders/:id` return the same order shape. They are
 * built from this one function precisely so that the "logical order" view and the
 * single-seller view cannot disagree about what an order is — two hand-written projections
 * of the same document is how a field ends up present in one and absent in the other.
 */
import { IOrder } from '../order.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

export interface CustomerOrderItemDto {
    id: string;
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    variantTitle?: string;
    quantity: number;
    price: number;
    currency: string;
    freeDelivery: boolean;
    /** Live-resolved thumbnail. `null` when the product has no usable image. */
    image: FileDetail | null;
    /** Per-line delivery state — an order can be split across several parcels. */
    delivery: {
        status: string | null;
        shipmentId: string | null;
    } | null;
}

export interface CustomerOrderStoreDto {
    /** Null when the vendor has no store row — a should-never-happen, not an error. */
    slug: string | null;
    name: string | null;
}

export interface CustomerOrderDto {
    id: string;
    orderNumber: string;
    /**
     * The checkout group this order belongs to.
     *
     * Pay the whole group with `POST /api/payments/initiate { cartId }`. This is what makes
     * an unpaid order resumable — see the header.
     */
    cartId: string | null;
    vendorId: string;
    store: CustomerOrderStoreDto;
    orderType: string;
    total: number;
    currency: string;
    priceBreakdown: {
        base: number;
        tax: number;
        discount: number;
        total: number;
    };
    paymentMethod: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    /**
     * Where it is going. Null on digital orders, which have no delivery — and null on
     * physical orders created before checkout began refusing an un-geocoded address.
     */
    deliveryAddress: unknown | null;
    items: CustomerOrderItemDto[];
    /** COD only. Absent on prepaid orders — see the orders api-doc. */
    codCollections?: unknown[];
    /**
     * The escrow-release gate — `Order.completion`, projected.
     *
     * `confirmedAt` is null until the order is completed, and it is the ONLY reliable
     * "has this already been confirmed" test a client has. Fulfilment does not move on
     * confirmation — 'fulfilled' stays 'fulfilled', 'delivered' stays 'delivered' — so a UI
     * gating a confirm action on `fulfillmentStatus` alone offers it forever.
     *
     * `confirmedBy` is not a synonym for "who clicked". COD completes as `'customer'` when
     * the agent enters the customer's delivery code, because the code is the customer's act;
     * `'system'` is the auto-confirm sweep. `auto` is what separates a real confirmation
     * from an elapsed window, so a client can say which happened instead of guessing.
     */
    completion: {
        confirmedAt: string | null;
        confirmedBy: 'customer' | 'system' | null;
        auto: boolean;
    };
    createdAt: string;
    updatedAt: string;
}

export interface CustomerOrderDtoInput {
    order: IOrder;
    storeName: string | null;
    storeSlug: string | null;
    /** Keyed by `productImageKey(productId, variantId)`. */
    imagesByKey: Map<string, FileDetail[]>;
    codCollections?: unknown[];
}

export function toCustomerOrderDto(input: CustomerOrderDtoInput): CustomerOrderDto {
    const { order } = input;

    return {
        id: String(order._id),
        orderNumber: order.order_number,
        cartId: order.cart_id ? order.cart_id.toString() : null,
        vendorId: order.vendor_id.toString(),
        store: { slug: input.storeSlug, name: input.storeName },
        orderType: order.order_type,
        total: order.total_amount,
        currency: order.currency,
        priceBreakdown: {
            base: order.price_breakdown.base,
            tax: order.price_breakdown.tax,
            discount: order.price_breakdown.discount,
            total: order.price_breakdown.total,
        },
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        fulfillmentStatus: order.fulfillment_status,
        deliveryAddress: order.delivery_address ?? null,
        items: order.items.map((item) => {
            const productId = item.product_id.toString();
            const variantId = item.variant_id?.toString() ?? null;
            const gallery =
                input.imagesByKey.get(`${productId}:${variantId ?? ''}`) ??
                input.imagesByKey.get(`${productId}:`) ??
                [];

            return {
                id: String(item._id),
                productId,
                variantId: variantId ?? '',
                sku: item.sku,
                title: item.title,
                variantTitle: item.variant_title,
                quantity: item.quantity,
                price: item.price,
                currency: item.currency,
                freeDelivery: item.delivery?.free_delivery ?? false,
                // `[0]` is the thumbnail by convention — resolveProductImages returns the
                // gallery thumbnail-first.
                image: gallery[0] ?? null,
                delivery: item.delivery
                    ? {
                        status: item.delivery.status ?? null,
                        shipmentId: item.delivery.shipment_id ? item.delivery.shipment_id.toString() : null,
                    }
                    : null,
            };
        }),
        // Omitted entirely on prepaid orders rather than sent as an empty array — the
        // existing contract distinguishes "not a COD order" from "COD with nothing collected
        // yet", and a client branches on the key's presence.
        ...(input.codCollections ? { codCollections: input.codCollections } : {}),
        // Always present, never conditional — unlike `codCollections` above, whose absence
        // is itself the signal. A client must be able to read "not confirmed yet" as a fact
        // rather than infer it from a missing key. Orders predating the field project an
        // all-null block, which is the right answer for them.
        completion: {
            confirmedAt: order.completion?.confirmed_at
                ? new Date(order.completion.confirmed_at).toISOString()
                : null,
            confirmedBy: order.completion?.confirmed_by ?? null,
            auto: order.completion?.auto ?? false,
        },
        createdAt: new Date(order.created_at).toISOString(),
        updatedAt: new Date(order.updated_at).toISOString(),
    };
}
