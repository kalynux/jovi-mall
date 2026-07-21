import { Router, Request, Response, NextFunction } from 'express';
import { GoogleCalendarProvider } from './google.provider';
import { requireAuth } from '../../../../api/middlewares/auth.middleware';
import { OAuthStateService } from '../../../auth/services/oauth-state.service';
import { ConnectedCalendarAccount } from './connected-account.model';
import { VendorModel } from '../../../vendors/vendor.model';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { sendSuccess, sendMessage } from '../../../../core/responses';

const router = Router();
const provider = new GoogleCalendarProvider();
const oauthStateService = new OAuthStateService();

/**
 * After the OAuth callback completes, hand control back to the frontend by
 * redirecting to GOOGLE_OAUTH_FRONTEND_REDIRECT_URL with a result query string
 * (e.g. `?calendar=connected` or `?calendar=error&reason=...`).
 *
 * Returns true if it redirected; false when no frontend URL is configured, in
 * which case the caller falls back to a JSON response / error (non-breaking).
 */
function redirectOAuthResult(res: Response, params: Record<string, string>): boolean {
  const base = process.env.GOOGLE_OAUTH_FRONTEND_REDIRECT_URL;
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
 * GET /integrations/google/callback
 * Handles the OAuth callback from Google.
 * Requires browser cookie authentication (access_token JWT cookie).
 */
router.get(
  '/callback',
  requireAuth,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { code, state } = req.query;
    const userId = req.auth!.user.id;

    if (!code || typeof code !== 'string') {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'missing_code' })) return;
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Missing or invalid authorization code'));
    }

    if (!state || typeof state !== 'string') {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'missing_state' })) return;
      return next(createAppError(ERROR_CODES.AUTH_OAUTH_STATE_INVALID, 400, 'Missing OAuth state'));
    }

    // Validate OAuth state (CSRF protection — the signed state JWT is the guarantee)
    try {
      const { userId: stateUserId } = oauthStateService.verifyState(state);

      // Verify userId in state matches the authenticated user from cookie
      if (stateUserId !== userId) {
        if (redirectOAuthResult(res, { calendar: 'error', reason: 'state_mismatch' })) return;
        return next(createAppError(ERROR_CODES.AUTH_OAUTH_STATE_INVALID, 403, 'Invalid OAuth state: user mismatch'));
      }
    } catch (error: any) {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'invalid_state' })) return;
      return next(createAppError(ERROR_CODES.AUTH_OAUTH_STATE_EXPIRED, 403, 'Invalid or expired OAuth state'));
    }

    // Check if user is a vendor and get vendorId
    const vendor = await VendorModel.findOne({ user_id: userId });
    const vendorId = vendor?._id.toString();

    try {
      await provider.handleCallback(code, userId, vendorId);
    } catch (error) {
      if (redirectOAuthResult(res, { calendar: 'error', reason: 'connection_failed' })) return;
      throw error;
    }

    if (redirectOAuthResult(res, { calendar: 'connected' })) return;
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
    } catch (error: any) {
      next(createAppError(ERROR_CODES.INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER, 500, error.message));
    }
  })
);

export const googleRoutes = router;
