import { Router } from 'express';
import { publicRateLimiter } from '../../../api/rate-limit/rate-limit.middleware';
import { MiniAppController } from './miniapp.controller';

/**
 * `/api/bot/miniapp` — the Telegram Mini App's own mount.
 *
 * ── THREE ROUTES, AND THE MOUNT IS THE SECURITY DECISION ────────────────────
 * This is deliberately NOT under `/api/internal/bot`. That router's first two `router.use`
 * lines demand `INTERNAL_SERVICE_TOKEN` and `BOT_WEBHOOK_SECRET`, and a browser cannot be
 * given either without giving every viewer the whole bot surface. Mounting here instead makes
 * that impossible by construction rather than by a guard somebody could reorder.
 *
 * ⚠ **`GET` is correct here and forbidden next door**, and the difference is what is in the
 * URL. The bot surface bans `GET` because its identity envelope would put a real person's
 * phone number into every access log on the path; what is in these URLs is an opaque
 * random handle that names a shopping list and expires in thirty minutes.
 *
 * ── ITS OWN IP BUCKET, FOR THE STOREFRONT'S REASON ──────────────────────────
 * `publicRateLimiter` is reused rather than a fourth policy invented: this is
 * unauthenticated browser traffic on a page that fires two or three requests per open, which
 * is exactly the shape `PUBLIC_POLICY` was sized for. Layer A still applies on top.
 *
 * ⚠ **Not exempt from maintenance**, unlike `/api/internal/bot/*`'s reads. A `readonly`
 * window blocks the cart write and leaves the page readable, which is the honest behaviour —
 * and a `down` window closes it entirely, as it closes the storefront the page is part of.
 */
const router = Router();

router.use(publicRateLimiter);

/** The page itself. Static, cached nowhere, and it checks no handle — see the controller. */
router.get('/p/:handle', MiniAppController.page);

/** Its data. Same handle, one hop later, as JSON. */
router.get('/api/:handle', MiniAppController.data);

/** The one write. Bounded to variants the set itself offered. */
router.post('/api/:handle/cart', MiniAppController.addToCart);

export default router;
