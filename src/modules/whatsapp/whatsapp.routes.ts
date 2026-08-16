import { Router } from 'express';
import { WhatsappController } from './whatsapp.controller';
import { CommandBus } from '../command-bus/command-bus';
import { requireBotWebhookSecret } from '../../api/middlewares/bot-webhook.middleware';

/**
 * WhatsApp routes, mounted at `/api/webhooks/whatsapp`.
 *
 * Webhook only. The two authenticated link routes that used to share this
 * prefix are now `/api/me/connections` — see
 * `modules/connections/connection.routes.ts` for why the mount point mattered.
 */
export function createWhatsappRouter(commandBus: CommandBus): Router {
  const router = Router();
  const controller = new WhatsappController(commandBus);

  /**
   * The shared-secret guard. Load-bearing since `/connect`: this endpoint now MINTS a
   * connection credential for whatever identity the request names, so an open one lets
   * anybody mint a code against a stranger's number. See the middleware for the unset
   * behaviour — production refuses, development warns.
   */
  router.post('/', requireBotWebhookSecret, controller.handleWebhook);

  return router;
}
