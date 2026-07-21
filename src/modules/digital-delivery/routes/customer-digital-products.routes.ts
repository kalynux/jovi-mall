// ─────────────────────────────────────────────────────────────────────────────
// DEPRECATED / UNMOUNTED — commented out on 2026-07-17, kept (not deleted) per request.
//
// This router is a REDUNDANT DUPLICATE of the canonical customer digital surface,
// which is now wired at `/api/digital` via `createCustomerDigitalRoutes`
// (see ./customer.routes.ts). It also had the same `req.user.customerId` auth bug.
// It is imported nowhere and mounted nowhere. If a future need arises, prefer
// extending ./customer.routes.ts rather than reviving this file.
// ─────────────────────────────────────────────────────────────────────────────

// Keep this a module (not a global script) while the implementation is commented out.
export {};

// import { Router, Request, Response, NextFunction } from 'express';
// import { DigitalEntitlementService } from '../../digital-delivery/services/digital-entitlement.service';
// import { DownloadLinkService } from '../../digital-delivery/services/download-link.service';
// import { asyncHandler } from '../../../api/middlewares/async-handler';
// import { createAppError } from '../../../core/errors';
// import { ERROR_CODES } from '../../../core/error-codes';
//
// /**
//  * Customer Digital Product Routes
//  *
//  * Allows customers to view their digital product library and generate download links.
//  */
//
// const router = Router();
// const entitlementService = new DigitalEntitlementService();
// const downloadLinkService = new DownloadLinkService();
//
// /**
//  * GET /api/customer/digital-products
//  * List customer's digital product library
//  *
//  * Returns all digital products the customer has purchased with entitlement status.
//  */
// router.get('/digital-products', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
//   try {
//     // TODO: Extract customerId from auth middleware
//     const customerId = (req as any).user?.customerId;
//     if (!customerId) {
//       return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
//     }
//
//     const entitlements = await entitlementService.getCustomerEntitlements(customerId);
//
//     return res.status(200).json({
//       products: entitlements,
//       total: entitlements.length,
//     });
//   } catch (error: any) {
//     console.error('Error fetching customer digital products:', error);
//     next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Internal server error'));
//   }
// }));
//
// /**
//  * POST /api/customer/digital-products/:id/download-link
//  * Generate a download link for a purchased digital product
//  *
//  * Param :id = entitlementId
//  * Returns: { url, expiresAt, downloadsRemaining }
//  */
// router.post('/digital-products/:id/download-link', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
//   try {
//     // TODO: Extract customerId from auth middleware
//     const customerId = (req as any).user?.customerId;
//     if (!customerId) {
//       return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
//     }
//
//     const { id: entitlementId } = req.params;
//
//     const result = await downloadLinkService.createDownloadLink({
//       entitlementId,
//       customerId,
//     });
//
//     return res.status(200).json(result);
//   } catch (error: any) {
//     console.error('Error creating download link:', error);
//     next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
//   }
// }));
//
// export default router;
