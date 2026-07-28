/**
 * Vendor Order DTOs
 *
 * TypeScript types for API responses.
 * These are used for documentation and type safety.
 */

import { IGeoAddress } from '../../../core/types/geo-address.types';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

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
    shipping: number;
    total: number;
    currency: string;

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
}

export interface OrderDeliveryDTO {
    agencyId: string | null;
    agencyName: string | null;
    agencyPhone: string | null;
    deliveryStatus: string;
    shipmentId: string | null;
    agent: DeliveryAgentDTO | null;
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
        base: number;
        tax: number;
        discount: number;
        shipping: number;
        total: number;
    };
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
