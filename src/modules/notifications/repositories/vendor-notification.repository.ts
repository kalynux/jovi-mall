import mongoose from 'mongoose';
import {
    VendorNotificationModel,
    IVendorNotification,
    NotificationType,
    AggregateType,
    DeliveryChannel,
    NotificationAction
} from '../models/vendor-notification.model';

export interface CreateNotificationPayload {
    vendorId: mongoose.Types.ObjectId | string;
    type: NotificationType;
    title: string;
    message: string;
    aggregateType: AggregateType;
    aggregateId: mongoose.Types.ObjectId | string;
    action?: NotificationAction;
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
    action?: NotificationAction;
    deliveredVia: DeliveryChannel[];
    deliveryErrors?: Array<{ channel: DeliveryChannel; error: string; failedAt: Date }>;
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
                    action: payload.action,
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
     * Record a secondary-channel delivery failure on a notification.
     *
     * Appends one entry to deliveryErrors. Best-effort: in-app remains the
     * source of truth, so failures here never block the flow.
     *
     * @param notificationId - Notification ID
     * @param channel - Channel that failed
     * @param message - Error message
     */
    async recordDeliveryError(
        notificationId: string | mongoose.Types.ObjectId,
        channel: DeliveryChannel,
        message: string
    ): Promise<void> {
        await VendorNotificationModel.updateOne(
            { _id: new mongoose.Types.ObjectId(notificationId) },
            {
                $push: {
                    deliveryErrors: {
                        channel,
                        error: message,
                        failedAt: new Date()
                    }
                }
            }
        );
    }

    /**
     * Add a delivery channel to a notification's deliveredVia snapshot.
     *
     * Uses $addToSet so it is idempotent. Used for channels resolved after
     * creation (e.g. push, which depends on whether the user has devices).
     *
     * @param notificationId - Notification ID
     * @param channel - Channel to record as delivered
     */
    async addDeliveredChannel(
        notificationId: string | mongoose.Types.ObjectId,
        channel: DeliveryChannel
    ): Promise<void> {
        await VendorNotificationModel.updateOne(
            { _id: new mongoose.Types.ObjectId(notificationId) },
            { $addToSet: { deliveredVia: channel } }
        );
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
