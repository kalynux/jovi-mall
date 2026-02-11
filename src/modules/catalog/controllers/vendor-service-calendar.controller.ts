import { Request, Response } from 'express';
import { AppError, NotFoundError } from '../../../core/errors';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';

const productRepository = new ProductRepositoryMongo();

/**
 * VendorServiceCalendarController
 * 
 * Service calendar integration status endpoint.
 * 
 * **STUB ONLY - Future Integration Point**
 * This endpoint currently returns stub data.
 * Real Google Calendar integration is not yet implemented.
 */
export class VendorServiceCalendarController {
    /**
     * GET /api/vendor/products/:id/service/calendar-status
     * 
     * Get calendar integration status for a service product
     * 
     * STUB: Returns placeholder data
     * TODO: Integrate with Google Calendar API
     */
    static async getCalendarStatus(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);

            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Validate it's a service product
            if (product.type !== 'service') {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_PRODUCT_TYPE',
                        message: 'Calendar status is only available for service products',
                    },
                });
                return;
            }

            // Lookup calendar account by vendorId
            const ConnectedCalendarAccount = (await import('../../integrations/calendar/google/connected-account.model')).ConnectedCalendarAccount;
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
                        syncStatus: 'not_connected',
                    },
                });
                return;
            }

            // Return real calendar data
            res.json({
                success: true,
                data: {
                    connected: true,
                    provider: 'google',
                    calendarEmail: account.email,
                    lastSyncAt: account.updatedAt,
                    expiresAt: account.expiresAt,
                    syncStatus: 'connected',
                },
            });
        } catch (error) {
            VendorServiceCalendarController.handleError(error, res);
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

        console.error('[VendorServiceCalendarController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
