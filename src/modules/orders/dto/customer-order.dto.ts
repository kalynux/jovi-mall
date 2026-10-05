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
import {
    customerDeliveryFeeOf,
    deliveryCashOf,
    DeliveryFeePayment,
    deliveryFeePaymentOf,
    deliveryPayerOf,
    paysDeliveryFeeInCash,
} from '../domain/delivery-payer';
import type { DeliveryPayer, DeliveryPayerReason } from '../../vendors/domain/delivery-terms';
import { customerRefundPosition, DeliveryFeeRefundStatus } from '../../delivery-fee-proposals/domain/customer-fee-change.rules';
import type { CustomerRefundBlock } from '../../payments/dto/customer-refund.dto';

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
    /** Live-resolved thumbnail. `null` when the product has no usable image. */
    image: FileDetail | null;
    /** Per-line delivery state — an order can be split across several parcels. */
    delivery: {
        status: string | null;
        shipmentId: string | null;
    } | null;
}

/**
 * What the customer paid for ONE parcel's delivery (ADR-A11, customer-paid delivery).
 *
 * `amount` is `shipment.customer_delivery_fee` read through `customerDeliveryFeeOf` — the
 * customer-facing figure, never the agency's `delivery_fee_snapshot` (what the agency is paid,
 * which can differ after an approved fee change). 0 on a parcel whose delivery the shop paid.
 */
export interface CustomerOrderDeliveryFeeDto {
    shipmentId: string;
    amount: number;
    /**
     * Delivery money the platform holds that is owed BACK to the customer (a returned parcel's
     * unspent fee, or a fee lowered after payment). Present only when non-zero.
     */
    customerFeeRefundable?: number;
    /**
     * Cash for delivery (W-F): present (`true`) only when this parcel's `amount` is handed to the
     * rider in cash (it was NOT charged online). Absent on every other parcel — like
     * `customerFeeRefundable`.
     */
    paidInCash?: true;
}

export interface CustomerOrderStoreDto {
    /** Null when the vendor has no store row — a should-never-happen, not an error. */
    slug: string | null;
    name: string | null;
    /**
     * Is the seller KYC-verified — `vendor.kyc_details.legit_verified === true`, the same
     * source as the catalog's `store.verified`. Read from the vendor, not the store, in one
     * batched query per response. A platform verdict for a badge, never the KYC documents.
     */
    verified: boolean;
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
        /** The items. */
        base: number;
        /**
         * What the customer was charged for delivery (ADR-A11): Σ this order's parcel fees when
         * the shop's delivery terms make the customer pay, 0 when the shop pays (free delivery).
         * 0 on orders created before customer-paid delivery existed.
         */
        delivery: number;
        /**
         * Cash for delivery (W-F): the customer-paid delivery handed to the RIDERS in cash — NOT in
         * `delivery` nor `total`. 0 on every other order.
         */
        deliveryCash: number;
        tax: number;
        discount: number;
        /** `base + delivery + tax − discount` — what was charged (online) / will be collected (COD). */
        total: number;
    };
    /**
     * How the customer-paid delivery fee is paid (ADR-A11 § Cash for delivery): `with_order`
     * (charged with the order — or nothing to pay) or `cash_to_rider` (the goods were paid online,
     * the fee goes to the rider in cash; see `amountDueToRider` and the fee-only entries of
     * `codCollections`, which carry the delivery code). `null` on a digital order.
     */
    deliveryFeePayment: DeliveryFeePayment | null;
    /**
     * Cash still to hand the rider(s) for delivery on a `cash_to_rider` order: Σ the parcels'
     * fees not yet collected. 0 on every other order (COD cash is in `codCollections`).
     */
    amountDueToRider: number;
    /**
     * Who paid this order's delivery: `vendor` (free delivery for the customer) or `customer`.
     * `null` on a digital order (nothing ships). Legacy physical orders read `vendor`.
     */
    deliveryPayer: DeliveryPayer | null;
    /**
     * Why: `shop_always` · `shop_threshold_met` (free) · `shop_never` · `threshold_not_met` ·
     * `cap_fallback` (the customer paid). `null` on digital and legacy orders.
     */
    deliveryPayerReason: DeliveryPayerReason | null;
    /** One entry per parcel of this order — `[]` for a digital order. */
    deliveryFees: CustomerOrderDeliveryFeeDto[];
    /**
     * Delivery money owed BACK to the customer on this order, from the refund ledger (ADR-A11):
     * `owed` is what has not reached them yet (in flight, or waiting to be paid by hand — it
     * clears when a refund completes or an administrator records a manual one as paid, W-E2);
     * `returned` is what came back. `null` when nothing was ever owed. The per-parcel
     * `deliveryFees[].customerFeeRefundable` is the GROSS amount that became theirs and does not
     * shrink when it is returned — read this for "still owed".
     */
    deliveryFeeRefund: { owed: number; returned: number } | null;
    /**
     * The order's refund (REFUND-FLOW-PLAN § 8): the LATEST refund request for this order, in the
     * customer's vocabulary — `requested` · `waiting_for_cash` · `sending` · `in_progress` ·
     * `completed` · `declined` — with gross, fee, net and the masked destination. `null` when no
     * refund was ever requested. Always present (never an absent key). Independent of
     * `deliveryFeeRefund`, which is the delivery-fee ledger and keeps its own meaning.
     */
    refund: CustomerRefundBlock | null;
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
    /** `vendor.kyc_details.legit_verified === true`. */
    storeVerified: boolean;
    /** Keyed by `productImageKey(productId, variantId)`. */
    imagesByKey: Map<string, FileDetail[]>;
    codCollections?: unknown[];
    /**
     * This order's shipments — the delivery-money fields only — for `deliveryFees`. Absent
     * yields `[]` (a digital order, or a caller that did not load them).
     */
    shipments?: CustomerOrderShipmentFeeFacts[];
    /** This order's `delivery_fee_refunds` rows (status + amount only), for `deliveryFeeRefund`. */
    deliveryFeeRefundLedger?: Array<{ status: DeliveryFeeRefundStatus; amount: number }>;
    /** The latest refund request for this order, already projected (`toCustomerRefundBlock`). Absent → `null`. */
    refund?: CustomerRefundBlock | null;
}

/** The shipment fields `deliveryFees` reads. */
export interface CustomerOrderShipmentFeeFacts {
    _id: unknown;
    /** For `amountDueToRider` (a delivered parcel's cash was collected). */
    status?: string | null;
    delivery_payer?: DeliveryPayer | null;
    customer_delivery_fee?: number | null;
    customer_fee_refundable?: number | null;
}

/** Per-parcel delivery fees as the customer sees them — pure; see `CustomerOrderDeliveryFeeDto`. */
export function toCustomerDeliveryFees(
    order: Pick<IOrder, 'delivery_payer'> & Partial<Pick<IOrder, 'payment_method' | 'delivery_fee_payment'>>,
    shipments: readonly CustomerOrderShipmentFeeFacts[],
): CustomerOrderDeliveryFeeDto[] {
    return shipments.map((shipment) => {
        const refundable = shipment.customer_fee_refundable;
        return {
            shipmentId: String(shipment._id),
            amount: customerDeliveryFeeOf(order, shipment),
            ...(typeof refundable === 'number' && refundable > 0 ? { customerFeeRefundable: refundable } : {}),
            ...(paysDeliveryFeeInCash(order, shipment) ? { paidInCash: true as const } : {}),
        };
    });
}

/**
 * Cash still due to the riders for delivery on a `cash_to_rider` order (W-F) — pure: Σ the
 * cash parcels' customer fees, minus those already handed over (delivered) or never to be
 * (returned / cancelled). 0 on every other order.
 */
export function amountDueToRiderOf(
    order: Pick<IOrder, 'delivery_payer'> & Partial<Pick<IOrder, 'payment_method' | 'delivery_fee_payment'>>,
    shipments: readonly CustomerOrderShipmentFeeFacts[],
): number {
    if (deliveryFeePaymentOf(order) !== 'cash_to_rider') return 0;
    return shipments
        .filter((s) => !['delivered', 'returned', 'cancelled'].includes(String(s.status ?? '')))
        .filter((s) => paysDeliveryFeeInCash(order, s))
        .reduce((sum, s) => sum + customerDeliveryFeeOf(order, s), 0);
}

/** `deliveryFeeRefund` — pure; null when no delivery money was ever owed back on the order. */
export function toCustomerDeliveryFeeRefund(
    shipments: readonly CustomerOrderShipmentFeeFacts[],
    ledger: ReadonlyArray<{ status: DeliveryFeeRefundStatus; amount: number }>,
): { owed: number; returned: number } | null {
    const position = customerRefundPosition({
        refundables: shipments.map((s) => s.customer_fee_refundable),
        ledger: [...ledger],
    });
    if (position.totalOwed <= 0 && position.returned <= 0) return null;
    return { owed: position.owed, returned: position.returned };
}

export function toCustomerOrderDto(input: CustomerOrderDtoInput): CustomerOrderDto {
    const { order } = input;

    return {
        id: String(order._id),
        orderNumber: order.order_number,
        cartId: order.cart_id ? order.cart_id.toString() : null,
        vendorId: order.vendor_id.toString(),
        store: { slug: input.storeSlug, name: input.storeName, verified: input.storeVerified },
        orderType: order.order_type,
        total: order.total_amount,
        currency: order.currency,
        priceBreakdown: {
            base: order.price_breakdown.base,
            delivery: order.price_breakdown.delivery ?? 0,
            deliveryCash: deliveryCashOf(order),
            tax: order.price_breakdown.tax,
            discount: order.price_breakdown.discount,
            total: order.price_breakdown.total,
        },
        deliveryPayer: order.order_type === 'physical' ? deliveryPayerOf(order) : null,
        deliveryPayerReason: order.order_type === 'physical' ? (order.delivery_payer_reason ?? null) : null,
        deliveryFees: order.order_type === 'physical' ? toCustomerDeliveryFees(order, input.shipments ?? []) : [],
        deliveryFeePayment: order.order_type === 'physical' ? deliveryFeePaymentOf(order) : null,
        amountDueToRider: order.order_type === 'physical' ? amountDueToRiderOf(order, input.shipments ?? []) : 0,
        deliveryFeeRefund: order.order_type === 'physical'
            ? toCustomerDeliveryFeeRefund(input.shipments ?? [], input.deliveryFeeRefundLedger ?? [])
            : null,
        refund: input.refund ?? null,
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
