import { z } from 'zod';

/**
 * The wire shape of the administrative Telegram send.
 *
 * Its only consumer is `admin-messaging.routes.ts`, behind
 * `POST /api/internal/admin/messaging/telegram` — the legacy `POST /webhooks/telegram/send`
 * that used to parse it here is deleted (Phase 5 Part C). Kept in `validators/` rather than
 * inlined at the route because it is the schema of a *message*, which is this module's
 * concern, not the router's.
 *
 * ⚠ **Exactly one of `userId` / `chatId` is not what this says — it says AT LEAST one.**
 * The `refine` accepts both being present, and `TelegramNotificationService.send` then
 * prefers `chatId` and never resolves the `userId`. That is a silent contradiction of the
 * caller's intent, so wi-admin's own schema refuses the pair before the hop
 * (`messaging.validator.ts`) and its `test:messaging` pins the refusal. Left permissive
 * here deliberately: this side is the second lock, and tightening it would change the
 * behaviour of a shape wi-admin has already narrowed.
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
