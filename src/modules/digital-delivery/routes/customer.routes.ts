import { Router, Request, Response, NextFunction } from 'express';
import { DigitalEntitlementService } from '../services/digital-entitlement.service';
import { DownloadLinkService } from '../services/download-link.service';
import { DownloadExecutionService } from '../services/download-execution.service';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { sendSuccess } from '../../../core/responses';

/**
 * Customer Digital Delivery Routes — mounted at `/api/digital`.
 *
 *   POST /api/digital/download-links   — mint a single-use, 15-min download link (customer)
 *   GET  /api/digital/download/:token  — execute a download (PUBLIC: the token IS the auth)
 *   GET  /api/digital/my-products      — list the customer's purchased digital products
 *
 * The mount point is `/api/digital` because `DownloadLinkService` returns
 * `url: /api/digital/download/<token>` — the execute route must live there.
 *
 * The customer is resolved from `req.auth.role_entity._id` (the Customer entity id),
 * which is exactly what `CustomerDigitalEntitlement.customerId` stores: orders carry
 * `customer_id → Customer`, and `grantEntitlement` snapshots that id at grant time.
 *
 * Service methods throw domain `DIGITAL_*` AppErrors (via `createAppError`); they are
 * forwarded by `asyncHandler` to the global error handler untouched, so the frontend
 * receives the precise `error.code` (e.g. `DIGITAL_ENTITLEMENT_EXPIRED`) rather than a
 * masked 500.
 */
export function createCustomerDigitalRoutes(
  entitlementService: DigitalEntitlementService,
  downloadLinkService: DownloadLinkService,
  downloadExecutionService: DownloadExecutionService,
): Router {
  const router = Router();

  const customerOnly = [requireAuth, requireRole(['customer'])];

  /**
   * POST /api/digital/download-links
   * Generate a secure, single-use download link for one of the caller's entitlements.
   *
   * Auth: customer. Body: { entitlementId: string }
   * Response 201: { success, data: { url, expiresAt, downloadsRemaining } }
   */
  router.post(
    '/download-links',
    ...customerOnly,
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const customerId = req.auth!.role_entity._id.toString();

      const { entitlementId } = (req.body ?? {}) as { entitlementId?: unknown };
      if (!entitlementId || typeof entitlementId !== 'string') {
        return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'entitlementId is required'));
      }

      const result = await downloadLinkService.createDownloadLink({ entitlementId, customerId });
      sendSuccess(res, result, { status: 201 });
    }),
  );

  /**
   * GET /api/digital/download/:token
   * Execute a download. PUBLIC — the single-use token is the authentication.
   *
   * The service validates the token + entitlement and atomically increments the
   * download counter BEFORE writing any bytes, throwing a `DIGITAL_*` AppError on
   * failure (headers not yet sent, so the global handler renders JSON). Once the
   * stream starts, the service's own `stream.on('error')` handler guards `headersSent`.
   */
  router.get(
    '/download/:token',
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const { token } = req.params;
      if (!token) {
        return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Token is required'));
      }

      await downloadExecutionService.consumeToken(token, res);
    }),
  );

  /**
   * GET /api/digital/my-products
   * List all digital products the customer has purchased, each with entitlement
   * status (downloads used/remaining, expiry, revoked, canDownload).
   *
   * Auth: customer. Response 200: { success, data: EntitlementSummary[] }
   */
  router.get(
    '/my-products',
    ...customerOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const customerId = req.auth!.role_entity._id.toString();
      const entitlements = await entitlementService.getCustomerEntitlements(customerId);
      sendSuccess(res, entitlements);
    }),
  );

  return router;
}
