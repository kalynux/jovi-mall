import { z } from 'zod';

/**
 * List Notifications Query Schema
 * 
 * Validates query parameters for listing notifications.
 */
export const ListNotificationsQuerySchema = z.object({
    isRead: z
        .string()
        .optional()
        .transform(val => val === 'true'),
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(50).default(20)
});

export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

/**
 * Mark As Read Param Schema
 * 
 * Validates notification ID parameter.
 */
export const MarkAsReadParamSchema = z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid notification ID')
});

export type MarkAsReadParam = z.infer<typeof MarkAsReadParamSchema>;

/**
 * Update Notification Preferences Schema
 * 
 * Validates preference update payload.
 * 
 * Note: No refine for exclusivity - backend auto-disables other channels
 * using priority order: email > telegram > whatsapp
 */
export const UpdateNotificationPreferencesSchema = z.object({
    // Channel enablement
    emailEnabled: z.boolean().optional(),
    telegramEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional(),

    // Event preferences
    preferences: z.object({
        orderCreated: z.boolean().optional(),
        orderCancelled: z.boolean().optional(),
        bookingCreated: z.boolean().optional(),
        bookingCancelled: z.boolean().optional(),
        paymentReceivedPartial: z.boolean().optional(),
        paymentReceivedFull: z.boolean().optional(),
        storageAlert: z.boolean().optional(),
        connectionUpdated: z.boolean().optional(),
        payoutUpdates: z.boolean().optional(),
        shipmentRejected: z.boolean().optional()
    }).optional()
});

export type UpdateNotificationPreferences = z.infer<typeof UpdateNotificationPreferencesSchema>;
