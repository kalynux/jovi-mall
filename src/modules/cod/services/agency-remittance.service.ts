import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { eventBus } from '../../../core/events/event-bus';
import { ActorRef, actorStamp } from '../../../core/types/actor-source.types';
import { AgencyRemittanceModel, IAgencyRemittance, AgencyRemittanceStatus } from '../models/agency-remittance.model';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { CodSettlementService, codSettlementService } from './cod-settlement.service';

/**
 * AgencyRemittanceService - the Agency → Platform leg of the cash chain.
 *
 * The agency DECLARES a remittance (with an external transfer reference);
 * an admin CONFIRMS receipt, which — in one transaction — lowers the agency's
 * cash liability and FIFO-settles its collected CashCollections (unlocking the
 * escrow release of the earnings that cash backs). Rejection changes nothing.
 */
export class AgencyRemittanceService {
  constructor(
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly settlement: CodSettlementService = codSettlementService
  ) {}

  async declare(params: {
    agencyId: string;
    amount: number;
    reference: string;
    note?: string | null;
    declaredByUserId: string;
  }): Promise<IAgencyRemittance> {
    const { agencyId, amount, reference, note, declaredByUserId } = params;

    if (!Number.isInteger(amount) || amount <= 0) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_INVALID_AMOUNT, 422, undefined, { amount });
    }

    // Can't declare more than the agency actually owes — the declared amounts
    // of still-open declarations count against the same liability.
    const { balance, currency } = await this.cashAccounts.getBalance('agency', agencyId);
    const pendingDeclared = await this.sumDeclared(agencyId);
    if (amount + pendingDeclared > balance) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_EXCEEDS_LIABILITY, 422, undefined, {
        amount,
        pendingDeclared,
        outstanding: balance,
      });
    }

    const remittance = await AgencyRemittanceModel.create({
      agency_id: agencyId,
      amount,
      currency,
      reference,
      note: note ?? null,
      status: 'declared',
      declared_by_user_id: declaredByUserId,
      declared_at: new Date(),
    });

    try {
      await eventBus.publish('cod.remittance.declared', {
        eventType: 'cod.remittance.declared',
        aggregateId: remittance._id.toString(),
        occurredAt: new Date(),
        payload: { remittanceId: remittance._id.toString(), agencyId, amount, currency, reference },
      });
    } catch (error) {
      console.error('[AgencyRemittanceService] Failed to emit cod.remittance.declared:', error);
    }

    return remittance;
  }

  /**
   * Admin confirms the platform received the cash. ONE transaction: remittance
   * resolved, agency liability debited (+ledger), FIFO settlement applied.
   */
  async confirm(remittanceId: string, actor: ActorRef) {
    const remittance = await AgencyRemittanceModel.findById(remittanceId);
    if (!remittance) {
      throw createAppError(ERROR_CODES.COD_REMITTANCE_NOT_FOUND, 404);
    }

    let settledCollectionIds: string[] = [];
    await transactionManager.runInTransaction(async (session) => {
      // Atomic claim: only a still-'declared' remittance can be confirmed.
      const claimed = await AgencyRemittanceModel.findOneAndUpdate(
        { _id: remittanceId, status: 'declared' },
        {
          $set: {
            status: 'confirmed',
            resolved_at: new Date(),
            // Three fields written together — the id, which identity space it belongs to,
            // and a name snapshot for the admin case that cannot be looked up from here.
            ...actorStamp('resolved_by', actor),
          },
        },
        { new: true, session }
      );
      if (!claimed) {
        throw createAppError(ERROR_CODES.COD_REMITTANCE_ALREADY_RESOLVED, 409);
      }

      await this.cashAccounts.debitInSession(
        'agency',
        claimed.agency_id.toString(),
        claimed.amount,
        'remittance',
        'agency_remittance',
        claimed._id.toString(),
        session
      );

      const result = await this.settlement.applyFifoInSession(
        claimed.agency_id.toString(),
        claimed.amount,
        session
      );
      settledCollectionIds = result.settledCollectionIds;
    });

    try {
      await eventBus.publish('cod.remittance.confirmed', {
        eventType: 'cod.remittance.confirmed',
        aggregateId: remittanceId,
        occurredAt: new Date(),
        payload: {
          remittanceId,
          agencyId: remittance.agency_id.toString(),
          amount: remittance.amount,
          settledCollectionIds,
        },
      });
    } catch (error) {
      console.error('[AgencyRemittanceService] Failed to emit cod.remittance.confirmed:', error);
    }

    return { remittance: this.toDto((await AgencyRemittanceModel.findById(remittanceId))!), settledCollectionIds };
  }

  /** Admin rejects the declaration (nothing arrived / mismatch). No money moves. */
  async reject(remittanceId: string, actor: ActorRef, reason: string) {
    const rejected = await AgencyRemittanceModel.findOneAndUpdate(
      { _id: remittanceId, status: 'declared' },
      {
        $set: {
          status: 'rejected',
          resolved_at: new Date(),
          ...actorStamp('resolved_by', actor),
          rejection_reason: reason,
        },
      },
      { new: true }
    );
    if (!rejected) {
      const exists = await AgencyRemittanceModel.exists({ _id: remittanceId });
      throw createAppError(
        exists ? ERROR_CODES.COD_REMITTANCE_ALREADY_RESOLVED : ERROR_CODES.COD_REMITTANCE_NOT_FOUND,
        exists ? 409 : 404
      );
    }
    return this.toDto(rejected);
  }

  async listForAgency(agencyId: string, page: number, limit: number, status?: AgencyRemittanceStatus) {
    const filter: Record<string, unknown> = { agency_id: agencyId };
    if (status) filter.status = status;
    return this.paginate(filter, page, limit);
  }

  async listForAdmin(page: number, limit: number, status?: AgencyRemittanceStatus, agencyId?: string) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (agencyId) filter.agency_id = agencyId;
    return this.paginate(filter, page, limit);
  }

  /** Sum of this agency's still-open ('declared') remittance declarations. */
  private async sumDeclared(agencyId: string): Promise<number> {
    const [result] = await AgencyRemittanceModel.aggregate([
      { $match: { agency_id: new Types.ObjectId(agencyId), status: 'declared' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return result?.total ?? 0;
  }

  private async paginate(filter: Record<string, unknown>, page: number, limit: number) {
    const [total, docs] = await Promise.all([
      AgencyRemittanceModel.countDocuments(filter).exec(),
      AgencyRemittanceModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    return {
      data: docs.map((r) => this.toDto(r)),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  private toDto(remittance: IAgencyRemittance) {
    return {
      id: remittance._id.toString(),
      agencyId: remittance.agency_id.toString(),
      amount: remittance.amount,
      currency: remittance.currency,
      reference: remittance.reference,
      note: remittance.note,
      status: remittance.status,
      declaredAt: remittance.declared_at,
      resolvedAt: remittance.resolved_at,
      rejectionReason: remittance.rejection_reason,
    };
  }
}

export const agencyRemittanceService = new AgencyRemittanceService();
