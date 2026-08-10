import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { CustomerNotificationService } from '../services/customer-notification.service';

const service = new CustomerNotificationService();

// ─── Validation Schemas ────────────────────────────────────────────────────────

const ListSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    unreadOnly: z
        .enum(['true', 'false'])
        .optional()
        .transform(v => v === 'true'),
    aggregateType: z.enum(['booking', 'order', 'shipment', 'payment']).optional()
});

const UpdatePreferencesSchema = z.object({
    emailEnabled: z.boolean().optional(),
    telegramEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional(),
    preferences: z
        .object({
            bookingUpdates: z.boolean().optional(),
            bookingReminders: z.boolean().optional(),
            orderUpdates: z.boolean().optional(),
            marketing: z.boolean().optional()
        })
        .optional()
});

// ─── Controller ────────────────────────────────────────────────────────────────

/**
 * CustomerNotificationController
 *
 * The customer's own notification inbox and channel preferences. Fourth
 * counterpart to the vendor / agency / agent notification controllers.
 *
 * Every handler scopes to `req.auth.role_entity` (the Customer profile), so one
 * customer can never read or acknowledge another's notifications.
 */
export class CustomerNotificationController {
    /**
     * GET /api/customer/notifications
     * Query: page, limit, unreadOnly, aggregateType.
     */
    static list = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const { page, limit, unreadOnly, aggregateType } = ListSchema.parse(req.query);

        const result = await service.listNotifications(
            customerId,
            { page, limit },
            { unreadOnly, aggregateType }
        );

        res.json({
            success: true,
            data: result.notifications,
            meta: { ...result.meta, unreadCount: result.unreadCount }
        });
    });

    /**
     * GET /api/customer/notifications/unread-count
     * Just the badge number — avoids fetching a page of rows to render one integer.
     */
    static unreadCount = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const unreadCount = await service.countUnread(customerId);
        res.json({ success: true, data: { unreadCount } });
    });

    /**
     * GET /api/customer/notifications/preferences
     * Verification status is computed live, not read from the stored flags.
     */
    static getPreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const prefs = await service.getPreferences(customerId);
        res.json({ success: true, data: prefs });
    });

    /**
     * PATCH /api/customer/notifications/preferences
     *
     * Enabling one secondary channel auto-disables the others, and an unverified
     * channel is refused with 400 rather than silently accepted.
     */
    static updatePreferences = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const updates = UpdatePreferencesSchema.parse(req.body);
        const prefs = await service.updatePreferences(customerId, updates);

        res.json({ success: true, data: prefs, message: 'Notification preferences updated' });
    });

    /** PATCH /api/customer/notifications/read-all */
    static markAllAsRead = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const updated = await service.markAllAsRead(customerId);
        res.json({ success: true, data: { updated }, message: 'All notifications marked as read' });
    });

    /** PATCH /api/customer/notifications/:id/read */
    static markAsRead = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const customerId = req.auth!.role_entity._id.toString();
        const notification = await service.markAsRead(req.params.id, customerId);
        res.json({ success: true, data: notification, message: 'Notification marked as read' });
    });
}
