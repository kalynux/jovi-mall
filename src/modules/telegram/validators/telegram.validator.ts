import { z } from 'zod';

/**
 * Schema for sending Telegram notifications
 */
export const SendNotificationSchema = z.object({
    userId: z.string().optional(),
    chatId: z.string().optional(),
    message: z.string().min(1, 'Message is required').max(4096, 'Message too long'),
}).refine(
    (data) => data.userId || data.chatId,
    {
        message: 'Either userId or chatId must be provided',
    }
);

export type SendNotificationInput = z.infer<typeof SendNotificationSchema>;
