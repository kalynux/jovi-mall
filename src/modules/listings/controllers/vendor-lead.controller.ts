import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { listingLeadService } from '../domain/services/listing-lead.service';
import {
  LeadIdParamSchema,
  LeadMessageBodySchema,
  LeadReportBodySchema,
  VendorLeadListQuerySchema,
} from '../validators/listing.validator';

/**
 * A provider's leads — `/api/vendor/leads` (SERVICE-LISTINGS-PLAN § C-3 "Provider"). Every
 * handler is scoped to the caller's own vendor id; another provider's lead is a 404.
 */
const vendorIdOf = (req: Request): string => req.auth!.role_entity._id.toString();

export class VendorLeadController {
  /** GET /api/vendor/leads?listingId&page&limit → page of VendorLeadRow (masked, newest first) */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = VendorLeadListQuerySchema.parse(req.query);
    const page = await listingLeadService.list(vendorIdOf(req), query);
    res.json({ success: true, data: page.data, meta: page.meta });
  });

  /** POST /api/vendor/leads/:leadId/call-me → `{ message }` (2 credits; refunded if it cannot go) */
  static callMe = asyncHandler(async (req: Request, res: Response) => {
    const { leadId } = LeadIdParamSchema.parse(req.params);
    res.json({ success: true, data: await listingLeadService.callMe(vendorIdOf(req), leadId) });
  });

  /** POST /api/vendor/leads/:leadId/message `{ body }` → `{ message }` */
  static message = asyncHandler(async (req: Request, res: Response) => {
    const { leadId } = LeadIdParamSchema.parse(req.params);
    const { body } = LeadMessageBodySchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingLeadService.message(vendorIdOf(req), leadId, body) });
  });

  /** POST /api/vendor/leads/:leadId/report `{ wants, revealIds, reason }` → `{ ticketId, ticketNumber }` */
  static report = asyncHandler(async (req: Request, res: Response) => {
    const { leadId } = LeadIdParamSchema.parse(req.params);
    const body = LeadReportBodySchema.parse(req.body ?? {});
    const ticket = await listingLeadService.report(vendorIdOf(req), req.auth!.user.id.toString(), leadId, body);
    res.status(201).json({ success: true, data: ticket });
  });
}
