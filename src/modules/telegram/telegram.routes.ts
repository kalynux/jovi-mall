import { Router } from 'express';
import { TelegramController } from './telegram.controller';
import { CommandBus } from '../command-bus/command-bus';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { requireBotWebhookSecret } from '../../api/middlewares/bot-webhook.middleware';

/**
 * Telegram routes, mounted at `/api/webhooks/telegram`.
 *
 * The four account-linking endpoints that used to sit here — `link-token`,
 * `status`, `toggle`, `disconnect` — are gone. They were authenticated,
 * user-facing endpoints that inherited this prefix's rate-limit and maintenance
 * exemptions purely by being routed next to a webhook. Their replacement is
 * `/api/me/connections`.
 */
export function createTelegramRouter(commandBus: CommandBus): Router {
    const router = Router();
    const controller = new TelegramController(commandBus);

    /**
     * The bot bridge, behind the shared-secret guard — load-bearing since `/connect`,
     * which mints a connection credential for whatever identity the request names.
     * See `bot-webhook.middleware.ts` for the unset behaviour.
     */
    router.post('/webhook', requireBotWebhookSecret, controller.handleWebhook);

    // Admin-only direct send
    router.post('/send', requireAuth, requireRole(['admin']), controller.sendNotification);

    return router;
}
