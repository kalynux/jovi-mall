import mongoose from 'mongoose';
import {
    AgentNotificationModel,
    IAgentNotification,
    AgentNotificationType,
    AgentAggregateType,
    AgentNotificationAction,
    AgentDeliveryChannel
} from '../models/agent-notification.model';

export interface CreateAgentNotificationPayload {
    agentId: mongoose.Types.ObjectId | string;
    type: AgentNotificationType;
    title: string;
    message: string;
    aggregateType: AgentAggregateType;
    aggregateId: mongoose.Types.ObjectId | string;
    action?: AgentNotificationAction;
    deliveredVia: AgentDeliveryChannel[];
    idempotencyKey: string;
}

export interface PaginationOptions {
    page: number;
    limit: number;
}

/**
 * AgentNotificationRepository
 *
 * Agent-scoped notification persistence. Mirrors AgencyNotificationRepository,
 * including per-channel delivery tracking — see agent-notification.model.ts.
 */
export class AgentNotificationRepository {
    async createIfNotExists(payload: CreateAgentNotificationPayload): Promise<IAgentNotification> {
        const result = await AgentNotificationModel.findOneAndUpdate(
            { idempotencyKey: payload.idempotencyKey },
            {
                $setOnInsert: {
                    agentId: new mongoose.Types.ObjectId(payload.agentId),
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
        return result as IAgentNotification;
    }

    /**
     * Record a secondary-channel delivery failure on a notification.
     * Best-effort: in-app remains the source of truth.
     */
    async recordDeliveryError(
        notificationId: string | mongoose.Types.ObjectId,
        channel: AgentDeliveryChannel,
        message: string
    ): Promise<void> {
        await AgentNotificationModel.updateOne(
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
        channel: AgentDeliveryChannel
    ): Promise<void> {
        await AgentNotificationModel.updateOne(
            { _id: new mongoose.Types.ObjectId(notificationId) },
            { $addToSet: { deliveredVia: channel } }
        );
    }

    async findByAgent(
        agentId: string | mongoose.Types.ObjectId,
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<{ data: IAgentNotification[]; total: number }> {
        const { page, limit } = pagination;
        const skip = (page - 1) * limit;
        const query = { agentId: new mongoose.Types.ObjectId(agentId) };

        const [data, total] = await Promise.all([
            AgentNotificationModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
            AgentNotificationModel.countDocuments(query)
        ]);
        return { data, total };
    }

    async markAsRead(
        notificationId: string,
        agentId: string | mongoose.Types.ObjectId
    ): Promise<IAgentNotification | null> {
        return AgentNotificationModel.findOneAndUpdate(
            { _id: notificationId, agentId: new mongoose.Types.ObjectId(agentId) },
            { $set: { isRead: true, readAt: new Date() } },
            { new: true }
        );
    }

    async markAllAsRead(agentId: string | mongoose.Types.ObjectId): Promise<number> {
        const result = await AgentNotificationModel.updateMany(
            { agentId: new mongoose.Types.ObjectId(agentId), isRead: false },
            { $set: { isRead: true, readAt: new Date() } }
        );
        return result.modifiedCount;
    }

    async countUnread(agentId: string | mongoose.Types.ObjectId): Promise<number> {
        return AgentNotificationModel.countDocuments({
            agentId: new mongoose.Types.ObjectId(agentId),
            isRead: false
        });
    }
}
