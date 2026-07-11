import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { earningsAccountService } from '../services/earnings-account.service';

/**
 * Agency-facing earnings view: held (pending) vs withdrawable (available)
 * balance for the agency's own delivery-fee escrow account. Mirrors
 * VendorEarningsController. Mounted at `/api/agency` → `/agency/earnings`.
 */
export class AgencyEarningsController {
  static getEarnings = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const balances = await earningsAccountService.getBalances('agency', agencyId);
    res.status(200).json({ success: true, data: balances });
  });
}
