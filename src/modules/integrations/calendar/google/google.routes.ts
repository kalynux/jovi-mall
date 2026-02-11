import { Router, Request, Response, NextFunction } from 'express';
import { GoogleCalendarProvider } from './google.provider';
import { requireAuth } from '../../../../api/middlewares/auth.middleware';
import { requireSessionAuth } from '../../../../api/middlewares/session.middleware';
import { OAuthStateService } from '../../../auth/services/oauth-state.service';
import { ConnectedCalendarAccount } from './connected-account.model';
import { VendorModel } from '../../../vendors/vendor.model';

const router = Router();
const provider = new GoogleCalendarProvider();
const oauthStateService = new OAuthStateService();

// Helper to handle async errors
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * GET /integrations/google/connect
 * Redirects the user to Google's OAuth consent screen.
 * Requires browser session authentication (NOT Bearer token)
 */
router.get(
  '/connect',
  requireSessionAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const sessionId = req.sessionId!;

    // Generate OAuth state for CSRF protection
    const state = oauthStateService.generateState({ userId, sessionId });

    // Get Google auth URL with state
    const url = provider.getAuthUrl(state);
    res.redirect(url);
  })
);

/**
 * GET /integrations/google/callback
 * Handles the OAuth callback from Google.
 * Requires browser session authentication (NOT Bearer token)
 */
router.get(
  '/callback',
  requireSessionAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { code, state } = req.query;
    const userId = req.auth!.user._id.toString();

    console.log({ code, userId });

    if (!code || typeof code !== 'string') {
      console.log('Missing or invalid authorization code');
      return res.status(400).json({ error: 'Missing or invalid authorization code' });
    }

    if (!state || typeof state !== 'string') {
      console.log('Missing OAuth state');
      return res.status(400).json({ error: 'Missing OAuth state' });
    }

    // Validate OAuth state (CRITICAL CSRF protection)
    try {
      const { userId: stateUserId, sessionId: stateSessionId } = oauthStateService.verifyState(state);

      // Verify userId matches current session
      if (stateUserId !== userId) {
        console.log('User ID mismatch between state and session');
        return res.status(403).json({ error: 'Invalid OAuth state: user mismatch' });
      }

      // Verify sessionId matches current session
      if (stateSessionId !== req.sessionId) {
        console.log('Session ID mismatch');
        return res.status(403).json({ error: 'Invalid OAuth state: session mismatch' });
      }
    } catch (error: any) {
      console.log('State validation failed:', error.message);
      return res.status(403).json({ error: 'Invalid or expired OAuth state' });
    }

    // Check if user is a vendor and get vendorId
    const vendor = await VendorModel.findOne({ user_id: userId });
    const vendorId = vendor?._id.toString();

    await provider.handleCallback(code, userId, vendorId);

    console.log('Google Calendar connected successfully');

    // Redirect to a simple success page or JSON response
    // For now, returning JSON success
    res.json({ success: true, message: 'Google Calendar connected successfully' });
  })
);

/**
 * GET /integrations/google/status
 * Checks if the current user has a connected Google Calendar account.
 */
router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth?.user.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const account = await ConnectedCalendarAccount.findOne({ userId, provider: 'google' });

    if (account) {
      res.json({
        connected: true,
        email: account.email,
        expiresAt: account.expiresAt,
      });
    } else {
      res.json({ connected: false });
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
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth?.user.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

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
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth?.user.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const result = await provider.testConnection(userId);
      res.json({ success: result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  })
);

export const googleRoutes = router;
