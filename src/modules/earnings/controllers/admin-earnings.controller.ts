import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess, sendPaginated } from '../../../core/responses';
import { earningsAccountService } from '../services/earnings-account.service';
import {
  ListEarningsAccountsQuerySchema,
  LedgerQuerySchema,
  OwnerParamsSchema,
} from '../validators/admin-earnings.validator';

/**
 * Admin-facing view of the earnings ledger.
 *
 * Two audiences, one controller. The platform pair answers "what did the marketplace
 * earn"; the owner pair answers "what do we owe this vendor / agency / agent", and is
 * what wi-admin's account surface is built on.
 *
 * ── Why the balances are served rather than read ──────────────────────────────
 * wi-admin reads `earnings_ledgers` straight out of the shared database — append-only
 * rows are records. A balance is not: it is four sub-balances that only this service's
 * transactions move, and reproducing that arithmetic in a second process would be a
 * second opinion about how much money exists. So the derivation stays behind these
 * endpoints. ADR-009 D-1, applied to money.
 */
export class AdminEarningsController {
  static getPlatformEarnings = asyncHandler(async (_req: Request, res: Response) => {
    const balances = await earningsAccountService.getBalances('platform', null);
    sendSuccess(res, balances);
  });

  static getPlatformLedger = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = LedgerQuerySchema.parse(req.query);
    const ledger = await earningsAccountService.getLedger('platform', null, page, limit);
    sendPaginated(res, ledger.items, {
      total: ledger.total,
      page: ledger.page,
      limit: ledger.limit,
      pages: Math.ceil(ledger.total / ledger.limit),
    });
  });

  /**
   * Every owner's balances, ranked by what is withdrawable.
   *
   * Net-new: `EarningsAccountRepository` could find ONE account or every account over
   * the auto-payout threshold, and nothing in between — so "who are we holding money
   * for" had no answer at any scale between one and all.
   */
  static listAccounts = asyncHandler(async (req: Request, res: Response) => {
    const { ownerType, page, limit } = ListEarningsAccountsQuerySchema.parse(req.query);
    const { data, total } = await earningsAccountService.listAccountsForAdmin(
      ownerType ?? null,
      page,
      limit
    );
    sendPaginated(res, data, {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  });

  /**
   * One owner's four balances.
   *
   * Deliberately returns zeroes rather than 404ing for an owner with no account row:
   * `getBalances` does not create one, and an owner who has never been allocated
   * anything genuinely holds nothing. A 404 here would make "no earnings yet"
   * indistinguishable from "no such vendor", and the caller already knows the owner
   * exists — it looked them up to get here.
   */
  static getOwnerBalances = asyncHandler(async (req: Request, res: Response) => {
    const { ownerType, ownerId } = OwnerParamsSchema.parse(req.params);
    const balances = await earningsAccountService.getBalances(ownerType, ownerId);
    sendSuccess(res, { ownerType, ownerId, ...balances });
  });
}
