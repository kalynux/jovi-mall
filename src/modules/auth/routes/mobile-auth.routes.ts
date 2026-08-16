import { Router } from 'express';
import { MobileAuthController } from '../controllers/mobile-auth.controller';
import { requireAuth } from '../../../api/middlewares/auth.middleware';

/**
 * Mobile auth routes, mounted at `/api/auth/mobile/*`.
 *
 * A parallel namespace beside `/api/auth/browser/*`, not a different session model: the same
 * `AuthService`, the same JWTs, the same lifetimes, the same error codes. The only difference
 * is delivery — the pair comes back in `data.tokens` and no cookie is set. The reasoning is on
 * `controllers/mobile-auth.controller.ts`.
 *
 * ── Two deliberate omissions ──────────────────────────────────────────────────
 *
 * **No `requireJsonContent`.** The browser namespace applies it as a CSRF mitigation, and the
 * mitigation works because a browser cannot send `application/json` cross-origin without a
 * preflight — which matters only when the request carries an *ambient* credential the attacker
 * does not have to hold. Nothing here reads or writes a cookie, so there is no ambient
 * credential to forge with: a caller who cannot produce the bearer or the refresh token gets
 * nothing, whatever content type they use. Copying the guard would be copying a control whose
 * written reason does not apply. (`express.json()` still declines to populate `req.body` for a
 * non-JSON content type, so a wrong one fails the schema anyway.)
 *
 * **No `/logout`.** `POST /api/auth/logout` already clears cookies and answers 200, which is a
 * harmless no-op for a client that has none; a bearer client ends its session by discarding
 * the tokens. A second route that does nothing would only be a second thing to document.
 * Server-side revocation is a separate question — tokens here are stateless, so a password
 * change is what revokes them (`core/auth/password-epoch.ts`).
 */

const router = Router();

// ─── Public ──────────────────────────────────────────────────────────────────
router.post('/login', MobileAuthController.login);
router.post('/register', MobileAuthController.register);

/**
 * The refresh token is itself the credential, so this is public in the same sense
 * `/auth/browser/refresh` is. It sits in the looser `auth_session` rate-limit bucket rather
 * than the credential one — see `api/rate-limit/auth-paths.ts`.
 */
router.post('/refresh', MobileAuthController.refresh);

// ─── Authenticated ───────────────────────────────────────────────────────────
router.get('/auth-me/:role', requireAuth, MobileAuthController.authMe);
router.post('/add-role', requireAuth, MobileAuthController.addRole);

export const mobileAuthRoutes = router;
