import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess, sendPaginated } from '../../../core/responses';
import { earningsAccountService } from '../services/earnings-account.service';
import { orderMoneySplitService } from '../services/order-money-split.service';
import { earningsClawbackService } from '../services/earnings-clawback.service';
import { adminCallerActor } from '../../../api/middlewares/admin-caller.middleware';
import {
  ListClawbacksQuerySchema,
  WriteOffClawbackBodySchema,
  ListEarningsAccountsQuerySchema,
  LedgerQuerySchema,
  ListPausesQuerySchema,
  OrderIdParamsSchema,
  OwnerParamsSchema,
  PauseEarningsBodySchema,
  PauseTargetParamsSchema,
  ResumeEarningsBodySchema,
} from '../validators/admin-earnings.validator';
import { earningsPauseService, PauseActor } from '../services/earnings-pause.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { actorFromRequest } from '../../../core/types/actor-source.types';

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
    // A platform account is never paid out, so what it holds is what it made — less anything a
    // refund recovered beyond its balances (`clawback`, normally 0 for the platform).
    const held = (b: typeof commission): number => b.pending + b.available + b.reserve + b.requested - b.clawback;
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

  // ── Earnings pauses (owner, 2026-10-05) ──────────────────────────────────────
  // Paused money is never released. Some pauses are raised by the system (a seller cancelled
  // a paid order, a card dispute); an administrator lifts them, or places one by hand.

  /** GET /earnings/pauses — every order and booking whose money is paused now. */
  static listPauses = asyncHandler(async (req: Request, res: Response) => {
    const { kind, page, limit } = ListPausesQuerySchema.parse(req.query);
    const { items, total } = await earningsPauseService.listActive(kind, page, limit);
    sendPaginated(res, items, { total, page, limit, pages: Math.ceil(total / limit) });
  });

  /** GET /earnings/pauses/:kind/:id — the pause record of one order or booking (null if never paused). */
  static getPause = asyncHandler(async (req: Request, res: Response) => {
    const target = PauseTargetParamsSchema.parse(req.params);
    if (!(await earningsPauseService.targetExists(target))) {
      throw createAppError(ERROR_CODES.EARNINGS_PAUSE_TARGET_NOT_FOUND, 404);
    }
    sendSuccess(res, { ...target, pause: await earningsPauseService.currentPause(target) });
  });

  /**
   * POST /earnings/pauses/:kind/:id/pause — pause by hand, with a required note.
   * 409 when already paused: a second pause would overwrite who paused it and why.
   */
  static pause = asyncHandler(async (req: Request, res: Response) => {
    const target = PauseTargetParamsSchema.parse(req.params);
    const { note } = PauseEarningsBodySchema.parse(req.body ?? {});
    if (!(await earningsPauseService.targetExists(target))) {
      throw createAppError(ERROR_CODES.EARNINGS_PAUSE_TARGET_NOT_FOUND, 404);
    }
    const outcome = await earningsPauseService.pause(target, 'admin', pauseActorOf(req), note);
    if (!outcome.changed) throw createAppError(ERROR_CODES.EARNINGS_ALREADY_PAUSED, 409);
    sendSuccess(res, { ...target, pause: outcome.pause }, { message: 'Earnings paused' });
  });

  /**
   * POST /earnings/pauses/:kind/:id/resume — lift ANY pause, whoever raised it. The hold
   * continues where it stopped (the paused time does not count). 409 when not paused.
   * 409 `EARNINGS_PAUSE_HELD_BY_REFUND` while a refund request of the source is open, or a
   * completed one has not recovered its earnings yet (C-4): resuming then would release money
   * the refund is about to claw back. A stale `refund_in_progress` pause with no such request
   * (its resume failed after a rejection) stays liftable here — refusing it would strand it.
   */
  static resume = asyncHandler(async (req: Request, res: Response) => {
    const target = PauseTargetParamsSchema.parse(req.params);
    const { note } = ResumeEarningsBodySchema.parse(req.body ?? {});
    if (!(await earningsPauseService.targetExists(target))) {
      throw createAppError(ERROR_CODES.EARNINGS_PAUSE_TARGET_NOT_FOUND, 404);
    }
    // Lazy: `payments` imports `earnings`, so a static import back would close a require cycle.
    const { refundRequestService } = await import('../../payments/services/refund-request.service');
    const holding = await refundRequestService.findHoldingEarningsPause(target.kind, target.id);
    if (holding) {
      throw createAppError(ERROR_CODES.EARNINGS_PAUSE_HELD_BY_REFUND, 409, undefined, {
        refundRequestId: holding.id,
        refundRequestStatus: holding.status,
      });
    }
    const outcome = await earningsPauseService.resume(target, pauseActorOf(req), note ?? null);
    if (!outcome.changed) throw createAppError(ERROR_CODES.EARNINGS_NOT_PAUSED, 409);
    sendSuccess(res, { ...target, pause: outcome.pause }, { message: 'Earnings resumed' });
  });

  // ── Refund clawback debt (REFUND-FLOW-PLAN § 6.4, C-5, C-6) ──────────────────────────
  // A refund that recovered more than an owner's balances held leaves them OWING the platform
  // (`clawback_balance`); every later inflow pays it down first. These two are the queue of
  // such owners and the administrator's way to forgive it.

  /**
   * GET /earnings/clawbacks — owners with a debt, largest first. Each row carries the balances
   * beside it (available is 0 while a debt stands — netting is eager) and `heldPayout`, a payout
   * that was already waiting when the debt appeared (never cut, C-7).
   */
  static listClawbacks = asyncHandler(async (req: Request, res: Response) => {
    const { ownerType, page, limit } = ListClawbacksQuerySchema.parse(req.query);
    const { items, total } = await earningsClawbackService.listDebtors(ownerType ?? null, page, limit);
    sendPaginated(res, items, { total, page, limit, pages: Math.ceil(total / limit) });
  });

  /**
   * POST /earnings/clawbacks/:ownerType/:ownerId/write-off — forgive `amount` of the owner's
   * debt; the platform absorbs it. 409 `EARNINGS_CLAWBACK_NOTHING_OWED` /
   * `EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT`. The actor is the `x-actor-*` administrator.
   */
  static writeOffClawback = asyncHandler(async (req: Request, res: Response) => {
    const { ownerType, ownerId } = OwnerParamsSchema.parse(req.params);
    const { amount, reason } = WriteOffClawbackBodySchema.parse(req.body ?? {});
    const actor = adminCallerActor(req);
    const outcome = await earningsClawbackService.writeOff({
      ownerType,
      ownerId,
      amount,
      reason,
      actor: { id: actor?.id ?? null, name: actor?.name ?? null },
    });
    sendSuccess(res, outcome, { message: 'Clawback debt written off' });
  });
}

/** The administrator behind a wi-admin call, in the shape a pause records. */
function pauseActorOf(req: Request): PauseActor {
  const actor = actorFromRequest(req as any);
  return { userId: actor.userId || null, source: actor.source, name: actor.name ?? null };
}
