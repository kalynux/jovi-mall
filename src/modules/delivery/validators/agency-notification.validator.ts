import { z } from 'zod';

export const ListAgencyNotificationsQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(50).default(20)
});

export type ListAgencyNotificationsQuery = z.infer<typeof ListAgencyNotificationsQuerySchema>;

export const MarkAgencyNotificationReadParamSchema = z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid notification ID')
});

export type MarkAgencyNotificationReadParam = z.infer<typeof MarkAgencyNotificationReadParamSchema>;

/**
 * Update Agency Notification Preferences Schema
 *
 * Mirrors UpdateNotificationPreferencesSchema (vendor). No refine for
 * exclusivity - backend auto-disables other channels using priority order:
 * telegram > email > whatsapp.
 */
export const UpdateAgencyNotificationPreferencesSchema = z.object({
    emailEnabled: z.boolean().optional(),
    telegramEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional(),

    preferences: z.object({
        connectionUpdated: z.boolean().optional(),
        shipmentAssigned: z.boolean().optional(),
        payoutUpdates: z.boolean().optional()
    }).optional()
});

export type UpdateAgencyNotificationPreferences = z.infer<typeof UpdateAgencyNotificationPreferencesSchema>;
