import mongoose from 'mongoose';
import {
    CustomerNotificationModel,
    ICustomerNotification,
    CustomerNotificationType,
    CustomerAggregateType,
    CustomerNotificationAction,
    CustomerDeliveryChannel
} from '../models/customer-notification.model';

export interface CreateCustomerNotificationPayload {
    customerId: mongoose.Types.ObjectId | string;
    type: CustomerNotificationType;
    title: string;
    message: string;
    aggregateType: CustomerAggregateType;
    aggregateId: mongoose.Types.ObjectId | string;
    action?: CustomerNotificationAction;
    deliveredVia: CustomerDeliveryChannel[];
    idempotencyKey: string;
}

export interface PaginationOptions {
    page: number;
    limit: number;
}

export interface ListFilters {
    /** Only unread rows — the common "what needs my attention" read. */
    unreadOnly?: boolean;
    /** Narrow to one subject area without the caller knowing every situation name. */
    aggregateType?: CustomerAggregateType;
}

/**
 * CustomerNotificationRepository
 *
 * Customer-scoped notification persistence. Mirrors AgentNotificationRepository,
 * including per-channel delivery tracking — see customer-notification.model.ts.
 */
export class CustomerNotificationRepository {
    /**
     * Create the in-app record, or return the existing one.
     *
     * Upsert-on-`idempotencyKey` rather than insert-and-catch: an event can be
     * republished, a worker can restart mid-sweep, and a gateway can retry a
     * webhook. Returning the existing row lets the caller re-attempt secondary
     * delivery without ever duplicating the message.
     */
    async createIfNotExists(
        payload: CreateCustomerNotificationPayload
    ): Promise<ICustomerNotification> {
        const result = await CustomerNotificationModel.findOneAndUpdate(
            { idempotencyKey: payload.idempotencyKey },
            {
                $setOnInsert: {
                    customerId: new mongoose.Types.ObjectId(payload.customerId),
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
        return result as ICustomerNotification;
    }

    /** Whether this exact notification already exists (worker pre-check). */
    async existsByKey(idempotencyKey: string): Promise<boolean> {
        return (await CustomerNotificationModel.countDocuments({ idempotencyKey })) > 0;
    }

    /**
     * Record a secondary-channel delivery failure on a notification.
     * Best-effort: the in-app row remains the source of truth.
     */
    async recordDeliveryError(
        notificationId: string | mongoose.Types.ObjectId,
        channel: CustomerDeliveryChannel,
        message: string
    ): Promise<void> {
        await CustomerNotificationModel.updateOne(
            { _id: new mongoose.Types.ObjectId(notificationId) },
            {
                $push: {
                    deliveryErrors: { channel, error: message, failedAt: new Date() }
                }
            }
        );
    }

    /** Add a delivered channel. `$addToSet`, so re-running is a no-op. */
    async addDeliveredChannel(
        notificationId: string | mongoose.Types.ObjectId,
        channel: CustomerDeliveryChannel
    ): Promise<void> {
        await CustomerNotificationModel.updateOne(
            { _id: new mongoose.Types.ObjectId(notificationId) },
            { $addToSet: { deliveredVia: channel } }
        );
    }

    async findByCustomer(
        customerId: string | mongoose.Types.ObjectId,
        pagination: PaginationOptions = { page: 1, limit: 20 },
        filters: ListFilters = {}
    ): Promise<{ data: ICustomerNotification[]; total: number }> {
        const { page, limit } = pagination;
        const skip = (page - 1) * limit;

        const query: Record<string, unknown> = {
            customerId: new mongoose.Types.ObjectId(customerId)
        };
        if (filters.unreadOnly) query.isRead = false;
        if (filters.aggregateType) query.aggregateType = filters.aggregateType;

        const [data, total] = await Promise.all([
            CustomerNotificationModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
            CustomerNotificationModel.countDocuments(query)
        ]);
        return { data, total };
    }

    async markAsRead(
        notificationId: string,
        customerId: string | mongoose.Types.ObjectId
    ): Promise<ICustomerNotification | null> {
        if (!mongoose.Types.ObjectId.isValid(notificationId)) return null;
        return CustomerNotificationModel.findOneAndUpdate(
            { _id: notificationId, customerId: new mongoose.Types.ObjectId(customerId) },
            { $set: { isRead: true, readAt: new Date() } },
            { new: true }
        );
    }

    async markAllAsRead(customerId: string | mongoose.Types.ObjectId): Promise<number> {
        const result = await CustomerNotificationModel.updateMany(
            { customerId: new mongoose.Types.ObjectId(customerId), isRead: false },
            { $set: { isRead: true, readAt: new Date() } }
        );
        return result.modifiedCount;
    }

    async countUnread(customerId: string | mongoose.Types.ObjectId): Promise<number> {
        return CustomerNotificationModel.countDocuments({
            customerId: new mongoose.Types.ObjectId(customerId),
            isRead: false
        });
    }
}
