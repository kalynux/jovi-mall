import { Request, Response, NextFunction } from 'express';
import { TelegramService } from "./telegram.service";
import { TelegramLinkService } from './services/telegram-link.service';
import { TelegramNotificationService } from './services/telegram-notification.service';
import { SendNotificationSchema } from './validators/telegram.validator';
import { CommandBus } from '../command-bus/command-bus';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

interface TelegramWebhookPayload {
    chat_id: string;
    user_id?: string;
    is_command: boolean;
    command?: string;
    payload?: any;
}

export class TelegramController {
    private telegramService: TelegramService;
    private linkService: TelegramLinkService;
    private notificationService: TelegramNotificationService;
    private commandBus: CommandBus;

    constructor(commandBus: CommandBus) {
        this.telegramService = new TelegramService();
        this.linkService = new TelegramLinkService();
        this.notificationService = new TelegramNotificationService();
        this.commandBus = commandBus;
    }

    /**
     * Handle webhook from n8n (Telegram bot messages)
     */
    handleWebhook = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const body: TelegramWebhookPayload = req.body;
            const { chat_id, is_command, command, payload, user_id } = body;

            // 2. Handle Command via Bus
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
            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
        }
    });

    /**
     * Generate link token for authenticated user
     */
    generateLinkToken = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
            }

            const result = await this.linkService.generateLinkToken(userId);
            res.status(200).json(result);
        } catch (error: any) {
            console.error('[Telegram] Error generating link token:', error.message);
            next(createAppError(ERROR_CODES.TELEGRAM_LINK_FAILED, 500, 'Failed to generate link token'));
        }
    });

    /**
     * Get Telegram link status for authenticated user
     */
    getStatus = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
            }

            const status = await this.linkService.getStatus(userId);
            res.status(200).json(status);
        } catch (error: any) {
            console.error('[Telegram] Error getting status:', error.message);
            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to get status'));
        }
    });

    /**
     * Toggle activation state for authenticated user
     */
    toggleActivation = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
            }

            const result = await this.linkService.toggleActivation(userId);
            res.status(200).json(result);
        } catch (error: any) {
            console.error('[Telegram] Error toggling activation:', error.message);

            if (error.message.includes('not found')) {
                return next(createAppError(ERROR_CODES.TELEGRAM_NOT_LINKED, 404, 'No Telegram account linked'));
            }

            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to toggle activation'));
        }
    });

    /**
     * Send notification (admin only)
     */
    sendNotification = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            // Validate request body
            const validatedData = SendNotificationSchema.parse(req.body);

            const result = await this.notificationService.send(validatedData);

            if (result.success) {
                res.status(200).json(result);
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

    /**
     * Disconnect Telegram account for authenticated user
     */
    disconnectAccount = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
            }

            await this.linkService.disconnectAccount(userId);
            res.status(200).json({ success: true, message: 'Account disconnected' });
        } catch (error: any) {
            console.error('[Telegram] Error disconnecting account:', error.message);

            if (error.message.includes('No Telegram account')) {
                return next(createAppError(ERROR_CODES.TELEGRAM_NOT_LINKED, 404, 'No Telegram account linked'));
            }

            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to disconnect account'));
        }
    });
}
