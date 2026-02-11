import mongoose from 'mongoose';
import {
    VendorNotificationModel,
    IVendorNotification,
    NotificationType,
    AggregateType,
    DeliveryChannel
} from '../models/vendor-notification.model';

export interface CreateNotificationPayload {
    vendorId: mongoose.Types.ObjectId | string;
    type: NotificationType;
    title: string;
    message: string;
    aggregateType: AggregateType;
    aggregateId: mongoose.Types.ObjectId | string;
    deliveredVia: DeliveryChannel[];
    idempotencyKey: string;
}

export interface NotificationFilters {
    isRead?: boolean;
}

export interface PaginationOptions {
    page: number;
    limit: number;
}

/**
 * Lean notification type (plain object without Mongoose Document methods)
 */
export type LeanVendorNotification = {
    _id: mongoose.Types.ObjectId;
    vendorId: mongoose.Types.ObjectId;
    type: NotificationType;
    title: string;
    message: string;
    aggregateType: AggregateType;
    aggregateId: mongoose.Types.ObjectId;
    deliveredVia: DeliveryChannel[];
    isRead: boolean;
    readAt: Date | null;
    idempotencyKey: string;
    createdAt: Date;
    __v?: number;
};

export interface PaginatedNotifications {
    data: LeanVendorNotification[];
    meta: {
        total: number;
        page: number;
        limit: number;
        pages: number;
    };
}

/**
 * VendorNotificationRepository
 * 
 * Vendor-scoped notification persistence with idempotency enforcement.
 * 
 * ALL queries are vendor-scoped - zero possibility of cross-vendor data leakage.
 */
export class VendorNotificationRepository {
    /**
     * Create notification if not exists (idempotent)
     * 
     * Uses MongoDB upsert with idempotencyKey to prevent duplicates.
     * Safe under concurrent writes.
     * 
     * @param payload - Notification data
     * @returns Created or existing notification
     */
    async createIfNotExists(payload: CreateNotificationPayload): Promise<IVendorNotification> {
        const result = await VendorNotificationModel.findOneAndUpdate(
            { idempotencyKey: payload.idempotencyKey },
            {
                $setOnInsert: {
                    vendorId: new mongoose.Types.ObjectId(payload.vendorId),
                    type: payload.type,
                    title: payload.title,
                    message: payload.message,
                    aggregateType: payload.aggregateType,
                    aggregateId: new mongoose.Types.ObjectId(payload.aggregateId),
                    deliveredVia: payload.deliveredVia,
                    isRead: false,
                    readAt: null
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return result as IVendorNotification;
    }

    /**
     * Find notifications by vendor with filters and pagination
     * 
     * @param vendorId - Vendor ID (ownership enforcement)
     * @param filters - Optional filters (isRead)
     * @param pagination - Page and limit
     * @returns Paginated notifications
     */
    async findByVendor(
        vendorId: string | mongoose.Types.ObjectId,
        filters: NotificationFilters = {},
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<PaginatedNotifications> {
        const { page, limit } = pagination;
        const skip = (page - 1) * limit;

        const query: any = { vendorId: new mongoose.Types.ObjectId(vendorId) };

        if (filters.isRead !== undefined) {
            query.isRead = filters.isRead;
        }

        const [data, total] = await Promise.all([
            VendorNotificationModel.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            VendorNotificationModel.countDocuments(query)
        ]);

        return {
            data,
            meta: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        };
    }

    /**
     * Mark notification as read
     * 
     * Ownership enforced in query. Idempotent.
     * 
     * @param notificationId - Notification ID
     * @param vendorId - Vendor ID (ownership check)
     * @returns Updated notification or null if not found/not owned
     */
    async markAsRead(
        notificationId: string | mongoose.Types.ObjectId,
        vendorId: string | mongoose.Types.ObjectId
    ): Promise<IVendorNotification | null> {
        const now = new Date();

        const result = await VendorNotificationModel.findOneAndUpdate(
            {
                _id: new mongoose.Types.ObjectId(notificationId),
                vendorId: new mongoose.Types.ObjectId(vendorId)
            },
            {
                $set: {
                    isRead: true,
                    readAt: now
                }
            },
            { new: true }
        );

        return result;
    }

    /**
     * Mark all notifications as read for vendor (bulk operation)
     * 
     * Uses compound index { vendorId: 1, isRead: 1 } for performance.
     * 
     * @param vendorId - Vendor ID
     * @returns Count of notifications marked as read
     */
    async markAllAsRead(vendorId: string | mongoose.Types.ObjectId): Promise<number> {
        const now = new Date();

        const result = await VendorNotificationModel.updateMany(
            {
                vendorId: new mongoose.Types.ObjectId(vendorId),
                isRead: false
            },
            {
                $set: {
                    isRead: true,
                    readAt: now
                }
            }
        );

        return result.modifiedCount;
    }

    /**
     * Count unread notifications for vendor
     * 
     * @param vendorId - Vendor ID
     * @returns Unread count
     */
    async countUnread(vendorId: string | mongoose.Types.ObjectId): Promise<number> {
        return await VendorNotificationModel.countDocuments({
            vendorId: new mongoose.Types.ObjectId(vendorId),
            isRead: false
        });
    }
}
