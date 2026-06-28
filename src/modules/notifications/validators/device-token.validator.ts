import { z } from 'zod';

/**
 * Register Device Token Schema
 *
 * Validates the FCM token registration payload.
 */
export const RegisterDeviceTokenSchema = z.object({
    token: z.string().min(1, 'token is required').max(4096),
    platform: z.enum(['web', 'android', 'ios']),
    userAgent: z.string().max(512).optional()
});

export type RegisterDeviceToken = z.infer<typeof RegisterDeviceTokenSchema>;

/**
 * Unregister Device Token Schema
 *
 * Validates the token to remove (e.g. on logout).
 */
export const UnregisterDeviceTokenSchema = z.object({
    token: z.string().min(1, 'token is required').max(4096)
});

export type UnregisterDeviceToken = z.infer<typeof UnregisterDeviceTokenSchema>;
