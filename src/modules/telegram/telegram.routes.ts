import { Router } from 'express';
import { TelegramController } from './telegram.controller';
import { CommandBus } from '../command-bus/command-bus';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';

export function createTelegramRouter(commandBus: CommandBus): Router {
    const router = Router();
    const controller = new TelegramController(commandBus);

    // Public webhook (from n8n)
    router.post('/webhook', controller.handleWebhook);

    // Authenticated customer endpoints
    router.post('/link-token', requireAuth, controller.generateLinkToken);
    router.get('/status', requireAuth, controller.getStatus);
    router.post('/toggle', requireAuth, controller.toggleActivation);
    router.post('/disconnect', requireAuth, controller.disconnectAccount);

    // Admin-only endpoint
    router.post('/send', requireAuth, requireRole(['admin']), controller.sendNotification);

    return router;
}
