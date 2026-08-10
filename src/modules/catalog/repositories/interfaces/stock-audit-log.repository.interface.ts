import { StockAuditLog } from '../mappers/stock-audit-log.mapper';
// Imported rather than re-spelled: the two unions used to be duplicated here as
// literals, which is exactly how `actorType: 'agency'` would have been added to
// the model and silently rejected at this boundary.
import { StockOperation, ActorType } from '../../models/stock-audit-log.model';

export interface CreateStockAuditLogDto {
    variantId: string;
    productId: string;
    vendorId: string;
    previousQuantity: number;
    newQuantity: number;
    delta: number;
    operation: StockOperation;
    actorType: ActorType;
    actorId?: string;
    metadata?: {
        orderId?: string;
        reservationId?: string;
        batchId?: string;
        reason?: string;
        requestId?: string;
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
