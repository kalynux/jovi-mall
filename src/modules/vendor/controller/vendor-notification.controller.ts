import { Request, Response, NextFunction } from 'express';
import { VendorNotificationService } from '../../notifications/services/vendor-notification.service';
import {
    ListNotificationsQuerySchema,
    MarkAsReadParamSchema,
    UpdateNotificationPreferencesSchema
} from '../validators/vendor-notification.validator';
import { ValidationError } from '../../../core/errors';

/**
 * VendorNotificationController
 * 
 * Thin HTTP layer for vendor notification operations.
 * Business logic delegated to VendorNotificationService.
 */
export class VendorNotificationController {
    private static service = new VendorNotificationService();

    /**
     * GET /api/vendor/notifications
     * List notifications with filters and pagination
     */
    static async listNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id; // From auth middleware

            // Validate and parse query
            const query = ListNotificationsQuerySchema.parse(req.query);

            const result = await VendorNotificationController.service.listNotifications(
                vendorId,
                { isRead: query.isRead },
                { page: query.page, limit: query.limit }
            );

            res.json({
                success: true,
                data: result.notifications.map(n => ({
                    id: n._id.toString(),
                    type: n.type,
                    title: n.title,
                    message: n.message,
                    isRead: n.isRead,
                    deliveredVia: n.deliveredVia,
                    createdAt: n.createdAt.toISOString()
                })),
                unreadCount: result.unreadCount,
                meta: result.meta
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * PATCH /api/vendor/notifications/:id/read
     * Mark single notification as read
     */
    static async markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id;
            const params = MarkAsReadParamSchema.parse(req.params);

            const notification = await VendorNotificationController.service.markAsRead(
                params.id,
                vendorId
            );

            res.json({
                success: true,
                data: {
                    id: notification._id.toString(),
                    type: notification.type,
                    title: notification.title,
                    message: notification.message,
                    aggregateType: notification.aggregateType,
                    aggregateId: notification.aggregateId.toString(),
                    deliveredVia: notification.deliveredVia,
                    isRead: notification.isRead,
                    readAt: notification.readAt?.toISOString() || null,
                    createdAt: notification.createdAt.toISOString()
                },
                message: 'Notification marked as read'
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * POST /api/vendor/notifications/read-all
     * Mark ALL notifications as read (bulk operation)
     */
    static async markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id;

            const count = await VendorNotificationController.service.markAllAsRead(vendorId);

            res.json({
                success: true,
                data: { count },
                message: `Marked ${count} notification(s) as read`
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * GET /api/vendor/notification-preferences
     * Get vendor notification preferences
     */
    static async getPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id;

            const prefs = await VendorNotificationController.service.getPreferences(vendorId);

            res.json({
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
        } catch (error) {
            next(error);
        }
    }

    /**
     * PATCH /api/vendor/notification-preferences
     * Update notification preferences
     */
    static async updatePreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id;
            const updates = UpdateNotificationPreferencesSchema.parse(req.body);

            const prefs = await VendorNotificationController.service.updatePreferences(
                vendorId,
                updates
            );

            res.json({
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
        } catch (error) {
            next(error);
        }
    }
}
