import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { AgentNotificationService } from '../../notifications/services/agent-notification.service';
import {
    ListAgentNotificationsQuerySchema,
    MarkAgentNotificationReadParamSchema,
    UpdateAgentNotificationPreferencesSchema
} from '../validators/agent-notification.validator';

/**
 * AgentNotificationController
 *
 * Thin HTTP layer for the agent notification subsystem. Mounted at
 * `/api/agent` → `/agent/notifications`, `/agent/notification-preferences`.
 * Mirrors AgencyNotificationController.
 */
export class AgentNotificationController {
    private static service = new AgentNotificationService();

    static listNotifications = asyncHandler(async (req: Request, res: Response) => {
        const agentId = req.auth!.role_entity._id;
        const query = ListAgentNotificationsQuerySchema.parse(req.query);

        const result = await AgentNotificationController.service.listNotifications(agentId, {
            page: query.page,
            limit: query.limit
        });

        res.status(200).json({
            success: true,
            data: result.notifications.map((n) => ({
                id: n._id.toString(),
                type: n.type,
                title: n.title,
                message: n.message,
                aggregateType: n.aggregateType,
                aggregateId: n.aggregateId.toString(),
                action: n.action ?? null,
                isRead: n.isRead,
                deliveredVia: n.deliveredVia,
                createdAt: n.createdAt.toISOString()
            })),
            unreadCount: result.unreadCount,
            meta: result.meta
        });
    });

    static markAsRead = asyncHandler(async (req: Request, res: Response) => {
        const agentId = req.auth!.role_entity._id;
        const params = MarkAgentNotificationReadParamSchema.parse(req.params);

        const notification = await AgentNotificationController.service.markAsRead(params.id, agentId);

        res.status(200).json({
            success: true,
            data: {
                id: notification._id.toString(),
                type: notification.type,
                title: notification.title,
                message: notification.message,
                aggregateType: notification.aggregateType,
                aggregateId: notification.aggregateId.toString(),
                action: notification.action ?? null,
                isRead: notification.isRead,
                deliveredVia: notification.deliveredVia,
                readAt: notification.readAt?.toISOString() ?? null,
                createdAt: notification.createdAt.toISOString()
            },
            message: 'Notification marked as read'
        });
    });

    static markAllAsRead = asyncHandler(async (req: Request, res: Response) => {
        const agentId = req.auth!.role_entity._id;
        const count = await AgentNotificationController.service.markAllAsRead(agentId);

        res.status(200).json({
            success: true,
            data: { count },
            message: `Marked ${count} notification(s) as read`
        });
    });

    /** GET /api/agent/notification-preferences */
    static getPreferences = asyncHandler(async (req: Request, res: Response) => {
        const agentId = req.auth!.role_entity._id;
        const prefs = await AgentNotificationController.service.getPreferences(agentId);

        res.status(200).json({
            success: true,
            data: {
                inAppEnabled: prefs.inAppEnabled,
                emailEnabled: prefs.emailEnabled,
                telegramEnabled: prefs.telegramEnabled,
                whatsappEnabled: prefs.whatsappEnabled,
                emailVerified: prefs.emailVerified,
                telegramVerified: prefs.telegramVerified,
                whatsappVerified: prefs.whatsappVerified,
                preferences: prefs.preferences
            }
        });
    });

    /** PATCH /api/agent/notification-preferences */
    static updatePreferences = asyncHandler(async (req: Request, res: Response) => {
        const agentId = req.auth!.role_entity._id;
        const updates = UpdateAgentNotificationPreferencesSchema.parse(req.body);

        const prefs = await AgentNotificationController.service.updatePreferences(agentId, updates);

        res.status(200).json({
            success: true,
            data: {
                inAppEnabled: prefs.inAppEnabled,
                emailEnabled: prefs.emailEnabled,
                telegramEnabled: prefs.telegramEnabled,
                whatsappEnabled: prefs.whatsappEnabled,
                emailVerified: prefs.emailVerified,
                telegramVerified: prefs.telegramVerified,
                whatsappVerified: prefs.whatsappVerified,
                preferences: prefs.preferences
            },
            message: 'Preferences updated successfully'
        });
    });
}
