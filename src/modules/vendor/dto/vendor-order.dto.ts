/**
 * Vendor Order DTOs
 * 
 * TypeScript types for API responses.
 * These are used for documentation and type safety.
 */

export interface VendorOrderListItemDTO {
    id: string;
    orderNumber: string;
    orderType: 'physical' | 'digital';
    createdAt: Date;

    customer: {
        id: string;
        // name and email populated from customer service
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
    currency: string;
}

export interface VendorOrderDetailsDTO {
    id: string;
    orderNumber: string;
    orderType: 'physical' | 'digital';
    createdAt: Date;
    updatedAt: Date;

    customer: {
        id: string;
        // Populated from customer service
    };

    items: OrderItemDTO[];

    priceBreakdown: {
        base: number;
        tax: number;
        discount: number;
        total: number;
    };
    totalAmount: number;
    currency: string;

    fulfillmentStatus: string;
    paymentStatus: string;
    paymentIntentId?: string;
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
