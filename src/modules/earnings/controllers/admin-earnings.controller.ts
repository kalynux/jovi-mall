import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess, sendPaginated } from '../../../core/responses';
import { earningsAccountService } from '../services/earnings-account.service';

/**
 * Admin-facing view of the singleton platform earnings account — accumulated
 * marketplace commission (held vs available) and its ledger. Mounted at
 * `/api/admin` → `/admin/earnings/platform`.
 */
export class AdminEarningsController {
  static getPlatformEarnings = asyncHandler(async (_req: Request, res: Response) => {
    const balances = await earningsAccountService.getBalances('platform', null);
    sendSuccess(res, balances);
  });

  static getPlatformLedger = asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? '20', 10) || 20));
    const ledger = await earningsAccountService.getLedger('platform', null, page, limit);
    sendPaginated(res, ledger.items, {
      total: ledger.total,
      page: ledger.page,
      limit: ledger.limit,
      pages: Math.ceil(ledger.total / ledger.limit),
    });
  });
}
