import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { listingRevealService } from '../domain/services/listing-reveal.service';
import { providerConsentService } from '../domain/services/listing-consent.service';
import {
  ConsentBodySchema,
  ListingIdOnlyParamSchema,
  RevealBodySchema,
  VendorIdParamSchema,
} from '../validators/listing.validator';

/**
 * The customer side of service listings — `/api/me/listings/:listingId/reveal` and
 * `/api/me/listing-consents` (SERVICE-LISTINGS-PLAN § C-3 "Customer").
 *
 * A customer SESSION only (`requireRole(['customer'])` on both routers): a vendor or agency
 * session on the same account does not unlock a provider's contacts. Everything is keyed by the
 * customer profile (`role_entity._id`); the user id is passed only so the reveal can recognise a
 * provider looking at their own listing (free, no lead — § C-8a).
 */
const customerIdOf = (req: Request): string => req.auth!.role_entity._id.toString();
const userIdOf = (req: Request): string => req.auth!.user.id.toString();

export class CustomerListingController {
  /**
   * POST /api/me/listings/:listingId/reveal `{ field }` → `RevealResult` (+ `askConsent`).
   *
   * `askConsent` is true exactly once per (customer, provider): on the first reveal from that
   * provider, and only while the customer has never answered. The website shows the opt-in
   * question then (L-14); answering is `PUT /api/me/listing-consents/:vendorId`.
   */
  static reveal = asyncHandler(async (req: Request, res: Response) => {
    const { listingId } = ListingIdOnlyParamSchema.parse(req.params);
    const { field } = RevealBodySchema.parse(req.body ?? {});
    const customerId = customerIdOf(req);
    const outcome = await listingRevealService.reveal({
      customerId,
      userId: userIdOf(req),
      listingId,
      field,
      channel: 'web',
    });
    const askConsent = outcome.openedLead ? await providerConsentService.askOnce(customerId, outcome.vendorId) : false;
    res.json({
      success: true,
      data: { ...outcome.result, askConsent, consentVendorId: askConsent ? outcome.vendorId : null },
    });
  });

  /** GET /api/me/listing-consents — every provider this customer answered or was asked about. */
  static listConsents = asyncHandler(async (req: Request, res: Response) => {
    res.json({ success: true, data: await providerConsentService.list(customerIdOf(req)) });
  });

  /** PUT /api/me/listing-consents/:vendorId `{ granted }` — grant, or refuse / withdraw. */
  static setConsent = asyncHandler(async (req: Request, res: Response) => {
    const { vendorId } = VendorIdParamSchema.parse(req.params);
    const { granted } = ConsentBodySchema.parse(req.body ?? {});
    res.json({ success: true, data: await providerConsentService.set(customerIdOf(req), vendorId, granted, 'web') });
  });
}
