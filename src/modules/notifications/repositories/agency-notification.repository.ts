import mongoose from 'mongoose';
import {
    AgencyNotificationModel,
    IAgencyNotification,
    AgencyNotificationType,
    AgencyAggregateType,
    AgencyNotificationAction,
    AgencyDeliveryChannel
} from '../models/agency-notification.model';

export interface CreateAgencyNotificationPayload {
    agencyId: mongoose.Types.ObjectId | string;
    type: AgencyNotificationType;
    title: string;
    message: string;
    aggregateType: AgencyAggregateType;
    aggregateId: mongoose.Types.ObjectId | string;
    action?: AgencyNotificationAction;
    deliveredVia: AgencyDeliveryChannel[];
    idempotencyKey: string;
}

export interface PaginationOptions {
    page: number;
    limit: number;
}

/**
 * AgencyNotificationRepository
 *
 * Agency-scoped notification persistence. Mirrors the shape of
 * VendorNotificationRepository, including per-channel delivery tracking —
 * see agency-notification.model.ts.
 */
export class AgencyNotificationRepository {
    async createIfNotExists(payload: CreateAgencyNotificationPayload): Promise<IAgencyNotification> {
        const result = await AgencyNotificationModel.findOneAndUpdate(
            { idempotencyKey: payload.idempotencyKey },
            {
                $setOnInsert: {
                    agencyId: new mongoose.Types.ObjectId(payload.agencyId),
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
        return result as IAgencyNotification;
    }

    /**
     * Record a secondary-channel delivery failure on a notification.
     * Best-effort: in-app remains the source of truth.
     */
    async recordDeliveryError(
        notificationId: string | mongoose.Types.ObjectId,
        channel: AgencyDeliveryChannel,
        message: string
    ): Promise<void> {
        await AgencyNotificationModel.updateOne(
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
     * Uses $addToSet so it is idempotent.
     */
    async addDeliveredChannel(
        notificationId: string | mongoose.Types.ObjectId,
        channel: AgencyDeliveryChannel
    ): Promise<void> {
        await AgencyNotificationModel.updateOne(
            { _id: new mongoose.Types.ObjectId(notificationId) },
            { $addToSet: { deliveredVia: channel } }
        );
    }

    async findByAgency(
        agencyId: string | mongoose.Types.ObjectId,
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<{ data: IAgencyNotification[]; total: number }> {
        const { page, limit } = pagination;
        const skip = (page - 1) * limit;
        const query = { agencyId: new mongoose.Types.ObjectId(agencyId) };

        const [data, total] = await Promise.all([
            AgencyNotificationModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
            AgencyNotificationModel.countDocuments(query)
        ]);
        return { data, total };
    }

    async markAsRead(
        notificationId: string,
        agencyId: string | mongoose.Types.ObjectId
    ): Promise<IAgencyNotification | null> {
        return AgencyNotificationModel.findOneAndUpdate(
            { _id: notificationId, agencyId: new mongoose.Types.ObjectId(agencyId) },
            { $set: { isRead: true, readAt: new Date() } },
            { new: true }
        );
    }

    async markAllAsRead(agencyId: string | mongoose.Types.ObjectId): Promise<number> {
        const result = await AgencyNotificationModel.updateMany(
            { agencyId: new mongoose.Types.ObjectId(agencyId), isRead: false },
            { $set: { isRead: true, readAt: new Date() } }
        );
        return result.modifiedCount;
    }

    async countUnread(agencyId: string | mongoose.Types.ObjectId): Promise<number> {
        return AgencyNotificationModel.countDocuments({
            agencyId: new mongoose.Types.ObjectId(agencyId),
            isRead: false
        });
    }
}
