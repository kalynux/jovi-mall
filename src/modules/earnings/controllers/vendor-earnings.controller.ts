import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { earningsAccountService } from '../services/earnings-account.service';

/**
 * Vendor-facing earnings views: held (pending) vs withdrawable (available)
 * balances, and the underlying ledger. Mounted at `/api/vendor` →
 * `/vendor/earnings`, `/vendor/earnings/ledger`.
 */
export class VendorEarningsController {
  static getEarnings = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const balances = await earningsAccountService.getBalances('vendor', vendorId);
    res.status(200).json({ success: true, data: balances });
  });

  static getLedger = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));
    const ledger = await earningsAccountService.getLedger('vendor', vendorId, page, limit);
    res.status(200).json({ success: true, ...ledger });
  });
}
