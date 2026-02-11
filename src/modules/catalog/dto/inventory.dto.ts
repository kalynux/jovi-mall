export interface BulkUpdateItemDto {
    variantId: string;
    quantity: number;
}

export interface LowStockAlertDto {
    variantId: string;
    productId: string;
    sku: string;
    productTitle: string;
    currentStock: number;
    activeReservations: number;
    availableStock: number;
    threshold: number;
    stockPercentage: number | null;
}

export interface StockAuditLogDto {
    id: string;
    variantId: string;
    sku: string;
    previousQuantity: number;
    newQuantity: number;
    delta: number;
    operation: string;
    actorType: string;
    timestamp: Date;
    metadata?: {
        orderId?: string;
        reservationId?: string;
        batchId?: string;
        reason?: string;
    };
}

export interface ReservationDto {
    reservationId: string;
    variantId: string;
    sku: string;
    productTitle: string;
    quantity: number;
    type: 'physical' | 'digital' | 'service';
    status: string;
    expiresAt: Date;
    createdAt: Date;
}
