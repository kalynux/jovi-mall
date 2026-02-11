import { Request, Response } from 'express';
import { TelegramService } from "./telegram.service";
import { TelegramLinkService } from './services/telegram-link.service';
import { TelegramNotificationService } from './services/telegram-notification.service';
import { SendNotificationSchema } from './validators/telegram.validator';
import { CommandBus } from '../command-bus/command-bus';

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
    handleWebhook = async (req: Request, res: Response) => {
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
            res.status(400).json({ error: error.message });
        }
    };

    /**
     * Generate link token for authenticated user
     */
    generateLinkToken = async (req: Request, res: Response) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }

            const result = await this.linkService.generateLinkToken(userId);
            res.status(200).json(result);
        } catch (error: any) {
            console.error('[Telegram] Error generating link token:', error.message);
            res.status(500).json({ error: 'Failed to generate link token' });
        }
    };

    /**
     * Get Telegram link status for authenticated user
     */
    getStatus = async (req: Request, res: Response) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }

            const status = await this.linkService.getStatus(userId);
            res.status(200).json(status);
        } catch (error: any) {
            console.error('[Telegram] Error getting status:', error.message);
            res.status(500).json({ error: 'Failed to get status' });
        }
    };

    /**
     * Toggle activation state for authenticated user
     */
    toggleActivation = async (req: Request, res: Response) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }

            const result = await this.linkService.toggleActivation(userId);
            res.status(200).json(result);
        } catch (error: any) {
            console.error('[Telegram] Error toggling activation:', error.message);

            if (error.message.includes('not found')) {
                res.status(404).json({ error: 'No Telegram account linked' });
                return;
            }

            res.status(500).json({ error: 'Failed to toggle activation' });
        }
    };

    /**
     * Send notification (admin only)
     */
    sendNotification = async (req: Request, res: Response) => {
        try {
            // Validate request body
            const validatedData = SendNotificationSchema.parse(req.body);

            const result = await this.notificationService.send(validatedData);

            if (result.success) {
                res.status(200).json(result);
            } else {
                res.status(400).json(result);
            }
        } catch (error: any) {
            console.error('[Telegram] Error sending notification:', error.message);

            if (error.name === 'ZodError') {
                res.status(400).json({ error: 'Validation failed', details: error.errors });
                return;
            }

            res.status(500).json({ error: 'Failed to send notification' });
        }
    };

    /**
     * Disconnect Telegram account for authenticated user
     */
    disconnectAccount = async (req: Request, res: Response) => {
        try {
            const userId = req.auth?.user?.id;

            if (!userId) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }

            await this.linkService.disconnectAccount(userId);
            res.status(200).json({ success: true, message: 'Account disconnected' });
        } catch (error: any) {
            console.error('[Telegram] Error disconnecting account:', error.message);

            if (error.message.includes('No Telegram account')) {
                res.status(404).json({ error: 'No Telegram account linked' });
                return;
            }

            res.status(500).json({ error: 'Failed to disconnect account' });
        }
    };
}
