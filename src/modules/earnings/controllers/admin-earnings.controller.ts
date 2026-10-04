import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess, sendPaginated } from '../../../core/responses';
import { earningsAccountService } from '../services/earnings-account.service';
import { orderMoneySplitService } from '../services/order-money-split.service';
import {
  ListEarningsAccountsQuerySchema,
  LedgerQuerySchema,
  OrderIdParamsSchema,
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
  /**
   * What the marketplace has earned — BOTH platform accounts.
   *
   * ⚠ It used to return the `platform` account alone, i.e. **commission only**, and that
   * was every administrative answer to "how much have we made": the bargain fee lives in a
   * SECOND singleton, `platform_ai`, kept apart on purpose so "what did the bargaining agent
   * bring in" stays answerable (see `earnings-account.model.ts`). Keeping it apart in storage
   * is right; leaving it out of the total was not (owner, 2026-10-04).
   *
   * The top-level fields are still the commission account, unchanged, so a client reading
   * them keeps working; `accounts` names both and `total` adds them. `earned` is all four
   * sub-balances: a platform account is never paid out, so what it holds is what it made,
   * net of anything a refund reversed. `total` is `null` if the two accounts ever disagree
   * on currency — adding XAF to EUR is not a total.
   */
  static getPlatformEarnings = asyncHandler(async (_req: Request, res: Response) => {
    const [commission, bargainFee] = await Promise.all([
      earningsAccountService.getBalances('platform', null),
      earningsAccountService.getBalances('platform_ai', null),
    ]);
    const held = (b: typeof commission): number => b.pending + b.available + b.reserve + b.requested;
    const total =
      commission.currency === bargainFee.currency
        ? {
            pending: commission.pending + bargainFee.pending,
            available: commission.available + bargainFee.available,
            earned: held(commission) + held(bargainFee),
            currency: commission.currency,
          }
        : null;
    sendSuccess(res, { ...commission, accounts: { commission, bargainFee }, total });
  });

  /**
   * Who gets what from one order, on what basis — allocated where the split has run,
   * projected (from the split's own arithmetic) where it has not. See
   * `domain/order-money-split.ts`. Read-only; 404 `ORDER_NOT_FOUND`.
   */
  static getOrderMoneySplit = asyncHandler(async (req: Request, res: Response) => {
    const { orderId } = OrderIdParamsSchema.parse(req.params);
    sendSuccess(res, await orderMoneySplitService.getForOrder(orderId));
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
   *
   * `meta.totals` is an ARRAY, one entry per currency present in the filtered set. A
   * single object would force a currency choice the data does not support, and a
   * caller that saw one would reasonably assume every row shared it. It respects the
   * active `ownerType`, so it can never disagree with the table it sits under.
   *
   * `sendSuccess` rather than `sendPaginated`: `PaginationMeta`'s index signature is
   * scalar-only, and `totals` is a list of objects.
   */
  static listAccounts = asyncHandler(async (req: Request, res: Response) => {
    const { ownerType, page, limit } = ListEarningsAccountsQuerySchema.parse(req.query);
    const { data, total, totals } = await earningsAccountService.listAccountsForAdmin(
      ownerType ?? null,
      page,
      limit
    );
    sendSuccess(res, data, {
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        totals,
      },
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
