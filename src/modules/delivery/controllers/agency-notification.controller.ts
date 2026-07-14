import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { AgencyNotificationService } from '../../notifications/services/agency-notification.service';
import {
    ListAgencyNotificationsQuerySchema,
    MarkAgencyNotificationReadParamSchema,
    UpdateAgencyNotificationPreferencesSchema
} from '../validators/agency-notification.validator';

/**
 * AgencyNotificationController
 *
 * Thin HTTP layer for the agency notification subsystem. Mounted at
 * `/api/agency` → `/agency/notifications`, `/agency/notification-preferences`.
 */
export class AgencyNotificationController {
    private static service = new AgencyNotificationService();

    static listNotifications = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id;
        const query = ListAgencyNotificationsQuerySchema.parse(req.query);

        const result = await AgencyNotificationController.service.listNotifications(agencyId, {
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
        const agencyId = req.auth!.role_entity._id;
        const params = MarkAgencyNotificationReadParamSchema.parse(req.params);

        const notification = await AgencyNotificationController.service.markAsRead(params.id, agencyId);

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
        const agencyId = req.auth!.role_entity._id;
        const count = await AgencyNotificationController.service.markAllAsRead(agencyId);

        res.status(200).json({
            success: true,
            data: { count },
            message: `Marked ${count} notification(s) as read`
        });
    });

    /** GET /api/agency/notification-preferences */
    static getPreferences = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id;
        const prefs = await AgencyNotificationController.service.getPreferences(agencyId);

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

    /** PATCH /api/agency/notification-preferences */
    static updatePreferences = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id;
        const updates = UpdateAgencyNotificationPreferencesSchema.parse(req.body);

        const prefs = await AgencyNotificationController.service.updatePreferences(agencyId, updates);

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
