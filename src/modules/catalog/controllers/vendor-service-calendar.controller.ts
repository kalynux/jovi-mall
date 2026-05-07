import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
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
    static getCalendarStatus = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);

        if (product.type !== 'service')
            throw createAppError(ERROR_CODES.CATALOG_BOOKING_INVALID_PRODUCT_TYPE, 400, 'Calendar status is only available for service products');

        const ConnectedCalendarAccount = (await import('../../integrations/calendar/google/connected-account.model')).ConnectedCalendarAccount;
        const account = await ConnectedCalendarAccount.findOne({ vendorId, provider: 'google' });

        if (!account) {
            res.json({ success: true, data: { connected: false, provider: null, email: null, lastSyncAt: null, expiresAt: null, syncStatus: 'not_connected' } });
            return;
        }

        res.json({ success: true, data: { connected: true, provider: 'google', calendarEmail: account.email, lastSyncAt: account.updatedAt, expiresAt: account.expiresAt, syncStatus: 'connected' } });
    });
}
