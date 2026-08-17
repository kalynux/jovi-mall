import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { actorFromRequest } from '../../core/types/actor-source.types';
import { AdminVendorService, toAdminVendorDto } from './admin-vendor.service';
import {
  AdminApproveVendorKycSchema,
  AdminRejectVendorKycSchema,
  AdminSuspendVendorProductSchema,
  AdminSuspendVendorSchema,
  AdminUpdateVendorSettingsSchema,
} from './admin-vendor.validator';

/**
 * Vendor administration, for the wi-admin backend.
 *
 * Reads are almost entirely absent: wi-admin queries `vendors`, `stores` and `products`
 * directly, because a read protects no invariant and routing it through here would put an
 * HTTP hop in front of a `find()`. Mostly what lives here are the writes — the operations
 * whose meaning is bound up with this service's own transactions and cascades.
 *
 * **`getProduct` is the one exception, and it is argued rather than assumed.** Projecting
 * a listing needs two things this service owns and the other must not copy: the storage
 * provider that turns a `fileId` into a URL, and the storage-fee calculator. See
 * `read-models/admin-product-detail.resolver.ts`.
 */

const adminVendorService = new AdminVendorService();

export class AdminVendorController {
  /**
   * POST /vendors/:vendorId/suspend — body `{ reason }`.
   *
   * Answers the vendor plus what the cascade did. The counts are not decoration: they
   * become wi-admin's audit `after`, which is what makes "this suspension took 47
   * listings off sale" a fact in the trail rather than something to reconstruct later.
   */
  static suspend = asyncHandler(async (req: Request, res: Response) => {
    const input = AdminSuspendVendorSchema.parse(req.body);
    const result = await adminVendorService.suspend(
      req.params.vendorId,
      input.reason,
      // The administrator's id comes from `X-Actor-Id` and belongs to the wi-admin
      // database, so the stamp records `source: 'admin'` and snapshots the name — a
      // cross-database join to resolve it does not exist and never will.
      actorFromRequest(req)
    );

    sendSuccess(
      res,
      {
        ...toAdminVendorDto(result.vendor),
        suspendedProductIds: result.suspendedProductIds,
        suspendedProductCount: result.suspendedProductIds.length,
      },
      { message: 'Vendor suspended and their listings taken off sale' }
    );
  });

  /**
   * POST /vendors/:vendorId/restore — lift a suspension.
   *
   * `restoredProductCount` is routinely SMALLER than the count `suspend` reported: a
   * listing that no longer passes the activation gate stays suspended. That is correct
   * rather than a partial failure, and reporting both numbers is what lets an operator
   * see it rather than wonder.
   */
  static restore = asyncHandler(async (req: Request, res: Response) => {
    const result = await adminVendorService.restore(req.params.vendorId);

    sendSuccess(
      res,
      {
        ...toAdminVendorDto(result.vendor),
        restoredProducts: result.restoredProducts,
        restoredProductCount: result.restoredProducts.length,
      },
      { message: 'Vendor restored' }
    );
  });

  /** POST /vendors/:vendorId/kyc/approve — body `{ note? }`. */
  static approveKyc = asyncHandler(async (req: Request, res: Response) => {
    AdminApproveVendorKycSchema.parse(req.body ?? {});
    const vendor = await adminVendorService.approveKyc(req.params.vendorId, actorFromRequest(req));

    sendSuccess(res, toAdminVendorDto(vendor), { message: 'Vendor verification approved' });
  });

  /** POST /vendors/:vendorId/kyc/reject — body `{ reason }`. */
  static rejectKyc = asyncHandler(async (req: Request, res: Response) => {
    const input = AdminRejectVendorKycSchema.parse(req.body);
    const vendor = await adminVendorService.rejectKyc(
      req.params.vendorId,
      input.reason,
      actorFromRequest(req)
    );

    sendSuccess(res, toAdminVendorDto(vendor), { message: 'Vendor verification rejected' });
  });

  /**
   * GET /vendors/:vendorId/products/:productId — one listing, in full.
   *
   * Image URLs, price, counted stock, the responsible agency by name, and what its
   * storage rate comes to for this listing. 404 covers both "no such vendor" and "not
   * this vendor's product".
   */
  static getProduct = asyncHandler(async (req: Request, res: Response) => {
    const product = await adminVendorService.getProductDetail(
      req.params.vendorId,
      req.params.productId
    );

    sendSuccess(res, product);
  });

  /** POST /vendors/:vendorId/products/:productId/suspend — body `{ note }`. */
  static suspendProduct = asyncHandler(async (req: Request, res: Response) => {
    const input = AdminSuspendVendorProductSchema.parse(req.body);
    const result = await adminVendorService.suspendProduct(
      req.params.vendorId,
      req.params.productId,
      input.note
    );

    sendSuccess(res, result, { message: 'Product taken off sale' });
  });

  /** POST /vendors/:vendorId/products/:productId/restore. */
  static restoreProduct = asyncHandler(async (req: Request, res: Response) => {
    const result = await adminVendorService.restoreProduct(
      req.params.vendorId,
      req.params.productId
    );

    sendSuccess(res, result, { message: 'Product put back on sale' });
  });

  /** PATCH /vendors/:vendorId/settings — the platform-governed fields only. */
  static updateSettings = asyncHandler(async (req: Request, res: Response) => {
    const input = AdminUpdateVendorSettingsSchema.parse(req.body);
    const settings = await adminVendorService.updateSettings(req.params.vendorId, input);

    sendSuccess(res, settings, { message: 'Vendor settings updated' });
  });
}
