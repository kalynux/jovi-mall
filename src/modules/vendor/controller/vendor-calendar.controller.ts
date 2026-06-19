import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ConnectedCalendarAccount } from '../../integrations/calendar/google/connected-account.model';
import { GoogleCalendarProvider } from '../../integrations/calendar/google/google.provider';

const googleProvider = new GoogleCalendarProvider();

/**
 * Human-readable summary of what each granted OAuth scope allows, so the
 * frontend can show the vendor exactly what access they approved.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
    'https://www.googleapis.com/auth/calendar': 'Read, create, and delete events on your Google Calendar',
    'https://www.googleapis.com/auth/userinfo.email': 'View your Google account email address',
    'https://www.googleapis.com/auth/userinfo.profile': 'View your basic Google profile info',
};

/** Split the stored space-separated scope string into a structured permission list. */
function describeScopes(scope: string | undefined): { scope: string; description: string }[] {
    if (!scope) return [];
    return scope
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] ?? s }));
}

/**
 * VendorCalendarController
 *
 * Vendor-scoped calendar management endpoints.
 * Thin wrapper around existing GoogleCalendarProvider for consistency with vendor API structure.
 *
 * CRITICAL: This does NOT duplicate OAuth logic - it delegates to existing infrastructure.
 * Errors are raised with createAppError and propagated to the global error handler
 * via asyncHandler — never written inline.
 */
export class VendorCalendarController {
    /**
     * GET /api/vendor/calendar/status
     * Get calendar connection status for the current vendor
     */
    static getStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();

        // Lookup calendar account by vendorId (optimized path)
        const account = await ConnectedCalendarAccount.findOne({
            vendorId,
            provider: 'google',
        });

        if (!account) {
            res.json({
                success: true,
                data: {
                    connected: false,
                    provider: null,
                    email: null,
                    calendarId: null,
                    permissions: [],
                    requiresReauth: false,
                    lastSyncAt: null,
                    expiresAt: null,
                },
            });
            return;
        }

        res.json({
            success: true,
            data: {
                connected: true,
                provider: 'google',
                email: account.email,
                calendarId: account.calendarId,
                permissions: describeScopes(account.scope),
                requiresReauth: account.requiresReauth ?? false,
                lastSyncAt: account.updatedAt,
                expiresAt: account.expiresAt,
            },
        });
    });

    /**
     * POST /api/vendor/calendar/connect
     * Initiate OAuth flow for connecting Google Calendar
     *
     * NOTE: This redirects to existing /integrations/google/connect
     * Kept for API consistency (all vendor operations under /vendor/*)
     */
    static initiateConnect = asyncHandler(async (_req: Request, res: Response): Promise<void> => {
        // Redirect to existing OAuth flow
        // The existing route handles state generation and vendor association
        res.redirect('/api/integrations/google/connect');
    });

    /**
     * POST /api/vendor/calendar/disconnect
     * Disconnect vendor's Google Calendar
     */
    static disconnect = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const userId = req.auth!.user.id;

        if (!userId) {
            throw createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User ID not found in request');
        }

        // Delegate to existing provider
        await googleProvider.disconnect(userId);

        res.json({
            success: true,
            message: 'Google Calendar disconnected successfully',
        });
    });
}
