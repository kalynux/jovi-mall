import { Router, Request, Response, NextFunction } from 'express';
import { DigitalEntitlementService } from '../services/digital-entitlement.service';
import { DownloadLinkService } from '../services/download-link.service';
import { DownloadExecutionService } from '../services/download-execution.service';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Customer Digital Delivery Routes
 * 
 * /api/digital/download-links - Generate download link
 * /api/digital/download/:token - Execute download (no auth - token is the auth)
 * /api/digital/my-products - List purchased digital products
 */
export function createCustomerDigitalRoutes(
  entitlementService: DigitalEntitlementService,
  downloadLinkService: DownloadLinkService,
  downloadExecutionService: DownloadExecutionService
): Router {
  const router = Router();

  /**
   * POST /api/digital/download-links
   * Generate a download link for an entitlement
   * 
   * Auth: Customer required
   * Body: { entitlementId: string }
   * Response: { url, expiresAt, downloadsRemaining }
   */
  router.post('/download-links', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // TODO: Extract customerId from auth middleware
      const customerId = (req as any).user?.customerId;
      if (!customerId) {
        return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
      }

      const { entitlementId } = req.body;

      if (!entitlementId) {
        return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'entitlementId is required'));
      }

      const result = await downloadLinkService.createDownloadLink({
        entitlementId,
        customerId,
      });

      return res.status(200).json(result);
    } catch (error: any) {
      console.error('Error creating download link:', error);
      next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
    }
  }));

  /**
   * GET /api/digital/download/:token
   * Execute download using a token
   * 
   * Auth: None (token is the authentication)
   * Response: File stream (binary)
   */
  router.get('/download/:token', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params;

      if (!token) {
        return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Token is required'));
      }

      // Stream file to response (service handles all validation)
      await downloadExecutionService.consumeToken(token, res);
    } catch (error: any) {
      console.error('Error executing download:', error);

      // Only send error if headers not sent yet
      if (!res.headersSent) {
        next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
      }
    }
  }));

  /**
   * GET /api/digital/my-products
   * List all digital products purchased by the customer
   * 
   * Auth: Customer required
   * Response: Array of entitlement summaries
   */
  router.get('/my-products', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // TODO: Extract customerId from auth middleware
      const customerId = (req as any).user?.customerId;
      if (!customerId) {
        return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
      }

      const entitlements = await entitlementService.getCustomerEntitlements(
        customerId
      );

      return res.status(200).json(entitlements);
    } catch (error: any) {
      console.error('Error fetching customer products:', error);
      next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Internal server error'));
    }
  }));

  return router;
}
