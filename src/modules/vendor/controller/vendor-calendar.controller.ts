import { Request, Response } from 'express';
import { AppError } from '../../../core/errors';
import { ConnectedCalendarAccount } from '../../integrations/calendar/google/connected-account.model';
import { GoogleCalendarProvider } from '../../integrations/calendar/google/google.provider';

const googleProvider = new GoogleCalendarProvider();

/**
 * VendorCalendarController
 * 
 * Vendor-scoped calendar management endpoints.
 * Thin wrapper around existing GoogleCalendarProvider for consistency with vendor API structure.
 * 
 * CRITICAL: This does NOT duplicate OAuth logic - it delegates to existing infrastructure.
 */
export class VendorCalendarController {
    /**
     * GET /api/vendor/calendar/status
     * Get calendar connection status for the current vendor
     */
    static async getStatus(req: Request, res: Response): Promise<void> {
        try {
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
                    lastSyncAt: account.updatedAt,
                    expiresAt: account.expiresAt,
                },
            });
        } catch (error) {
            VendorCalendarController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/calendar/connect
     * Initiate OAuth flow for connecting Google Calendar
     * 
     * NOTE: This redirects to existing /integrations/google/connect
     * Kept for API consistency (all vendor operations under /vendor/*)
     */
    static async initiateConnect(req: Request, res: Response): Promise<void> {
        try {
            // Redirect to existing OAuth flow
            // The existing route handles state generation and vendor association
            res.redirect('/api/integrations/google/connect');
        } catch (error) {
            VendorCalendarController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/calendar/disconnect
     * Disconnect vendor's Google Calendar
     */
    static async disconnect(req: Request, res: Response): Promise<void> {
        try {
            const userId = req.auth!.user.id;

            if (!userId) {
                res.status(401).json({
                    success: false,
                    error: {
                        code: 'UNAUTHORIZED',
                        message: 'User ID not found in request',
                    },
                });
                return;
            }

            // Delegate to existing provider
            await googleProvider.disconnect(userId);

            res.json({
                success: true,
                message: 'Google Calendar disconnected successfully',
            });
        } catch (error) {
            VendorCalendarController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                success: false,
                error: {
                    code: error.code,
                    message: error.message,
                },
            });
            return;
        }

        console.error('[VendorCalendarController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
