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
}
