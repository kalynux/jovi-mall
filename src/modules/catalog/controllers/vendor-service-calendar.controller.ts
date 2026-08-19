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
 * ⚠ **This is NOT a stub, and this header said it was until 2026-08-19.** It read
 * "STUB ONLY — Future Integration Point … returns stub data … real Google Calendar
 * integration is not yet implemented", and none of that has been true for some time: the
 * handler below reads the real `ConnectedCalendarAccount`, the OAuth token vault is live,
 * and `InboundCalendarSyncWorker` is registered in `lifecycle.ts`.
 *
 * The stale comment had reached outside this file. `PRODUCTION-READINESS/10-IMPLEMENTATION-
 * PLAN.md` step 2.D.3 cites this line as evidence that "the dependency may be paying for a
 * feature that does not exist yet" — a conclusion drawn from a comment rather than from the
 * code under it. That premise is withdrawn.
 *
 * TODO(calendar, 2026-08-19): what 2.D.3 still legitimately owns is the *dependency* question
 * — whether the Calendar feature justifies `googleapis`' transitive surface. That is a
 * product-and-supply-chain decision, it is recorded there, and it is not a gap in this
 * endpoint.
 */
export class VendorServiceCalendarController {
    /**
     * GET /api/vendor/products/:id/service/calendar-status
     *
     * Get calendar integration status for a service product.
     *
     * Reports the VENDOR's connection, not the product's: a Google account is connected once
     * per vendor and every service product they own reads the same one. The `productId` is
     * still required and still scoped — it is what proves the caller owns a service product
     * before their integration state is disclosed.
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
