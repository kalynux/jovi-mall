import { Router, Request, Response, NextFunction } from 'express';
import { GoogleCalendarProvider } from './google.provider';
import { requireAuth } from '../../../../api/middlewares/auth.middleware';
import { OAuthStateService } from '../../../auth/services/oauth-state.service';
import { ConnectedCalendarAccount } from './connected-account.model';
import { VendorModel } from '../../../vendors/vendor.model';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { sendSuccess, sendMessage } from '../../../../core/responses';

const router = Router();
const provider = new GoogleCalendarProvider();
const oauthStateService = new OAuthStateService();

/**
 * Custom URL schemes a packaged app may ask the OAuth result to be handed back
 * to, from `GOOGLE_OAUTH_APP_SCHEMES` (comma-separated, no colon — `wivendor`).
 *
 * Read per call rather than cached at import: the rest of this file reads its
 * environment the same way, and a cached copy is the kind of thing that makes a
 * config change look like it did not take.
 */
function appSchemes(): string[] {
  return (process.env.GOOGLE_OAUTH_APP_SCHEMES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/:$/, ''))
    .filter(Boolean);
}

/**
 * Whether the OAuth result may be handed back to this URL.
 *
 * Two shapes are accepted and nothing else:
 *
 *  - a **custom scheme** named in `GOOGLE_OAUTH_APP_SCHEMES`, which is how a
 *    packaged app receives the redirect (`wivendor://services/calendar`);
 *  - the **configured web dashboard**, matched on origin so any path within the
 *    same app is fine.
 *
 * The check runs when the state is MINTED, not when it is consumed, so a bad
 * value is refused before the user is ever sent to Google — and the value that
 * reaches the callback is sealed inside a signed token that cannot be edited in
 * transit. It is re-checked on the way out anyway: "we signed it" proves only
 * that we minted it, not that this deployment still allows it.
 *
 * ⚠ A custom scheme has no meaningful authority component and any app on the
 * device may claim it, so in principle a hostile app could receive this
 * redirect. What it would receive is `?calendar=connected` — no code, no token,
 * no identifier; the credential exchange has already happened server-side by
 * then. That is why the scheme leg neither needs nor can have the origin check
 * the https leg gets. (App Links close even that gap, once a release key exists
 * to sign `assetlinks.json` with.)
 */
function isAllowedReturnTo(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (appSchemes().includes(scheme)) return true;

  // Guarded on protocol as well as origin: `URL.origin` is the string "null" for
  // every non-special scheme, so two unrelated custom-scheme URLs compare equal
  // on origin alone.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const base = process.env.GOOGLE_OAUTH_FRONTEND_REDIRECT_URL;
  if (!base) return false;
  try {
    return new URL(base).origin === url.origin;
  } catch {
    return false;
  }
}

/**
 * After the OAuth callback completes, hand control back to the caller by
 * redirecting with a result query string (e.g. `?calendar=connected` or
 * `?calendar=error&reason=...`).
 *
 * `returnTo` comes from the verified state and has already been allowlisted.
 * Without one — the web dashboard, and any failure that happens before the state
 * can be read — it falls back to `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL`, which is
 * exactly the behaviour every existing caller had.
 *
 * Returns true if it redirected; false when there is nowhere to send the user,
 * in which case the caller falls back to a JSON response / error (non-breaking).
 */
function redirectOAuthResult(
  res: Response,
  params: Record<string, string>,
  returnTo?: string,
): boolean {
  const base = returnTo ?? process.env.GOOGLE_OAUTH_FRONTEND_REDIRECT_URL;
  if (!base) return false;
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  res.redirect(url.toString());
  return true;
}

/**
 * GET /integrations/google/connect
 * Redirects the user to Google's OAuth consent screen.
 * Requires browser cookie authentication (access_token JWT cookie).
 */
router.get(
  '/connect',
  requireAuth,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth!.user.id;

    // Generate OAuth state for CSRF protection — signed JWT is the security mechanism;
    // userId is used as both the subject and the session nonce.
    const state = oauthStateService.generateState({ userId });

    // Get Google auth URL with state
    const url = provider.getAuthUrl(state);
    res.redirect(url);
  })
);

/**
 * POST /integrations/google/connect-url
 *
 * Mint the Google consent URL for a caller that cannot simply be redirected.
 *
 * A packaged app is exactly that caller: it authenticates with a bearer token,
 * so it has no cookie for `/connect` to read, and its WebView must not navigate
 * to Google at all — Google refuses OAuth in an embedded WebView
 * (`disallowed_useragent`). So the app asks for the URL here, opens it in a
 * system browser tab over itself, and names the custom-scheme URL it wants the
 * result handed back to.
 *
 * Auth: required. `requireAuth` prefers the `Authorization` header over the
 * cookie, so this works for both transports without a second code path.
 */
router.post(
  '/connect-url',
  requireAuth,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth!.user.id;
    const raw = (req.body as { returnTo?: unknown } | undefined)?.returnTo;
    const returnTo = typeof raw === 'string' ? raw.trim() : '';

    // Refused here rather than silently ignored: a caller that asked to be sent
    // somewhere and is quietly sent somewhere else would look like the redirect
    // simply never fired, three screens later and in a browser tab.
    if (returnTo && !isAllowedReturnTo(returnTo)) {
      return next(
        createAppError(
          ERROR_CODES.VALIDATION_ERROR,
          400,
          'returnTo is not an allowed redirect target',
        ),
      );
    }

    const state = oauthStateService.generateState({
      userId,
      ...(returnTo ? { returnTo } : {}),
    });

    sendSuccess(res, { url: provider.getAuthUrl(state) });
  })
);

/**
 * GET /integrations/google/callback
 * Handles the OAuth callback from Google.
 *
 * ── Why this route is not behind `requireAuth` ────────────────────────────────
 *
 * It never needed to be. The `state` is a JWT this service signed, bound to the
 * user id and expiring in five minutes — the route's own comment already called
 * that "the guarantee", and the cookie check was a second opinion about a fact
 * the state already established. Requiring the caller's own session on a
 * redirect *arriving from Google* is the unusual part.
 *
 * It also cannot survive contact with a packaged app. The consent screen opens
 * in a system browser tab whose cookie jar is not the app's, so the callback
 * would land with no session at all and 401 after the user had already
 * approved — the worst possible place to fail.
 *
 * The consequence is that `state_mismatch` is now unreachable: there is no
 * second identity to disagree with. Callers may keep the string; nothing emits
 * it.
 */
router.get(
  '/callback',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { code, state, error: googleError } = req.query;

    if (!state || typeof state !== 'string') {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'missing_state' })) return;
      return next(createAppError(ERROR_CODES.AUTH_OAUTH_STATE_INVALID, 400, 'Missing OAuth state'));
    }

    // The state is verified FIRST, before the code is even looked at, for two
    // reasons: it is now the only thing identifying the user, and it carries
    // `returnTo` — so every failure below this line can still land the caller
    // back in the app it started from, instead of stranding a phone on the web
    // dashboard in a browser tab it cannot sign in to.
    let userId: string;
    let returnTo: string | undefined;
    try {
      const verified = oauthStateService.verifyState(state);
      userId = verified.userId;
      // Re-checked on the way out: the allowlist may have changed since the state
      // was minted, and a five-minute-old signature is not a standing permission.
      returnTo =
        verified.returnTo && isAllowedReturnTo(verified.returnTo) ? verified.returnTo : undefined;
    } catch (error: any) {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'invalid_state' })) return;
      return next(createAppError(ERROR_CODES.AUTH_OAUTH_STATE_EXPIRED, 403, 'Invalid or expired OAuth state'));
    }

    // Google reports a refusal as `?error=access_denied&state=…` with no code.
    // Reported as itself rather than left to fall through to `missing_code`,
    // which tells someone who just pressed Cancel that Google failed to send a
    // code: true, and useless.
    if (typeof googleError === 'string' && googleError) {
      const reason = googleError === 'access_denied' ? 'access_denied' : 'connection_failed';
      if (redirectOAuthResult(res, { calendar: 'error', reason }, returnTo)) return;
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, `Google returned ${googleError}`));
    }

    if (!code || typeof code !== 'string') {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'missing_code' }, returnTo)) return;
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Missing or invalid authorization code'));
    }

    // Check if user is a vendor and get vendorId
    const vendor = await VendorModel.findOne({ user_id: userId });
    const vendorId = vendor?._id.toString();

    try {
      await provider.handleCallback(code, userId, vendorId);
    } catch (error) {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'connection_failed' }, returnTo)) return;
      throw error;
    }

    if (redirectOAuthResult(res, { calendar: 'connected' }, returnTo)) return;
    sendMessage(res, 'Google Calendar connected successfully');
  })
);

/**
 * GET /integrations/google/status
 * Checks if the current user has a connected Google Calendar account.
 */
router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user.id;
    if (!userId) return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));

    const account = await ConnectedCalendarAccount.findOne({ userId, provider: 'google' });

    if (account) {
      sendSuccess(res, {
        connected: true,
        email: account.email,
        expiresAt: account.expiresAt,
      });
    } else {
      sendSuccess(res, { connected: false });
    }
  })
);

/**
 * POST /integrations/google/disconnect
 * Disconnects the user's Google Calendar account.
 */
router.post(
  '/disconnect',
  requireAuth,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user.id;
    if (!userId) return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));

    await provider.disconnect(userId);
    res.json({ success: true, message: 'Disconnected successfully' });
  })
);

/**
 * GET /integrations/google/test
 * Tests the connection by listing calendars.
 */
router.get(
  '/test',
  requireAuth,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user.id;
    if (!userId) return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));

    try {
      const result = await provider.testConnection(userId);
      sendSuccess(res, { ok: result });
    } catch (error: unknown) {
      /**
       * ⚠ Forward an AppError UNCHANGED. Fixed 2026-09-07 (DOC-PROGRAM § 30).
       *
       * This catch used to re-wrap **everything** as
       * `INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER` at 500, which swallowed the one answer
       * a caller actually needs: `getAuthenticatedClient` raises
       * `400 GOOGLE_CALENDAR_NOT_CONNECTED` for a vendor who never connected, and that
       * became a 500. Worse, the re-wrap passed `error.message` through — and 500 derives
       * category `internal`, so the boundary then replaced the message with the registry
       * default and dropped `details`. The real reason reached nobody, and `/test` could not
       * distinguish "not connected" from "connected but broken".
       *
       * Anything that is not an AppError is a genuine provider fault and keeps the old
       * shape.
       */
      if (error instanceof AppError) return next(error);
      const message = error instanceof Error ? error.message : String(error);
      next(createAppError(ERROR_CODES.INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER, 500, message));
    }
  })
);

export const googleRoutes = router;
