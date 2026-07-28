import { z } from 'zod';

export const ListAgentNotificationsQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(50).default(20)
});

export type ListAgentNotificationsQuery = z.infer<typeof ListAgentNotificationsQuerySchema>;

export const MarkAgentNotificationReadParamSchema = z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid notification ID')
});

export type MarkAgentNotificationReadParam = z.infer<typeof MarkAgentNotificationReadParamSchema>;

/**
 * Update Agent Notification Preferences Schema
 *
 * Mirrors UpdateAgencyNotificationPreferencesSchema. No refine for exclusivity -
 * backend auto-disables other channels using priority order:
 * telegram > email > whatsapp.
 */
export const UpdateAgentNotificationPreferencesSchema = z.object({
    emailEnabled: z.boolean().optional(),
    telegramEnabled: z.boolean().optional(),
    whatsappEnabled: z.boolean().optional(),

    preferences: z.object({
        codDepositUpdates: z.boolean().optional(),
        assignmentOffers: z.boolean().optional(),
        planUpdates: z.boolean().optional(),
        storageAlert: z.boolean().optional()
    }).optional()
});

export type UpdateAgentNotificationPreferences = z.infer<typeof UpdateAgentNotificationPreferencesSchema>;
