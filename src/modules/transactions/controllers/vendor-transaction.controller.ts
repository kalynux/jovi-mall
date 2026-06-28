import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { PaginationQuerySchema } from '../../billing/validators/billing.validators';
import { vendorTransactionService } from '../services/vendor-transaction.service';

const TransactionQuerySchema = PaginationQuerySchema.extend({
  category: z.enum(['plan', 'credit', 'earning', 'payout']).optional(),
});

/**
 * Vendor transactions — one unified feed over plan purchases, credit top-ups,
 * credit usage and sales earnings. Mounted at `/api/vendor/transactions`.
 */
export class VendorTransactionController {
  static list = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { page, limit, category } = TransactionQuerySchema.parse(req.query);

    const { data, total } = await vendorTransactionService.list(vendorId, { page, limit, category });

    res.json({
      success: true,
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  });
}
