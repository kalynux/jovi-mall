import { Router } from 'express';
import { WhatsappController } from './whatsapp.controller';
import { CommandBus } from '../command-bus/command-bus';
import { requireAuth } from '../../api/middlewares/auth.middleware';

export function createWhatsappRouter(commandBus: CommandBus): Router {
  const router = Router();
  const controller = new WhatsappController(commandBus);

  // Webhook (no auth - called by n8n)
  router.post('/', controller.handleWebhook);

  // Link management (requires auth)
  router.get('/link/status', requireAuth, controller.getStatus);
  router.delete('/link', requireAuth, controller.unlinkAccount);

  return router;
}
