import { Router } from 'express';
import { FlowDataController } from './flow-data.controller';

/**
 * `/api/webhooks/whatsapp/flows` — the one route Meta calls.
 *
 * ── ⚠ WHY THIS IS NOT A ROUTE INSIDE `whatsapp.routes.ts` ───────────────────
 * That router's single route is guarded by `requireBotWebhookSecret`, and the guard is
 * correct there: its caller is the **automation layer**, which holds `BOT_WEBHOOK_SECRET`.
 *
 * This endpoint's caller is **Meta**, which does not hold it and never will. Adding a route
 * inside that router would either inherit a guard that refuses every genuine request, or
 * require an exemption branch inside it — and an exemption inside a shared guard is how a
 * webhook ends up unauthenticated by accident. A separate mount makes the two callers'
 * different credentials a structural fact rather than a condition somebody can invert.
 *
 * What authenticates this one instead is `X-Hub-Signature-256`, computed with the App Secret
 * — see `domain/flow-signature.ts`.
 *
 * ── MOUNTED ABOVE `/webhooks/whatsapp`, DELIBERATELY ────────────────────────
 * `createWhatsappRouter` declares exactly one route, `POST /`, so a request for
 * `/webhooks/whatsapp/flows` entering it would fall through harmlessly today. That is a fact
 * about another file's current contents, not a property — a `POST /:messageId` added there
 * next year would swallow this endpoint silently, and the failure would be a Flow that stops
 * working with nothing in this module changed.
 *
 * This service has shipped the literal-behind-parameter defect twice already
 * (`/articles/index` behind `/articles/:slug`, `/orders/groups/:cartId` behind
 * `/orders/:id`). Declaring the more specific mount first costs nothing and removes the
 * class.
 *
 * ── NOT RATE LIMITED, AND THAT IS THE EXISTING POLICY ───────────────────────
 * `/api/webhooks/*` is exempt from the limiter, with the reason written at the exemption:
 * a 429 to a webhook sender is a lost event, not a throttled user. The same argument applies
 * here with an extra edge — a rate-limited health check makes a Flow unpublishable.
 */
const router = Router();

/**
 * ⚠ **The health check and the data exchange are ONE route**, because Meta sends both to one
 * URL and tells them apart by the `action` field *inside the encrypted body*. There is no way
 * to route them separately: the discriminator is not readable until after decryption.
 */
router.post('/', FlowDataController.exchange);

export default router;
