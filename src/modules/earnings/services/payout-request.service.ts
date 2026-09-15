import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { EarningsOwnerType } from '../models/earnings-account.model';
import { IPayoutRequest, PayoutRequestOrigin } from '../models/payout-request.model';
import {
  PayoutRequestRepository,
  ListPayoutRequestsFilters,
  PaginationOptions,
} from '../repositories/payout-request.repository';
import { EarningsAccountService, earningsAccountService } from './earnings-account.service';
import { IPayoutMethod } from '../../../core/types/payout.types';
import { ActorRef } from '../../../core/types/actor-source.types';
import { mintMerchantRef } from '../../payments/domain/merchant-reference';
import { getPaymentGateway, gatewaySupportsPayout } from '../../payments/gateways/registry';
import {
  OwnerVerification,
  UNKNOWN_VERIFICATION,
  verificationOf,
} from '../../../core/accounts/verification';
import { EARNINGS_CONFIG } from '../config/earnings.config';
import {
  computeAllowance,
  PayoutAllowance,
  UNCAPPED,
  windowStart,
} from '../domain/payout-allowance';

/** The allowance as an error-`details` payload / API shape. Dates as ISO, never `Date`. */
export function describeAllowance(allowance: PayoutAllowance) {
  return {
    cap: allowance.cap,
    used: allowance.used,
    remaining: allowance.remaining,
    windowDays: allowance.windowDays,
    resetsAt: allowance.resetsAt ? allowance.resetsAt.toISOString() : null,
  };
}
import { AdminPayoutRequestDto, toAdminPayoutRequestDto } from '../dto/admin-payout-request.dto';
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { AgentRepository } from '../../agents/repositories/agent.repository';
import { VendorModel } from '../../vendors/vendor.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { StoreModel } from '../../store/models/store.model';
import { AgencyMagazinModel } from '../../magazin/models/magazin.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';
import { ticketService } from '../../tickets/services/ticket.service';
import { TicketNoteService } from '../../tickets/services/ticket-note.service';
import { ActorRole, EntityType, TicketImportance, TicketStatus, TicketType } from '../../tickets/types/ticket.types';

/**
 * PayoutRequestService - orchestrates a vendor/agency's request to withdraw
 * their entire `available_balance`, wiring together the earnings ledger (funds
 * move into `requested_balance`, see EarningsAccountService), the ticketing
 * module (one PAYOUT_REQUEST ticket per request, admin-pool assigned), and
 * notifications (fired via `payout.*` events, see the vendor/agency
 * notification handlers).
 *
 * Money-moving and payout-record creation happen in ONE transaction. Ticket
 * creation cannot join that transaction (TicketService has no session
 * support), so a ticket-creation failure is compensated by a second
 * transaction that reverts the funds and drops the orphaned request — a
 * requester never ends up with money stuck in `requested_balance` and no
 * ticket to track it.
 */
/**
 * Does an allowance apply to this payout at all?
 *
 * Pure and exported, because there are **two exemptions and an off switch** — three separate
 * ways to return "no ceiling", all of them correct, none of them visible in behaviour. An
 * uncapped payout looks exactly like a capped one that came in under the limit, so the only
 * way to know which branch ran is to test it.
 */
export function allowanceApplies(input: {
  verified: boolean;
  origin: PayoutRequestOrigin;
  cap: number;
}): boolean {
  // Exemption 1 — the platform's own sweep. Capping it would leave the platform owing MORE to
  // precisely the least-vetted accounts, which is the opposite of why the sweep exists, and
  // the nightly run would fail against them for ever with nothing opened to track it.
  if (input.origin === 'auto_threshold') return false;
  // Exemption 2 — a vetted owner is not capped at all.
  if (input.verified) return false;
  // `0` (and any negative from a mistyped env) means the feature is off.
  return input.cap > 0;
}

/**
 * The gateway payouts are sent through.
 *
 * A constant rather than an environment variable, because there is exactly one wired
 * disbursement integration and a variable would invite a deployment to name a gateway that
 * cannot send — which `gatewaySupportsPayout` would then refuse at the worst moment, with an
 * error about capability rather than about configuration. When a second provider is wired,
 * this becomes a real choice and deserves a real setting.
 */
const PAYOUT_GATEWAY = 'NOTCHPAY';

export class PayoutRequestService {
  constructor(
    private readonly payoutRepo: PayoutRequestRepository = new PayoutRequestRepository(),
    private readonly accounts: EarningsAccountService = earningsAccountService,
    private readonly vendorRepo: VendorRepository = new VendorRepository(),
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly agentRepo: AgentRepository = new AgentRepository(),
    private readonly ticketNotes: TicketNoteService = new TicketNoteService()
  ) {}

  async requestPayout(
    ownerType: EarningsOwnerType,
    ownerId: string,
    requestedByUserId: string,
    requestedByRole: ActorRole,
    origin: PayoutRequestOrigin = 'manual'
  ): Promise<IPayoutRequest> {
    const held = await this.payoutRepo.findHeldForOwner(ownerType, ownerId);
    if (held) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_ALREADY_PENDING,
        409,
        `A payout request is already open (${held.status}) — wait for it to be resolved before requesting another`
      );
    }

    const payoutMethod = await this.resolvePreferredPayoutMethod(ownerType, ownerId);
    if (!payoutMethod) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_METHOD_MISSING,
        409,
        'Add a payout method to your profile before requesting a payout'
      );
    }

    /**
     * Resolved BEFORE the transaction, and used twice — to cap the move, and to tell the
     * reviewing administrator where this owner's review stands. One read, one answer: taking
     * it again after the money moved would let the two disagree if an approval landed in
     * between, and the ticket would then explain a cap that was no longer being applied.
     */
    const verification = await this.resolveVerification(ownerType, ownerId);
    const allowance = await this.allowanceFor(ownerType, ownerId, verification, origin);

    /**
     * ⚠ **Refused HERE rather than by handing the ledger a ceiling of zero**, because the two
     * exhausted cases need different sentences and the owner can act on only one of them.
     *
     *   - allowance spent — wait for `resetsAt`, or get verified. Nothing else helps.
     *   - allowance left, but under the platform floor — the money is genuinely there and
     *     genuinely unreachable this window. Reporting that as a bare "below minimum" would
     *     have them waiting for a balance they already have.
     *
     * Both name the cap, the window and the reset, because "your payout is smaller than your
     * balance" is otherwise indistinguishable from a bug.
     */
    if (allowance.capped) {
      if (allowance.remaining <= 0) {
        throw createAppError(
          ERROR_CODES.EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED,
          409,
          `Unverified accounts may withdraw up to ${allowance.cap} per ${allowance.windowDays} days. Verify this account to lift the limit.`,
          { ...describeAllowance(allowance), reason: 'allowance_spent' }
        );
      }
      if (allowance.remaining < EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT) {
        throw createAppError(
          ERROR_CODES.EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED,
          409,
          `Only ${allowance.remaining} of the ${allowance.cap} allowance for unverified accounts is left this ${allowance.windowDays}-day window, which is below the ${EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT} minimum payout. Verify this account to lift the limit.`,
          {
            ...describeAllowance(allowance),
            minAmount: EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT,
            reason: 'remainder_below_minimum',
          }
        );
      }
    }

    const ceiling = allowance.capped ? allowance.remaining : null;

    let payoutRequest: IPayoutRequest;
    try {
      payoutRequest = await transactionManager.runInTransaction(async (session) => {
        const { amount, currency } = await this.accounts.moveAvailableToRequestedInSession(
          ownerType,
          ownerId,
          session,
          ceiling
        );
        return this.payoutRepo.create(
          {
            owner_type: ownerType,
            owner_id: ownerId,
            amount,
            currency,
            origin,
            payout_method_snapshot: payoutMethod,
            requested_by_user_id: requestedByUserId,
          },
          session
        );
      });
    } catch (error: any) {
      // Duplicate-key on the partial unique index — a concurrent request won
      // the race between our pre-check and the transaction.
      if (error?.code === 11000) {
        throw createAppError(
          ERROR_CODES.EARNINGS_PAYOUT_ALREADY_PENDING,
          409,
          'A payout request is already open for this account — wait for it to be resolved before requesting another'
        );
      }
      throw error;
    }

    try {
      const ownerLabel =
        ownerType === 'vendor' ? 'Vendor' : ownerType === 'agent' ? 'Agent' : 'Agency';
      /**
       * ⚠ **The reviewer is told, in the ticket body, whether anybody has vetted this owner.**
       *
       * Since 2026-09-15 an `active` account proves only that its holder controls a phone
       * number — accounts activate themselves. The payout queue is the platform's one human
       * checkpoint on money leaving it, and a reviewer reading "Vendor — payout request" with
       * a plausible destination has, without this line, nothing on the screen distinguishing
       * a vetted business from a stranger who registered this morning.
       *
       * It is stated, never enforced: whether to pay an unvetted owner is the reviewer's
       * call. The line exists so the call is an informed one.
       */
      const verificationLine = verification.verified
        ? '\n\nKYC: verified.'
        : `\n\n⚠ KYC: NOT verified (${verification.verdict}). Check this owner's history before releasing funds.`
          + (ceiling !== null
            ? ` This payout was CAPPED at ${payoutRequest.currency} ${ceiling.toLocaleString()} because the account is unverified; the remainder stays in their available balance.`
            : '');

      const description =
        (origin === 'auto_threshold'
          ? `Balance reached the platform's automatic payout threshold. A payout of ${payoutRequest.currency} ${payoutRequest.amount.toLocaleString()} was requested automatically, via ${this.describePayoutMethod(payoutMethod)}.`
          : `Requesting a payout of ${payoutRequest.currency} ${payoutRequest.amount.toLocaleString()} via ${this.describePayoutMethod(payoutMethod)}.`)
        + verificationLine;

      const ticket = await ticketService.createTicket({
        subject:
          origin === 'auto_threshold'
            ? `Payout auto-requested (balance threshold) — ${ownerLabel}`
            : `Payout request — ${ownerLabel}`,
        description,
        type: TicketType.PAYOUT_REQUEST,
        importance: TicketImportance.HIGH,
        entityType: EntityType.OTHER,
        entityId: ownerId,
        createdByUserId: requestedByUserId,
        createdByRole: requestedByRole,
        createdByEntityId: ownerId,
      });
      await ticketService.assignTicket(ticket.id, ActorRole.ADMIN, null, requestedByUserId, requestedByRole);
      await this.payoutRepo.setTicketId(payoutRequest.id, ticket.id);
      payoutRequest.ticket_id = ticket._id as any;

      await eventBus.publish('payout.requested', {
        eventType: 'payout.requested',
        aggregateId: payoutRequest.id,
        payload: {
          ownerType,
          ownerId,
          amount: payoutRequest.amount,
          currency: payoutRequest.currency,
          payoutRequestId: payoutRequest.id,
          ticketId: ticket.id,
        },
        occurredAt: new Date(),
      });
    } catch (error) {
      // Ticket creation failed after funds were already moved — revert and
      // drop the orphaned request so nothing is left half-done.
      await transactionManager.runInTransaction((session) =>
        this.accounts.revertPayoutToAvailableInSession(ownerType, ownerId, payoutRequest.amount, session)
      );
      await this.payoutRepo.hardDeleteById(payoutRequest.id);
      throw error;
    }

    return payoutRequest;
  }

  /**
   * `resolvedBy` is an `ActorRef` rather than a bare id: since the admin split the
   * resolver may be a wi-admin administrator holding no `users` row here, and the row
   * has to record which identity space the id belongs to. `resolveTicketBestEffort`
   * still takes the plain id — the ticket module's own actor model is unchanged.
   */
  async markPaid(
    payoutRequestId: string,
    resolvedBy: ActorRef,
    reference: string | null
  ): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);
    this.assertResolvable(payoutRequest);

    const updated = await transactionManager.runInTransaction(async (session) => {
      await this.accounts.markPayoutPaidInSession(
        payoutRequest.owner_type,
        payoutRequest.owner_id.toString(),
        payoutRequest.amount,
        session
      );
      const marked = await this.payoutRepo.markPaid(payoutRequestId, resolvedBy, reference, session);
      if (!marked) {
        throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409);
      }
      return marked;
    });

    await this.resolveTicketBestEffort(
      updated,
      resolvedBy.userId,
      `Payout of ${updated.currency} ${updated.amount.toLocaleString()} confirmed paid${reference ? ` (ref: ${reference})` : ''}.`
    );

    await eventBus.publish('payout.paid', {
      eventType: 'payout.paid',
      aggregateId: updated.id,
      payload: {
        ownerType: updated.owner_type,
        ownerId: updated.owner_id.toString(),
        amount: updated.amount,
        currency: updated.currency,
        payoutRequestId: updated.id,
        ticketId: updated.ticket_id?.toString() ?? null,
        reference,
      },
      occurredAt: new Date(),
    });

    return updated;
  }

  async reject(
    payoutRequestId: string,
    resolvedBy: ActorRef,
    reason: string
  ): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);
    this.assertResolvable(payoutRequest);

    const updated = await transactionManager.runInTransaction(async (session) => {
      await this.accounts.revertPayoutToAvailableInSession(
        payoutRequest.owner_type,
        payoutRequest.owner_id.toString(),
        payoutRequest.amount,
        session
      );
      const marked = await this.payoutRepo.markRejected(payoutRequestId, resolvedBy, reason, session);
      if (!marked) {
        throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409);
      }
      return marked;
    });

    await this.resolveTicketBestEffort(updated, resolvedBy.userId, `Payout request rejected: ${reason}`);

    await eventBus.publish('payout.rejected', {
      eventType: 'payout.rejected',
      aggregateId: updated.id,
      payload: {
        ownerType: updated.owner_type,
        ownerId: updated.owner_id.toString(),
        amount: updated.amount,
        currency: updated.currency,
        payoutRequestId: updated.id,
        ticketId: updated.ticket_id?.toString() ?? null,
        reason,
      },
      occurredAt: new Date(),
    });

    return updated;
  }


  /**
   * Refuse a payout that cannot be resolved BY HAND, and say which of the two reasons it is.
   *
   * ⛔ The `processing` branch is the one that matters. A payout whose transfer is in flight
   * must not be rejected, because rejecting releases the hold — and if the gateway then
   * settles the transfer that looked dead, the owner has been paid twice: once by the
   * transfer and once out of the balance they got back. The transfer has to reach a terminal
   * verdict first, by callback or by reconciliation.
   *
   * `failed` IS resolvable, and deliberately so: it is the state an administrator is expected
   * to clear, either by retrying the transfer or by rejecting it to give the money back.
   */
  private assertResolvable(payoutRequest: IPayoutRequest): void {
    if (payoutRequest.status === 'processing') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT, 409, undefined, {
        status: payoutRequest.status,
        transferGatewayRef: payoutRequest.transfer_gateway_ref,
      });
    }
    if (payoutRequest.status !== 'pending' && payoutRequest.status !== 'failed') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409, undefined, {
        status: payoutRequest.status,
      });
    }
  }

  /**
   * Append a note to the linked ticket WITHOUT resolving it.
   *
   * The sibling of `resolveTicketBestEffort`, and separate for the reason that method's
   * header gives: resolving is what a decision does. An endorsement and a transfer attempt
   * are both mid-conversation events — the request is still open, and closing its ticket
   * would hide it from the queue of the administrator who still has to act on it.
   *
   * Best-effort for the same reason: the money-side state is already committed and a
   * ticketing failure must not undo it.
   */
  private async noteOnTicketBestEffort(
    payoutRequest: IPayoutRequest,
    noteText: string
  ): Promise<void> {
    if (!payoutRequest.ticket_id) return;
    const ticketId = payoutRequest.ticket_id.toString();
    try {
      await this.ticketNotes.createSystemNote(ticketId, noteText);
    } catch (error) {
      console.error(
        `[PayoutRequestService] Failed to note on ticket ${ticketId} for payout request ${payoutRequest.id}:`,
        error
      );
    }
  }

  /**
   * Record that a reviewer has checked this request and believes it genuine.
   *
   * ── What this does NOT do ─────────────────────────────────────────────────────
   * It moves no money, changes no status, and grants nothing. A payout with an endorsement
   * and a payout without one are equally payable — the endorsement is a note from one human
   * to the next, and the platform never treats it as a precondition. That is what keeps the
   * pre-screen optional and stops the reviewing tier becoming a bottleneck on cash.
   *
   * ⚠ **A triage REJECTION does not come here.** It is an ordinary `reject()` — terminal,
   * releasing the hold, recorded as a status. Rejection is money-neutral in intent but not
   * in effect, and giving it its own half-state would have produced two fields that can
   * disagree about whether a request is closed. The authorization difference (which tier may
   * do it) lives in wi-admin, not here.
   */
  async triage(
    payoutRequestId: string,
    reviewer: ActorRef,
    note: string | null
  ): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);

    if (payoutRequest.status !== 'pending') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409, undefined, {
        status: payoutRequest.status,
      });
    }
    if (payoutRequest.triage) {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_ALREADY_TRIAGED, 409, undefined, {
        endorsedBy: payoutRequest.triage.by_name,
        endorsedAt: payoutRequest.triage.at,
      });
    }

    const updated = await this.payoutRepo.setTriage(payoutRequestId, {
      verdict: 'endorsed',
      note,
      by_admin_id: reviewer.userId,
      by_name: reviewer.name ?? null,
      at: new Date(),
    });

    // Null means the CAS lost — somebody endorsed or resolved it between the read above
    // and the write. Both are "already reviewed" from the caller's point of view.
    if (!updated) {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_ALREADY_TRIAGED, 409);
    }

    await this.noteOnTicketBestEffort(
      updated,
      `Payout request endorsed by ${reviewer.name ?? 'a reviewer'} as a valid request.`
        + ` Final approval is still required before any money moves.${note ? ` Note: ${note}` : ''}`
    );

    return updated;
  }

  /**
   * Claim this payout for a gateway transfer and hand back the reference to send with.
   *
   * ⚠ **Call this BEFORE the gateway call, always.** It is a compare-and-set that both moves
   * the row to `processing` and fixes the merchant reference in one atomic update, so a
   * double-click loses the race here rather than at the gateway. A caller that sends first
   * and records afterwards has already sent twice by the time it finds out.
   *
   * The returned row carries `transfer_reference` — which may be one minted on a PREVIOUS
   * attempt, because a retry must reuse it. Send exactly what comes back, never
   * `candidateReference`.
   */
  async beginTransfer(payoutRequestId: string): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);

    if (payoutRequest.status === 'processing') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT, 409, undefined, {
        status: payoutRequest.status,
        transferGatewayRef: payoutRequest.transfer_gateway_ref,
      });
    }
    if (payoutRequest.status !== 'pending' && payoutRequest.status !== 'failed') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_NOT_SENDABLE, 409, undefined, {
        status: payoutRequest.status,
      });
    }

    const claimed = await this.payoutRepo.beginTransfer(payoutRequestId, mintMerchantRef('po'));
    if (!claimed) {
      // Lost the race. Whoever won is now holding the only valid claim on this payout.
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT, 409);
    }
    return claimed;
  }

  /**
   * Apply a terminal verdict from the gateway to a payout that is `processing`.
   *
   * Called by the webhook processor and by the reconciliation poll, which is why it is
   * idempotent by construction: both writes are compare-and-set on `status: 'processing'`,
   * so a redelivered callback and a poll that raced it settle the payout exactly once and
   * the loser gets `null` back.
   *
   * ⚠ **A `reversed` verdict arriving on an already-`paid` payout is NOT an accounting
   * rollback, and this method deliberately does not attempt one.** `markPayoutPaidInSession`
   * has permanently deducted the money from `requested_balance`; there is no ledger entry to
   * negate and no column to put it back into. The reversal is recorded on the row and noted
   * on the ticket so a human sees it, and the cash is corrected by an administrator
   * adjustment — the same posture the COD chain takes for a wrongly-confirmed deposit.
   */
  async applyTransferOutcome(
    payoutRequestId: string,
    outcome: { settled: boolean; gatewayRef: string | null; reason: string | null }
  ): Promise<IPayoutRequest | null> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);

    if (payoutRequest.status !== 'processing') {
      // Already settled, or never sent. Record the observation and change nothing — the
      // out-of-order case that matters is a `reversed` landing after a `complete`.
      if (payoutRequest.status === 'paid' && !outcome.settled) {
        await this.payoutRepo.setTransferGatewayRef(payoutRequestId, outcome.gatewayRef);
        await this.noteOnTicketBestEffort(
          payoutRequest,
          `⚠ The gateway reported this ALREADY-PAID payout as ${outcome.reason ?? 'reversed'}.`
            + ` The money was already deducted from the owner's balance, so this needs a manual`
            + ` cash adjustment — it is not corrected automatically.`
        );
      }
      return null;
    }

    if (!outcome.settled) {
      const failed = await this.payoutRepo.markTransferFailed(
        payoutRequestId,
        outcome.reason ?? 'The gateway did not complete this transfer',
        outcome.gatewayRef
      );
      if (!failed) return null;

      await this.noteOnTicketBestEffort(
        failed,
        `Payout transfer failed: ${failed.transfer_failure_reason}.`
          + ` The funds remain held — retry the transfer or reject the request to return them.`
      );

      await eventBus.publish('payout.transfer_failed', {
        eventType: 'payout.transfer_failed',
        aggregateId: failed.id,
        payload: {
          ownerType: failed.owner_type,
          ownerId: failed.owner_id.toString(),
          amount: failed.amount,
          currency: failed.currency,
          payoutRequestId: failed.id,
          ticketId: failed.ticket_id?.toString() ?? null,
          reason: failed.transfer_failure_reason,
        },
        occurredAt: new Date(),
      });

      return failed;
    }

    /**
     * The settlement. The balance move and the status change commit together — a paid
     * payout whose `requested_balance` was never debited would let the owner request the
     * same money again.
     *
     * The resolver is the PLATFORM, not a person: the administrator authorised the send,
     * and the gateway is what reported it done. `resolved_by` keeps the id of whoever
     * approved it only insofar as the approval row records that separately in wi-admin.
     */
    const settled = await transactionManager.runInTransaction(async (session) => {
      await this.accounts.markPayoutPaidInSession(
        payoutRequest.owner_type,
        payoutRequest.owner_id.toString(),
        payoutRequest.amount,
        session
      );
      return this.payoutRepo.settleTransferPaid(
        payoutRequestId,
        { userId: payoutRequest.requested_by_user_id.toString(), source: 'platform', name: null },
        payoutRequest.transfer_reference,
        outcome.gatewayRef,
        session
      );
    });

    if (!settled) return null;

    await this.resolveTicketBestEffort(
      settled,
      settled.requested_by_user_id.toString(),
      `Payout of ${settled.currency} ${settled.amount.toLocaleString()} sent and confirmed by the payment gateway`
        + `${settled.transfer_gateway_ref ? ` (transfer: ${settled.transfer_gateway_ref})` : ''}.`
    );

    await eventBus.publish('payout.paid', {
      eventType: 'payout.paid',
      aggregateId: settled.id,
      payload: {
        ownerType: settled.owner_type,
        ownerId: settled.owner_id.toString(),
        amount: settled.amount,
        currency: settled.currency,
        payoutRequestId: settled.id,
        ticketId: settled.ticket_id?.toString() ?? null,
        reference: settled.paid_reference,
      },
      occurredAt: new Date(),
    });

    return settled;
  }
  /**
   * Send a payout through the gateway.
   *
   * ── The order of the five steps is the whole safety argument ─────────────────
   *
   *   1. refuse a destination the gateway cannot reach  — before anything is claimed
   *   2. refuse if disbursement is switched off          — likewise
   *   3. check the float                                 — a knowable no, cheaply
   *   4. CLAIM the payout (`pending|failed → processing`, reference fixed)
   *   5. only now call the gateway
   *
   * Steps 1-3 happen before the claim so that a refusal the platform can predict leaves the
   * payout exactly as it was, ready to be sent once the cause is fixed — rather than parked
   * in `failed` for a reason that was never the gateway's.
   *
   * ⛔ **A THROWN error after step 4 deliberately leaves the payout in `processing`.** That
   * looks wrong and is not. A network failure, a timeout or an aborted request tells us
   * nothing about whether NotchPay received the transfer — and rolling the row back to
   * `pending` would release it for a second send while the first may be in flight. Leaving it
   * `processing` means the hold stays, no second send is possible, and the callback or the
   * reconciliation poll resolves it. The cost is an administrator waiting; the alternative
   * cost is paying twice.
   */
  async sendPayout(payoutRequestId: string): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);

    const destination = payoutRequest.payout_method_snapshot;
    const mobileMoney = destination?.method === 'mobile_money' ? destination.mobile_money : null;
    if (!mobileMoney?.phone_number) {
      /**
       * Bank and card destinations exist on stored rows even though
       * `ENABLED_PAYOUT_METHODS` no longer accepts new ones, and no gateway here can send to
       * either. They are paid by hand through `markPaid`, which is one of the reasons that
       * path was kept rather than retired.
       */
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_GATEWAY_UNSUPPORTED, 422, undefined, {
        method: destination?.method ?? null,
        hint: 'Only mobile-money destinations can be sent automatically. Settle this one manually.',
      });
    }

    if (!gatewaySupportsPayout(PAYOUT_GATEWAY)) {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_GATEWAY_UNSUPPORTED, 503, undefined, {
        gateway: PAYOUT_GATEWAY,
        hint: 'Automatic payouts are not enabled on this deployment. Settle this one manually.',
      });
    }

    const gateway = getPaymentGateway(PAYOUT_GATEWAY);

    /**
     * A float check, not a guarantee.
     *
     * It races — the balance can fall between here and the transfer — and that is fine,
     * because the gateway refuses on its own account and we record that refusal. What this
     * buys is the common case: an operator learns the float is short BEFORE a payout is
     * claimed, instead of finding it in `failed` with a message they have to go and read.
     *
     * A gateway that cannot report a balance (or reports none for this currency) returns
     * null, and null is not treated as zero — see `payoutBalance`.
     */
    const balance = await gateway.payoutBalance?.(payoutRequest.currency).catch(() => null);
    if (balance && balance.available < payoutRequest.amount) {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_FAILED, 409, undefined, {
        reason: 'insufficient_gateway_balance',
        required: payoutRequest.amount,
        available: balance.available,
        currency: balance.currency,
      });
    }

    // The claim. Everything above could be retried freely; nothing below can.
    const claimed = await this.beginTransfer(payoutRequestId);

    const result = await gateway.createPayout!({
      reference: claimed.transfer_reference as string,
      amount: claimed.amount,
      currency: claimed.currency,
      phone: mobileMoney.phone_number,
      name: mobileMoney.account_name || 'Beneficiary',
      description: `Payout ${claimed.currency} ${claimed.amount} to ${claimed.owner_type}`,
    });

    if (!result.success) {
      /**
       * The gateway said no, in a way it is sure about. Park the payout in `failed` with the
       * reason — the hold is deliberately NOT released (D-5), so an administrator retries or
       * rejects.
       */
      const failed = await this.applyTransferOutcome(claimed.id, {
        settled: false,
        gatewayRef: result.gatewayRef,
        reason: result.message ?? 'The payment gateway refused the transfer',
      });
      return failed ?? (await this.getByIdOrThrow(claimed.id));
    }

    await this.payoutRepo.setTransferGatewayRef(claimed.id, result.gatewayRef);

    await this.noteOnTicketBestEffort(
      claimed,
      `Payout transfer submitted to the payment gateway`
        + `${result.gatewayRef ? ` (transfer: ${result.gatewayRef})` : ''}.`
        + ` Awaiting confirmation — the payout is not settled until the gateway confirms it.`
    );

    return (await this.payoutRepo.findById(claimed.id)) ?? claimed;
  }

  /**
   * Resolve the payout a gateway transfer callback names.
   *
   * Keyed on OUR reference, which every sent payout has: it is minted in the same atomic
   * claim that moves the row to `processing`.
   */
  async getByTransferReference(reference: string): Promise<IPayoutRequest | null> {
    return this.payoutRepo.findByTransferReference(reference);
  }

  async getLatestForOwner(ownerType: EarningsOwnerType, ownerId: string): Promise<IPayoutRequest | null> {
    return this.payoutRepo.findLatestForOwner(ownerType, ownerId);
  }

  async getById(id: string): Promise<IPayoutRequest | null> {
    return this.payoutRepo.findById(id);
  }

  /**
   * One payout for the admin queue, with the destination MASKED.
   *
   * Separate from `getById`, which still returns the document, because the two have
   * different audiences: `getById` feeds `markPaid`/`reject`, which need the real
   * amount and status, and the admin HTTP surface, which must not see an account
   * number. Returning the document to both is how the plaintext reached a response.
   */
  async getByIdForAdmin(id: string): Promise<AdminPayoutRequestDto | null> {
    const payoutRequest = await this.payoutRepo.findById(id);
    if (!payoutRequest) return null;
    const [names, verifications] = await Promise.all([
      this.resolveOwnerNames([payoutRequest]),
      this.resolveOwnerVerifications([payoutRequest]),
    ]);
    return toAdminPayoutRequestDto(
      payoutRequest,
      this.ownerNameOf(names, payoutRequest),
      this.verificationOfRow(verifications, payoutRequest)
    );
  }

  async list(filters: ListPayoutRequestsFilters, pagination: PaginationOptions) {
    const { data, total } = await this.payoutRepo.listForAdmin(filters, pagination);
    const [ownerNamesByType, verifications] = await Promise.all([
      this.resolveOwnerNames(data),
      this.resolveOwnerVerifications(data),
    ]);
    return {
      data: data.map((r) =>
        toAdminPayoutRequestDto(
          r,
          this.ownerNameOf(ownerNamesByType, r),
          this.verificationOfRow(verifications, r)
        )
      ),
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  private ownerNameOf(names: Map<string, string>, row: IPayoutRequest): string | null {
    return names.get(`${row.owner_type}:${row.owner_id.toString()}`) ?? null;
  }

  private async getByIdOrThrow(id: string): Promise<IPayoutRequest> {
    const payoutRequest = await this.payoutRepo.findById(id);
    if (!payoutRequest) {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_FOUND, 404);
    }
    return payoutRequest;
  }

  /**
   * Auto-resolve the linked ticket as a side effect of mark-paid/reject.
   * Best-effort: a ticket-workflow refusal (the ticket was closed by hand first,
   * so RESOLVED is no longer a legal transition from where it now is) must never
   * undo an already-committed financial action, so failures here are logged, not
   * thrown.
   *
   * The example used to read "locked to a different admin", which named a mechanism
   * that does not exist: the only lock on a ticket is `priority_locked_by`, which
   * pins the PRIORITY field against re-prioritisation and has no bearing on who may
   * change a status. `updateStatus` refuses on a missing ticket, an illegal
   * transition, or a waiting status whose target does not participate — never on a
   * holder.
   */
  private async resolveTicketBestEffort(
    payoutRequest: IPayoutRequest,
    adminUserId: string,
    noteText: string
  ): Promise<void> {
    if (!payoutRequest.ticket_id) return;
    const ticketId = payoutRequest.ticket_id.toString();
    try {
      await ticketService.updateStatus(ticketId, TicketStatus.RESOLVED, adminUserId, ActorRole.ADMIN);
      await this.ticketNotes.createSystemNote(ticketId, noteText);
    } catch (error) {
      console.error(
        `[PayoutRequestService] Failed to auto-resolve ticket ${ticketId} for payout request ${payoutRequest.id}:`,
        error
      );
    }
  }

  /**
   * The owner's preferred method — the first entry of their ordered list.
   *
   * `platform` deliberately returns null: the platform account holds the
   * marketplace's own commission and has nobody to pay it to, so a payout
   * request for it is refused at the missing-method check rather than needing a
   * special case here.
   */
  private async resolvePreferredPayoutMethod(
    ownerType: EarningsOwnerType,
    ownerId: string
  ): Promise<IPayoutMethod | null> {
    if (ownerType === 'vendor') {
      const vendor = await this.vendorRepo.findById(ownerId);
      return vendor?.payout_details?.[0] ?? null;
    }
    if (ownerType === 'agency') {
      const agency = await this.agencyRepo.findById(ownerId);
      return agency?.payout_details?.[0] ?? null;
    }
    if (ownerType === 'agent') {
      const agent = await this.agentRepo.findById(ownerId);
      return agent?.payout_details?.[0] ?? null;
    }
    return null;
  }

  private describePayoutMethod(method: IPayoutMethod): string {
    if (method.method === 'mobile_money' && method.mobile_money) {
      return `mobile money (${method.mobile_money.provider}, ${method.mobile_money.phone_number})`;
    }
    if (method.method === 'bank' && method.bank) {
      return `bank transfer (${method.bank.bank_name}, account ${method.bank.account_number})`;
    }
    if (method.method === 'card' && method.card) {
      // Only last4 exists — there is no PAN to leak into a ticket note, which is
      // exactly why the card branch stores none. Expiry is included because it
      // is what an admin checks before pushing funds.
      const expiry = `${String(method.card.expiry_month).padStart(2, '0')}/${method.card.expiry_year}`;
      return `card (${method.card.brand.toUpperCase()} •••• ${method.card.last4}, expires ${expiry}, ${method.card.card_holder_name})`;
    }
    return 'the configured payout method';
  }

  /**
   * Where each owner's KYC review stands, batched exactly like `resolveOwnerNames`.
   *
   * ── Why an administrator needs this on the payout queue ──────────────────
   *
   * Payout review is the platform's only human checkpoint on money leaving it, and since
   * 2026-09-15 an `active` account is no longer evidence that anybody vetted the business —
   * accounts activate themselves on a proved phone. Without this field the reviewer sees an
   * active vendor with a plausible destination and no way to tell a vetted one from a
   * stranger who signed up this morning, short of opening another screen per row.
   *
   * ⚠ **It is shown, not enforced, and that is the whole point of surfacing it.** The owner
   * decided that working with an unverified counterparty is a business judgement rather than
   * a platform refusal. This makes the judgement possible; it does not make it for anybody.
   *
   * ⚠ An owner whose row has been deleted reads as `unverified`, never as verified — see
   * `UNKNOWN_VERIFICATION`. A missing document must not be a silent approval.
   */
  private async resolveOwnerVerifications(
    owners: Array<{ owner_type: string; owner_id: unknown }>
  ): Promise<Map<string, OwnerVerification>> {
    const result = new Map<string, OwnerVerification>();
    const vendorIds = owners.filter((r) => r.owner_type === 'vendor').map((r) => r.owner_id);
    const agencyIds = owners.filter((r) => r.owner_type === 'agency').map((r) => r.owner_id);
    const agentIds = owners.filter((r) => r.owner_type === 'agent').map((r) => r.owner_id);

    const [vendors, agencies, agents] = await Promise.all([
      vendorIds.length
        ? VendorModel.find({ _id: { $in: vendorIds } }).select('kyc_details.status').lean()
        : [],
      agencyIds.length
        ? DeliveryAgencyModel.find({ _id: { $in: agencyIds } }).select('kyc_details.status').lean()
        : [],
      agentIds.length
        ? DeliveryAgentModel.find({ _id: { $in: agentIds } }).select('kyc.status').lean()
        : [],
    ]);

    // ⚠ The agent's verdict lives on `kyc`, the other two on `kyc_details`. One name would
    // have been nicer; renaming either is a data migration, so the difference is spelled out
    // here rather than papered over with an `??` chain that would silently read `undefined`.
    for (const v of vendors as Array<{ _id: unknown; kyc_details?: { status?: string | null } }>) {
      result.set(`vendor:${String(v._id)}`, verificationOf(v.kyc_details));
    }
    for (const a of agencies as Array<{ _id: unknown; kyc_details?: { status?: string | null } }>) {
      result.set(`agency:${String(a._id)}`, verificationOf(a.kyc_details));
    }
    for (const a of agents as Array<{ _id: unknown; kyc?: { status?: string | null } }>) {
      result.set(`agent:${String(a._id)}`, verificationOf(a.kyc));
    }

    return result;
  }

  private verificationOfRow(
    verifications: Map<string, OwnerVerification>,
    row: { owner_type: string; owner_id: { toString(): string } }
  ): OwnerVerification {
    return (
      verifications.get(`${row.owner_type}:${row.owner_id.toString()}`) ?? UNKNOWN_VERIFICATION
    );
  }

  /** One owner's verdict. The batch form above is for the admin list; this is the write path. */
  private async resolveVerification(
    ownerType: EarningsOwnerType,
    ownerId: string
  ): Promise<OwnerVerification> {
    const owners = [{ owner_type: ownerType, owner_id: ownerId }];
    return this.verificationOfRow(await this.resolveOwnerVerifications(owners), {
      owner_type: ownerType,
      owner_id: ownerId,
    });
  }

  /**
   * How much this payout may move — `null` for "everything available".
   *
   * ⚠ **The auto-threshold sweep is exempt, and that exemption is the load-bearing part.**
   * `AUTO_PAYOUT_THRESHOLD` exists so the platform never owes an unbounded amount to one
   * account. Capping that path would leave the platform owing *more* to exactly the accounts
   * nobody has vetted, and the nightly sweep would fail against them for ever with nothing
   * opened to track the exposure. Those requests still reach a human, and the ticket states
   * the verdict.
   *
   * ⚠ A cap of `0` means no cap — see `EARNINGS_CONFIG.UNVERIFIED_PAYOUT_CAP`. The feature is
   * inert until a deployment sets a number.
   */
  /**
   * What this owner may still take out in the current window.
   *
   * Public because the three owner-facing earnings screens read it too: an owner who asks for
   * a payout and is handed a fraction of their balance with no explanation has been treated
   * badly, so the remaining allowance has to be visible BEFORE they ask, not only inferable
   * from a refusal afterwards.
   */
  async getAllowance(
    ownerType: EarningsOwnerType,
    ownerId: string,
    origin: PayoutRequestOrigin = 'manual'
  ): Promise<PayoutAllowance> {
    const verification = await this.resolveVerification(ownerType, ownerId);
    return this.allowanceFor(ownerType, ownerId, verification, origin);
  }

  private async allowanceFor(
    ownerType: EarningsOwnerType,
    ownerId: string,
    verification: OwnerVerification,
    origin: PayoutRequestOrigin
  ): Promise<PayoutAllowance> {
    const cap = EARNINGS_CONFIG.UNVERIFIED_PAYOUT_CAP;
    if (!allowanceApplies({ verified: verification.verified, origin, cap })) return UNCAPPED;

    const windowDays = EARNINGS_CONFIG.UNVERIFIED_PAYOUT_WINDOW_DAYS;
    const { total, oldestResolvedAt } = await this.payoutRepo.sumPaidSince(
      ownerType,
      ownerId,
      windowStart(windowDays)
    );

    return computeAllowance({ cap, windowDays, used: total, oldestResolvedAt });
  }

  private async resolveOwnerNames(requests: IPayoutRequest[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const vendorIds = requests.filter((r) => r.owner_type === 'vendor').map((r) => r.owner_id);
    const agencyIds = requests.filter((r) => r.owner_type === 'agency').map((r) => r.owner_id);
    const agentIds = requests.filter((r) => r.owner_type === 'agent').map((r) => r.owner_id);

    if (vendorIds.length > 0) {
      // Business name lives on the Store; prefer the vendor's personal display name.
      const [vendors, stores] = await Promise.all([
        VendorModel.find({ _id: { $in: vendorIds } }).select('display_name').lean(),
        StoreModel.find({ vendor_id: { $in: vendorIds } }).select('vendor_id name').lean(),
      ]);
      const storeNameByVendor = new Map(stores.map((s: any) => [s.vendor_id.toString(), s.name]));
      for (const v of vendors) {
        result.set(`vendor:${v._id.toString()}`, v.display_name || storeNameByVendor.get(v._id.toString()) || '');
      }
    }
    if (agencyIds.length > 0) {
      // Business name lives on the Magazin (keyed by agency_id).
      const magazins = await AgencyMagazinModel.find({ agency_id: { $in: agencyIds } })
        .select('agency_id name')
        .lean();
      for (const m of magazins) {
        result.set(`agency:${(m as any).agency_id.toString()}`, (m as any).name);
      }
    }
    if (agentIds.length > 0) {
      // An agent is a person, not a business — `name` is the only label there is.
      const agents = await DeliveryAgentModel.find({ _id: { $in: agentIds } })
        .select('name')
        .lean();
      for (const a of agents) {
        result.set(`agent:${a._id.toString()}`, a.name);
      }
    }
    return result;
  }
}

export const payoutRequestService = new PayoutRequestService();

/**
 * The owner-facing earnings view: balances, plus the allowance if one applies.
 *
 * ⚠ **Shared by all three owner controllers on purpose.** Vendor, agency and agent return the
 * same shape, and three copies of the composition is how one of them ends up without
 * `payoutAllowance` after somebody adds a field — the same drift that left the admin queue's
 * filter stopping at vendor and agency while agents' payouts could not be filtered at all.
 *
 * ⚠ **`payoutAllowance` is `null` when no limit applies** — a verified owner, or a deployment
 * with the cap switched off. `null` means "no limit", never "limit of zero"; a client that
 * renders a remaining balance of 0 from a missing object tells every verified owner they
 * cannot withdraw.
 */
export async function ownerEarningsView(
  ownerType: EarningsOwnerType,
  ownerId: string
): Promise<Record<string, unknown>> {
  const [balances, allowance] = await Promise.all([
    earningsAccountService.getBalances(ownerType, ownerId),
    payoutRequestService.getAllowance(ownerType, ownerId),
  ]);

  return {
    ...balances,
    payoutAllowance: allowance.capped ? describeAllowance(allowance) : null,
  };
}
