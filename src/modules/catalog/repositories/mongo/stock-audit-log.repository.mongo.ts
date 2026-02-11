import { Types } from 'mongoose';
import { StockAuditLogModel } from '../../models/stock-audit-log.model';
import {
    IStockAuditLogRepository,
    CreateStockAuditLogDto,
    StockAuditLogFilters,
    PaginationOptions,
    RepositoryOptions
} from '../interfaces/stock-audit-log.repository.interface';
import { StockAuditLog, StockAuditLogMapper } from '../mappers/stock-audit-log.mapper';

export class StockAuditLogRepositoryMongo implements IStockAuditLogRepository {
    async create(dto: CreateStockAuditLogDto, options?: RepositoryOptions): Promise<StockAuditLog> {
        const persistence = StockAuditLogMapper.toPersistence(dto as any);

        const doc = new StockAuditLogModel({
            ...persistence,
            timestamp: dto.timestamp || new Date()
        });

        await doc.save({ session: options?.session });

        return StockAuditLogMapper.toDomain(doc);
    }

    async findByVariant(
        variantId: string,
        filters: StockAuditLogFilters,
        pagination: PaginationOptions,
        options?: RepositoryOptions
    ): Promise<StockAuditLog[]> {
        const query: any = { variantId: new Types.ObjectId(variantId) };

        this.applyFilters(query, filters);

        const skip = (pagination.page - 1) * pagination.limit;

        const docs = await StockAuditLogModel
            .find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pagination.limit)
            .session(options?.session || null)
            .exec();

        return docs.map(doc => StockAuditLogMapper.toDomain(doc));
    }

    async findByVendor(
        vendorId: string,
        filters: StockAuditLogFilters,
        pagination: PaginationOptions,
        options?: RepositoryOptions
    ): Promise<StockAuditLog[]> {
        const query: any = { vendorId: new Types.ObjectId(vendorId) };

        this.applyFilters(query, filters);

        const skip = (pagination.page - 1) * pagination.limit;

        const docs = await StockAuditLogModel
            .find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(pagination.limit)
            .session(options?.session || null)
            .exec();

        return docs.map(doc => StockAuditLogMapper.toDomain(doc));
    }

    async countByVariant(
        variantId: string,
        filters: StockAuditLogFilters,
        options?: RepositoryOptions
    ): Promise<number> {
        const query: any = { variantId: new Types.ObjectId(variantId) };

        this.applyFilters(query, filters);

        return StockAuditLogModel
            .countDocuments(query)
            .session(options?.session || null)
            .exec();
    }

    async countByVendor(
        vendorId: string,
        filters: StockAuditLogFilters,
        options?: RepositoryOptions
    ): Promise<number> {
        const query: any = { vendorId: new Types.ObjectId(vendorId) };

        this.applyFilters(query, filters);

        return StockAuditLogModel
            .countDocuments(query)
            .session(options?.session || null)
            .exec();
    }

    private applyFilters(query: any, filters: StockAuditLogFilters): void {
        if (filters.startDate || filters.endDate) {
            query.timestamp = {};

            if (filters.startDate) {
                query.timestamp.$gte = filters.startDate;
            }

            if (filters.endDate) {
                query.timestamp.$lte = filters.endDate;
            }
        }

        if (filters.operation) {
            query.operation = filters.operation;
        }
    }
}
