import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { PaginationQuerySchema } from '../../billing/validators/billing.validators';
import { vendorTransactionService } from '../services/vendor-transaction.service';
import { BillingOwnerType } from '../../billing/billing.types';

const TransactionQuerySchema = PaginationQuerySchema.extend({
  category: z.enum(['plan', 'credit', 'earning', 'payout']).optional(),
});

/**
 * Owner transactions — one unified feed over plan purchases, credit top-ups,
 * credit usage and earnings. The same engine serves vendor/agency/agent; each
 * mounted controller fixes its `ownerType`.
 */
export function createTransactionController(ownerType: BillingOwnerType) {
  return {
    list: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const { page, limit, category } = TransactionQuerySchema.parse(req.query);

      const { data, total } = await vendorTransactionService.list(ownerType, ownerId, { page, limit, category });

      res.json({
        success: true,
        data,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    }),
  };
}

/** Vendor transactions feed. Mounted at `/api/vendor/transactions`. */
export const VendorTransactionController = createTransactionController('vendor');

/** Agency transactions feed. Mounted at `/api/agency/transactions`. */
export const AgencyTransactionController = createTransactionController('agency');

/** Agent transactions feed. Mounted at `/api/agent/transactions`. */
export const AgentTransactionController = createTransactionController('agent');
