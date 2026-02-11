import { Types } from 'mongoose';
import { IStockAuditLog, StockOperation, ActorType, StockAuditMetadata } from '../../models/stock-audit-log.model';

export class StockAuditLog {
    constructor(
        public readonly id: string,
        public readonly variantId: string,
        public readonly productId: string,
        public readonly vendorId: string,
        public readonly previousQuantity: number,
        public readonly newQuantity: number,
        public readonly delta: number,
        public readonly operation: StockOperation,
        public readonly actorType: ActorType,
        public readonly actorId: string | undefined,
        public readonly metadata: StockAuditMetadata | undefined,
        public readonly timestamp: Date,
        public readonly createdAt: Date,
        public readonly updatedAt: Date
    ) { }
}

export class StockAuditLogMapper {
    static toDomain(doc: IStockAuditLog): StockAuditLog {
        return new StockAuditLog(
            doc._id.toString(),
            doc.variantId.toString(),
            doc.productId.toString(),
            doc.vendorId.toString(),
            doc.previousQuantity,
            doc.newQuantity,
            doc.delta,
            doc.operation,
            doc.actorType,
            doc.actorId?.toString(),
            doc.metadata,
            doc.timestamp,
            doc.createdAt,
            doc.updatedAt
        );
    }

    static toPersistence(domain: Partial<StockAuditLog>): Partial<IStockAuditLog> {
        const persistence: any = {};

        if (domain.variantId) persistence.variantId = new Types.ObjectId(domain.variantId);
        if (domain.productId) persistence.productId = new Types.ObjectId(domain.productId);
        if (domain.vendorId) persistence.vendorId = new Types.ObjectId(domain.vendorId);
        if (domain.previousQuantity !== undefined) persistence.previousQuantity = domain.previousQuantity;
        if (domain.newQuantity !== undefined) persistence.newQuantity = domain.newQuantity;
        if (domain.delta !== undefined) persistence.delta = domain.delta;
        if (domain.operation) persistence.operation = domain.operation;
        if (domain.actorType) persistence.actorType = domain.actorType;
        if (domain.actorId) persistence.actorId = new Types.ObjectId(domain.actorId);
        if (domain.metadata) persistence.metadata = domain.metadata;
        if (domain.timestamp) persistence.timestamp = domain.timestamp;

        return persistence;
    }
}
