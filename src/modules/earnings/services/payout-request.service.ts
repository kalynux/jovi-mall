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
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { AgentRepository } from '../../agents/repositories/agent.repository';
import { VendorModel } from '../../vendors/vendor.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
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
    const pending = await this.payoutRepo.findPendingForOwner(ownerType, ownerId);
    if (pending) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_ALREADY_PENDING,
        409,
        'A payout request is already pending — wait for it to be resolved before requesting another'
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

    let payoutRequest: IPayoutRequest;
    try {
      payoutRequest = await transactionManager.runInTransaction(async (session) => {
        const { amount, currency } = await this.accounts.moveAvailableToRequestedInSession(
          ownerType,
          ownerId,
          session
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
          'A payout request is already pending — wait for it to be resolved before requesting another'
        );
      }
      throw error;
    }

    try {
      const ownerLabel =
        ownerType === 'vendor' ? 'Vendor' : ownerType === 'agent' ? 'Agent' : 'Agency';
      const description =
        origin === 'auto_threshold'
          ? `Balance reached the platform's automatic payout threshold. A payout of ${payoutRequest.currency} ${payoutRequest.amount.toLocaleString()} was requested automatically, via ${this.describePayoutMethod(payoutMethod)}.`
          : `Requesting a payout of ${payoutRequest.currency} ${payoutRequest.amount.toLocaleString()} via ${this.describePayoutMethod(payoutMethod)}.`;

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

  async markPaid(payoutRequestId: string, adminUserId: string, reference: string | null): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);
    if (payoutRequest.status !== 'pending') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409);
    }

    const updated = await transactionManager.runInTransaction(async (session) => {
      await this.accounts.markPayoutPaidInSession(
        payoutRequest.owner_type,
        payoutRequest.owner_id.toString(),
        payoutRequest.amount,
        session
      );
      const marked = await this.payoutRepo.markPaid(payoutRequestId, adminUserId, reference, session);
      if (!marked) {
        throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409);
      }
      return marked;
    });

    await this.resolveTicketBestEffort(
      updated,
      adminUserId,
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

  async reject(payoutRequestId: string, adminUserId: string, reason: string): Promise<IPayoutRequest> {
    const payoutRequest = await this.getByIdOrThrow(payoutRequestId);
    if (payoutRequest.status !== 'pending') {
      throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409);
    }

    const updated = await transactionManager.runInTransaction(async (session) => {
      await this.accounts.revertPayoutToAvailableInSession(
        payoutRequest.owner_type,
        payoutRequest.owner_id.toString(),
        payoutRequest.amount,
        session
      );
      const marked = await this.payoutRepo.markRejected(payoutRequestId, adminUserId, reason, session);
      if (!marked) {
        throw createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING, 409);
      }
      return marked;
    });

    await this.resolveTicketBestEffort(updated, adminUserId, `Payout request rejected: ${reason}`);

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

  async getLatestForOwner(ownerType: EarningsOwnerType, ownerId: string): Promise<IPayoutRequest | null> {
    return this.payoutRepo.findLatestForOwner(ownerType, ownerId);
  }

  async getById(id: string): Promise<IPayoutRequest | null> {
    return this.payoutRepo.findById(id);
  }

  async list(filters: ListPayoutRequestsFilters, pagination: PaginationOptions) {
    const { data, total } = await this.payoutRepo.listForAdmin(filters, pagination);
    const ownerNamesByType = await this.resolveOwnerNames(data);
    return {
      data: data.map((r) => ({
        ...r.toObject(),
        ownerName: ownerNamesByType.get(`${r.owner_type}:${r.owner_id.toString()}`) ?? null,
      })),
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
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
   * Best-effort: a ticket-workflow conflict (e.g. locked to a different admin)
   * must never undo an already-committed financial action, so failures here
   * are logged, not thrown.
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
    return 'the configured payout method';
  }

  private async resolveOwnerNames(requests: IPayoutRequest[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const vendorIds = requests.filter((r) => r.owner_type === 'vendor').map((r) => r.owner_id);
    const agencyIds = requests.filter((r) => r.owner_type === 'agency').map((r) => r.owner_id);
    const agentIds = requests.filter((r) => r.owner_type === 'agent').map((r) => r.owner_id);

    if (vendorIds.length > 0) {
      const vendors = await VendorModel.find({ _id: { $in: vendorIds } })
        .select('business_name display_name')
        .lean();
      for (const v of vendors) {
        result.set(`vendor:${v._id.toString()}`, v.display_name || v.business_name);
      }
    }
    if (agencyIds.length > 0) {
      const agencies = await DeliveryAgencyModel.find({ _id: { $in: agencyIds } })
        .select('agency_name')
        .lean();
      for (const a of agencies) {
        result.set(`agency:${a._id.toString()}`, a.agency_name);
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
