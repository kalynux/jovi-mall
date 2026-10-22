import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { listingProviderService } from '../domain/services/listing-provider.service';
import { listingSettingsService } from '../domain/services/listing-settings.service';
import {
  ListingIdParamSchema,
  ListingSettingsSchema,
  ListingWriteSchema,
  VendorListingListQuerySchema,
} from '../validators/listing.validator';

/**
 * The provider's listing surface — `/api/vendor/listings` and `/api/vendor/listing-settings`
 * (SERVICE-LISTINGS-PLAN § C-3 "Provider"). Every handler is scoped to the caller's own vendor
 * id at the query (`role_entity._id`); a listing id belonging to another vendor is a 404.
 */
const vendorIdOf = (req: Request): string => req.auth!.role_entity._id.toString();

export class VendorListingController {
  /** GET /api/vendor/listings?status&page&limit → page of VendorListingSummary */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = VendorListingListQuerySchema.parse(req.query);
    const page = await listingProviderService.list(vendorIdOf(req), query);
    res.json({ success: true, data: page.data, meta: page.meta });
  });

  /** POST /api/vendor/listings `{ content?, contacts? }` → VendorListingDetail (draft) */
  static create = asyncHandler(async (req: Request, res: Response) => {
    const body = ListingWriteSchema.parse(req.body ?? {});
    const listing = await listingProviderService.create(vendorIdOf(req), body);
    res.status(201).json({ success: true, data: listing });
  });

  /** GET /api/vendor/listings/:id → VendorListingDetail (own contacts included) */
  static get = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    res.json({ success: true, data: await listingProviderService.get(vendorIdOf(req), id) });
  });

  /** PATCH /api/vendor/listings/:id — edits the working copy; opens a revision on a live listing. */
  static update = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    const body = ListingWriteSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingProviderService.update(vendorIdOf(req), id, body) });
  });

  /** POST /api/vendor/listings/:id/submit — the indexing fee, pre-flags, oEmbed → review. */
  static submit = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    res.json({ success: true, data: await listingProviderService.submit(vendorIdOf(req), id) });
  });

  /** POST /api/vendor/listings/:id/withdraw — back to editing, fee refunded. */
  static withdraw = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    res.json({ success: true, data: await listingProviderService.withdraw(vendorIdOf(req), id) });
  });

  /** DELETE /api/vendor/listings/:id/revision — drop a live listing's working copy. */
  static discardRevision = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    res.json({ success: true, data: await listingProviderService.discardRevision(vendorIdOf(req), id) });
  });

  /** POST /api/vendor/listings/:id/archive */
  static archive = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    res.json({ success: true, data: await listingProviderService.archive(vendorIdOf(req), id) });
  });
}

export class VendorListingSettingsController {
  /** GET /api/vendor/listing-settings */
  static get = asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await listingSettingsService.get(vendorIdOf(req)) });
  });

  /** PUT /api/vendor/listing-settings `{ onEmpty, debtFloor, maxCreditsPerCustomerPerDay }` */
  static put = asyncHandler(async (req: Request, res: Response) => {
    const body = ListingSettingsSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingSettingsService.put(vendorIdOf(req), body) });
  });
}
