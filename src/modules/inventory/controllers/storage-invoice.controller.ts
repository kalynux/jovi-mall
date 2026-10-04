import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
  agencyStorageInvoiceRepository,
} from '../repositories/agency-storage-invoice.repository';
import { agencyStorageInvoiceService } from '../services/agency-storage-invoice.service';
import { StorageInvoiceDto, toStorageInvoiceDto } from '../dto/storage-invoice.dto';
import { IAgencyStorageInvoice } from '../models/agency-storage-invoice.model';
import { getStorageProvider } from '../../../core/storage';
import { resolveVendorSummaries } from '../../vendors/read-models/vendor-summary.resolver';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId');

const InvoiceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['open', 'settled', 'void']).optional(),
  periodKey: z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM').optional(),
  vendorId: objectId.optional(),
}).strict();

const InvoiceIdParamSchema = z.object({ id: objectId });

const SettleSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

const VoidSchema = z.object({
  /**
   * Required, unlike settle's. Voiding says a statement was wrong, and the reason is the
   * only thing that will still explain the gap to whoever reads this next year.
   */
  reason: z.string().trim().min(3).max(500),
}).strict();

const selfId = (req: Request): string => req.auth!.role_entity._id.toString();

/**
 * Agency-side statements carry the vendor they are addressed to, so two statements for the
 * same month are told apart by name. One batched resolution per response, never per row.
 */
async function presentForAgency(
  invoices: IAgencyStorageInvoice[],
  options: { withLines: boolean },
): Promise<StorageInvoiceDto[]> {
  const vendors = await resolveVendorSummaries(
    invoices.map(invoice => invoice.vendor_id.toString()),
    getStorageProvider(),
  );
  return invoices.map(invoice => {
    const vendorId = invoice.vendor_id.toString();
    const summary = vendors.get(vendorId);
    return toStorageInvoiceDto(invoice, {
      ...options,
      vendor: {
        id: vendorId,
        businessName: summary?.businessName || null,
        displayName: summary?.displayName ?? null,
        verified: summary?.verified ?? false,
      },
    });
  });
}

/**
 * Storage statements, read by both sides of the arrangement (D-7).
 *
 * One controller, two mounts, and the difference between them is the SCOPE not the shape:
 * an agency sees the statements it issued, a vendor the ones issued to them. Both see the
 * same numbers, which is the point of writing them down.
 *
 * Only the agency may settle or void — it is their claim about their own rent. There is
 * deliberately no vendor "dispute" verb: the platform is not party to this money (D-7), so a
 * dispute it recorded would be a state nobody could resolve.
 */
export class StorageInvoiceController {
  /** GET /api/agency/storage-invoices */
  static listForAgency = asyncHandler(async (req: Request, res: Response) => {
    const query = InvoiceQuerySchema.parse(req.query);
    const { data, total } = await agencyStorageInvoiceRepository.paginate(
      { agencyId: selfId(req), status: query.status, periodKey: query.periodKey, vendorId: query.vendorId },
      query.page,
      query.limit,
    );
    res.json({
      success: true,
      data: await presentForAgency(data, { withLines: false }),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  /** GET /api/agency/storage-invoices/:id */
  static getForAgency = asyncHandler(async (req: Request, res: Response) => {
    const { id } = InvoiceIdParamSchema.parse(req.params);
    const invoice = await agencyStorageInvoiceRepository.findScoped(id, { agencyId: selfId(req) });
    if (!invoice) {
      throw createAppError(ERROR_CODES.STORAGE_INVOICE_NOT_FOUND, 404, undefined, { invoiceId: id });
    }
    const [dto] = await presentForAgency([invoice], { withLines: true });
    res.json({ success: true, data: dto });
  });

  /** POST /api/agency/storage-invoices/:id/settle */
  static settle = asyncHandler(async (req: Request, res: Response) => {
    const { id } = InvoiceIdParamSchema.parse(req.params);
    const { note } = SettleSchema.parse(req.body ?? {});
    const invoice = await agencyStorageInvoiceService.settle(
      selfId(req),
      id,
      req.auth?.user?.id ? String(req.auth.user.id) : null,
      note ?? null,
    );
    res.json({
      success: true,
      data: (await presentForAgency([invoice], { withLines: false }))[0],
      message: 'Statement marked settled.',
    });
  });

  /** POST /api/agency/storage-invoices/:id/void */
  static void = asyncHandler(async (req: Request, res: Response) => {
    const { id } = InvoiceIdParamSchema.parse(req.params);
    const { reason } = VoidSchema.parse(req.body ?? {});
    const invoice = await agencyStorageInvoiceService.void(selfId(req), id, reason);
    res.json({
      success: true,
      data: (await presentForAgency([invoice], { withLines: false }))[0],
      message: 'Statement voided.',
    });
  });

  /** GET /api/vendor/storage-invoices */
  static listForVendor = asyncHandler(async (req: Request, res: Response) => {
    const query = InvoiceQuerySchema.parse(req.query);
    const { data, total } = await agencyStorageInvoiceRepository.paginate(
      // `vendorId` from the query is ignored here — the vendor IS the scope, and honouring it
      // would let one vendor page another's statements by guessing an id.
      { vendorId: selfId(req), status: query.status, periodKey: query.periodKey },
      query.page,
      query.limit,
    );
    res.json({
      success: true,
      data: data.map(invoice => toStorageInvoiceDto(invoice, { withLines: false })),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  /** GET /api/vendor/storage-invoices/:id */
  static getForVendor = asyncHandler(async (req: Request, res: Response) => {
    const { id } = InvoiceIdParamSchema.parse(req.params);
    const invoice = await agencyStorageInvoiceRepository.findScoped(id, { vendorId: selfId(req) });
    if (!invoice) {
      throw createAppError(ERROR_CODES.STORAGE_INVOICE_NOT_FOUND, 404, undefined, { invoiceId: id });
    }
    res.json({ success: true, data: toStorageInvoiceDto(invoice, { withLines: true }) });
  });
}
