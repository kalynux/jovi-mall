import { Router } from 'express';
import { TelegramController } from './telegram.controller';
import { CommandBus } from '../command-bus/command-bus';
import { requireBotWebhookSecret } from '../../api/middlewares/bot-webhook.middleware';

/**
 * Telegram routes, mounted at `/api/webhooks/telegram`. **One route, and it is a genuine
 * webhook.**
 *
 * The four account-linking endpoints that used to sit here — `link-token`,
 * `status`, `toggle`, `disconnect` — are gone. They were authenticated,
 * user-facing endpoints that inherited this prefix's rate-limit and maintenance
 * exemptions purely by being routed next to a webhook. Their replacement is
 * `/api/me/connections`.
 *
 * `POST /send` is gone too, for the same reason one step further (Phase 5 Part C). It was
 * an ADMIN-only capability on a public-looking prefix, guarded by `requireRole(['admin'])`
 * — a platform `users` row that predates wi-admin's permission catalog and carries no
 * tier. It now lives at `POST /api/internal/admin/messaging/telegram`
 * (`admin-messaging.routes.ts`), behind the service token, gated on
 * `messaging.telegram.send`, and audited against a real administrator identity. That was
 * the last of the three admin-only endpoints hiding outside `/api/admin`; the file pair
 * went at Part B.
 *
 * ⚠ **What is left is the ONLY thing that belongs here**, and the distinction is the point
 * of both removals: inbound, called by the automation layer rather than a person, and
 * authenticated by a shared secret rather than a session. If a route on this prefix has a
 * `requireAuth` or a `requireRole` on it, it is in the wrong file.
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

    return router;
}
