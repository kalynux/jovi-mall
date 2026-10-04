/**
 * Vendor Order DTOs
 *
 * TypeScript types for API responses.
 * These are used for documentation and type safety.
 */

import { IGeoAddress } from '../../../core/types/geo-address.types';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { customerDeliveryFeeOf, deliveryFeeShares } from '../../orders/domain/delivery-payer';
import type { DeliveryPayer, DeliveryPayerReason } from '../../vendors/domain/delivery-terms';

/**
 * One shipment's delivery money, as the VENDOR reads it (ADR-A11, customer-paid delivery).
 *
 *   fee          what the agency is paid for the run — the approved override, else the posted
 *                price snapshotted at checkout. `null` on a shipment never priced (legacy).
 *   customerPaid what the customer paid for this run (0 when your shop pays delivery).
 *   vendorBorne  the part of `fee` deducted from your net: `max(0, fee − customerPaid)`. The
 *                whole fee on a free-delivery order, 0 on a customer-paid one — unless an
 *                approved fee change raised the fee above what the customer paid.
 */
export interface VendorShipmentDeliveryFeeDTO {
    payer: DeliveryPayer;
    fee: number | null;
    customerPaid: number;
    vendorBorne: number | null;
}

/** The shipment fields `toVendorShipmentDeliveryFee` reads. */
export interface VendorShipmentFeeFacts {
    delivery_payer?: DeliveryPayer | null;
    customer_delivery_fee?: number | null;
    delivery_fee_snapshot?: number | null;
    delivery_fee_override?: { amount?: number | null } | null;
}

/** Pure: one shipment's delivery money for the vendor — see `VendorShipmentDeliveryFeeDTO`. */
export function toVendorShipmentDeliveryFee(
    order: { delivery_payer?: DeliveryPayer | null } | null,
    shipment: VendorShipmentFeeFacts,
): VendorShipmentDeliveryFeeDTO {
    const customerPaid = customerDeliveryFeeOf(order, shipment);
    const override = shipment.delivery_fee_override?.amount;
    const fee = typeof override === 'number'
        ? override
        : typeof shipment.delivery_fee_snapshot === 'number' ? shipment.delivery_fee_snapshot : null;
    return {
        payer: shipment.delivery_payer ?? order?.delivery_payer ?? 'vendor',
        fee,
        customerPaid,
        vendorBorne: fee === null ? null : deliveryFeeShares(fee, customerPaid).vendorBorne,
    };
}

export interface VendorOrderListItemDTO {
    id: string;
    orderNumber: string;
    orderType: 'physical' | 'digital';
    createdAt: Date;

    customer: {
        id: string;
        name: string | null;
        email: string | null;
        avatar: FileDetail | null;
    };

    subtotal: number;
    tax: number;
    /**
     * What the CUSTOMER paid for delivery on this order (`price_breakdown.delivery`, ADR-A11) —
     * 0 when your shop's delivery terms made it free for them. It is not your cost: what you
     * bear is on the order detail (`priceBreakdown.vendorBorneDelivery`).
     */
    shipping: number;
    /** `subtotal + shipping` (tax and discount are 0). */
    total: number;
    currency: string;
    /** Who paid delivery: `vendor` (free for the customer) or `customer`. `null` on a digital order. */
    deliveryPayer: DeliveryPayer | null;

    fulfillmentStatus: string;
    paymentStatus: string;

    itemCount: number;
}

export interface OrderItemDTO {
    id: string;
    productId: string;
    variantId: string;
    title: string;
    variantTitle?: string;
    sku: string;
    optionsSnapshot: string;
    quantity: number;
    price: number;
    subtotal: number;
    currency: string;
}

export interface ShippingAddressDTO {
    street: string;
    city: string;
    state: string | null;
    country: string;
    /**
     * Full geocoded drop-off address when the order carries a durable snapshot
     * (formatted address + coordinates + provider + admin components). Absent/null
     * on legacy orders whose address is still derived from the saved address.
     */
    geo?: IGeoAddress | null;
}

export interface DeliveryAgentDTO {
    id: string;
    name: string;
    phone: string | null;
    avatar: FileDetail | null;
    /** Admin has verified the agent's identity (`kyc.status === 'verified'`). */
    verified: boolean;
}

export interface OrderDeliveryDTO {
    agencyId: string | null;
    agencyName: string | null;
    /** Admin has verified the agency's business documents (`kyc_details.legit_verified`). */
    agencyVerified: boolean;
    agencyPhone: string | null;
    deliveryStatus: string;
    shipmentId: string | null;
    agent: DeliveryAgentDTO | null;
    /** This shipment's delivery money (ADR-A11). `null` when there is no shipment yet. */
    deliveryFee: VendorShipmentDeliveryFeeDTO | null;
}

export interface VendorOrderDetailsDTO {
    id: string;
    orderNumber: string;
    orderType: 'physical' | 'digital';
    createdAt: Date;
    updatedAt: Date;

    customer: {
        id: string;
        name: string | null;
        email: string | null;
        phone: string | null;
        avatar: FileDetail | null;
        orderCount: number;
        totalSpent: number;
    };

    /** Customer's default shipping address. null if no address on file. */
    shippingAddress: ShippingAddressDTO | null;

    items: OrderItemDTO[];

    priceBreakdown: {
        /** The items — what your commission and net are measured on. */
        base: number;
        tax: number;
        discount: number;
        /** What the CUSTOMER paid for delivery (`price_breakdown.delivery`); 0 when free for them. */
        shipping: number;
        /**
         * Σ of the delivery fees deducted from YOUR net (`deliveries[].deliveryFee.vendorBorne`) —
         * the whole fee when your shop delivers free, 0 when the customer paid it. `null` for a
         * digital order, or while no shipment has a priced fee.
         */
        vendorBorneDelivery: number | null;
        /** `base + shipping` — what the customer was charged. */
        total: number;
    };
    /** Who paid delivery (`null` on a digital order). */
    deliveryPayer: DeliveryPayer | null;
    /** `shop_always` · `shop_threshold_met` · `shop_never` · `threshold_not_met` · `cap_fallback`; null on digital/legacy. */
    deliveryPayerReason: DeliveryPayerReason | null;
    totalAmount: number;
    currency: string;

    fulfillmentStatus: string;
    paymentStatus: string;
    paymentIntentId?: string;

    /** Delivery info for physical orders. null for digital orders. */
    delivery: OrderDeliveryDTO | null;

    /** Vendor-internal notes (not visible to customers). */
    notes: VendorOrderNoteDTO[];
}

export interface VendorOrderTimelineDTO {
    id: string;
    eventType: string;
    description: string;
    metadata: Record<string, any>;
    actorType: 'vendor' | 'customer' | 'system' | 'admin';
    actorId: string | null;
    createdAt: Date;
}

export interface VendorOrderNoteDTO {
    id: string;
    message: string;
    authorId: string;
    createdAt: Date;
}
