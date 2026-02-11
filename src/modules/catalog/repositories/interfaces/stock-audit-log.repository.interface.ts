import { StockAuditLog } from '../mappers/stock-audit-log.mapper';

export interface CreateStockAuditLogDto {
    variantId: string;
    productId: string;
    vendorId: string;
    previousQuantity: number;
    newQuantity: number;
    delta: number;
    operation: 'manual' | 'bulk' | 'reservation' | 'release' | 'order' | 'adjustment';
    actorType: 'vendor' | 'system' | 'admin';
    actorId?: string;
    metadata?: {
        orderId?: string;
        reservationId?: string;
        batchId?: string;
        reason?: string;
    };
    timestamp?: Date;
    deletedAt: null;
    purgeAt: null;
}

export interface StockAuditLogFilters {
    startDate?: Date;
    endDate?: Date;
    operation?: string;
}

export interface PaginationOptions {
    page: number;
    limit: number;
}

export interface RepositoryOptions {
    session?: any;
}

export interface IStockAuditLogRepository {
    create(dto: CreateStockAuditLogDto, options?: RepositoryOptions): Promise<StockAuditLog>;

    findByVariant(
        variantId: string,
        filters: StockAuditLogFilters,
        pagination: PaginationOptions,
        options?: RepositoryOptions
    ): Promise<StockAuditLog[]>;

    findByVendor(
        vendorId: string,
        filters: StockAuditLogFilters,
        pagination: PaginationOptions,
        options?: RepositoryOptions
    ): Promise<StockAuditLog[]>;

    countByVariant(
        variantId: string,
        filters: StockAuditLogFilters,
        options?: RepositoryOptions
    ): Promise<number>;

    countByVendor(
        vendorId: string,
        filters: StockAuditLogFilters,
        options?: RepositoryOptions
    ): Promise<number>;
}
