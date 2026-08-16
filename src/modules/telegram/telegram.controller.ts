import { Request, Response, NextFunction } from 'express';
import { TelegramNotificationService } from './services/telegram-notification.service';
import { SendNotificationSchema } from './validators/telegram.validator';
import { CommandBus } from '../command-bus/command-bus';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { AppError, createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess } from '../../core/responses';

interface TelegramWebhookPayload {
    chat_id: string;
    user_id?: string;
    is_command: boolean;
    command?: string;
    payload?: any;
}

/**
 * Telegram bot ingress + the admin direct-send.
 *
 * Account linking is NOT here any more. `link-token`, `status`, `toggle` and
 * `disconnect` moved to `/api/me/connections`, which binds to the User rather
 * than issuing a deep-link token the user carries to the bot. This controller
 * keeps only what genuinely belongs to Telegram: the webhook, and sending.
 */
export class TelegramController {
    private notificationService: TelegramNotificationService;
    private commandBus: CommandBus;

    constructor(commandBus: CommandBus) {
        this.notificationService = new TelegramNotificationService();
        this.commandBus = commandBus;
    }

    /**
     * Inbound bot messages, relayed by the automation layer.
     *
     * Phase 4 registers `connect` on the bus; the context carries `chat_id`,
     * which IS the messaging identity the code will be minted against. Phase
     * `/login` adds `login` and `login_contact` on the same context.
     */
    handleWebhook = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const body: TelegramWebhookPayload = req.body;
            const { chat_id, is_command, command, payload, user_id } = body;

            let result: any = { message: 'Inbound recorded' };
            if (is_command && command) {
                const context = {
                    source: 'telegram',
                    chat_id,
                    user_id,
                };

                console.log(`[Telegram-Webhook] Dispatching command: ${command}`);
                const cmdResult = await this.commandBus.execute(command, payload, context);
                result = { ...result, ...cmdResult };
            }

            res.status(200).json(result);
        } catch (error: any) {
            console.error('[Telegram-Webhook] Error:', error.message);

            /**
             * ⚠ An AppError is forwarded UNCHANGED. This catch used to flatten every
             * failure into `INTERNAL_SERVER_ERROR` at 400, keeping only the message —
             * so a command that raised a precise, deliberate code had it erased on the
             * way out, and every Telegram webhook failure looked identical in the logs,
             * in the metrics and to the automation layer.
             *
             * That became load-bearing with `login_contact`, whose contact-share guard
             * raises `MAGIC_CONTACT_UNVERIFIED` — the one signal that distinguishes
             * "tapped the wrong contact" from an attempted account takeover. Flattened,
             * it was indistinguishable from a null-pointer bug.
             *
             * Non-AppError throws keep the old wrapping: they are genuinely unclassified,
             * and the status stays 400 rather than 500 so the automation layer's existing
             * branch is unchanged.
             */
            if (error instanceof AppError) return next(error);

            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
        }
    });

    /**
     * Send a Telegram message (admin only).
     *
     * Resolves `userId` through the connections module now — the `telegram_links`
     * collection it used to read is gone.
     */
    sendNotification = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const validatedData = SendNotificationSchema.parse(req.body);

            const result = await this.notificationService.send(validatedData);

            if (result.success) {
                sendSuccess(res, result);
            } else {
                next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, result.error));
            }
        } catch (error: any) {
            console.error('[Telegram] Error sending notification:', error.message);

            if (error.name === 'ZodError') {
                return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Validation failed', { details: error.errors }));
            }

            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to send notification'));
        }
    });
}
