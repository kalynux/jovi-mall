import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { COD_CONFIG } from '../config/cod.config';
import {
  CodDiscrepancyModel,
  ICodDiscrepancy,
  CodDiscrepancyStatus,
  CodDiscrepancyType,
} from '../models/cod-discrepancy.model';
import { CodTrustService, codTrustService } from './cod-trust.service';
import { CodCashAccountService, codCashAccountService } from './cod-cash-account.service';
import { DeliveryAgentRepository } from '../../delivery/delivery-agent.repository';

/**
 * CodDiscrepancyService - flagged problems in the cash chain and their
 * consequences: opening one applies the trust penalty; open ones block the
 * agency's reserve releases (and, for cash shortfalls, new COD assignments to
 * the agent). Resolution is admin-only.
 */
export class CodDiscrepancyService {
  constructor(
    private readonly trust: CodTrustService = codTrustService,
    private readonly cashAccounts: CodCashAccountService = codCashAccountService,
    private readonly agentRepo: DeliveryAgentRepository = new DeliveryAgentRepository()
  ) {}

  /** System-raised late-deposit flag (daily sweep). No-op if one is already open. */
  async openLateDeposit(agentId: string, agencyId: string, outstanding: number, currency: string) {
    const existing = await CodDiscrepancyModel.findOne({
      agent_id: agentId,
      type: 'late_deposit',
      status: 'open',
    });
    if (existing) return null; // already flagged — penalty was applied once

    const discrepancy = await CodDiscrepancyModel.create({
      agent_id: agentId,
      agency_id: agencyId,
      type: 'late_deposit',
      amount: outstanding,
      currency,
      status: 'open',
      raised_by: 'system',
      raised_by_user_id: null,
      note: `Cash held past the ${COD_CONFIG.DEPOSIT_DEADLINE_DAYS}-day deposit deadline`,
    });

    await this.trust.applyEvent({
      agentId,
      eventType: 'late_deposit',
      delta: -COD_CONFIG.TRUST_PENALTY_LATE_DEPOSIT,
      refType: 'cod_discrepancy',
      refId: discrepancy._id.toString(),
    });

    await this.emitOpened(discrepancy);
    return discrepancy;
  }

  /** Agency reports the agent handed over less cash than they held. */
  async raiseByAgency(params: {
    agencyId: string;
    agentId: string;
    type: Extract<CodDiscrepancyType, 'cash_shortfall' | 'other'>;
    amount: number | null;
    note: string;
    raisedByUserId: string;
  }): Promise<ICodDiscrepancy> {
    const { agencyId, agentId, type, amount, note, raisedByUserId } = params;

    const agent = await this.agentRepo.findById(agentId);
    if (!agent || agent.agency_id?.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENT_NOT_IN_AGENCY, 404);
    }

    const { currency } = await this.cashAccounts.getBalance('agent', agentId);

    const discrepancy = await CodDiscrepancyModel.create({
      agent_id: agentId,
      agency_id: agencyId,
      type,
      amount,
      currency,
      status: 'open',
      raised_by: 'agency',
      raised_by_user_id: raisedByUserId,
      note,
    });

    if (type === 'cash_shortfall') {
      await this.trust.applyEvent({
        agentId,
        eventType: 'deposit_shortfall',
        delta: -COD_CONFIG.TRUST_PENALTY_SHORTFALL,
        refType: 'cod_discrepancy',
        refId: discrepancy._id.toString(),
      });
    }

    await this.emitOpened(discrepancy);
    return discrepancy;
  }

  /** Admin resolution: 'resolved' (recovered/explained) or 'written_off'. */
  async resolve(
    discrepancyId: string,
    resolution: Exclude<CodDiscrepancyStatus, 'open'>,
    note: string,
    adminUserId: string
  ) {
    const resolved = await CodDiscrepancyModel.findOneAndUpdate(
      { _id: discrepancyId, status: 'open' },
      {
        $set: {
          status: resolution,
          resolution_note: note,
          resolved_by_user_id: adminUserId,
          resolved_at: new Date(),
        },
      },
      { new: true }
    );
    if (!resolved) {
      const exists = await CodDiscrepancyModel.exists({ _id: discrepancyId });
      throw createAppError(
        exists ? ERROR_CODES.COD_DISCREPANCY_ALREADY_RESOLVED : ERROR_CODES.COD_DISCREPANCY_NOT_FOUND,
        exists ? 409 : 404
      );
    }

    try {
      await eventBus.publish('cod.discrepancy.resolved', {
        eventType: 'cod.discrepancy.resolved',
        aggregateId: resolved._id.toString(),
        occurredAt: new Date(),
        payload: {
          discrepancyId: resolved._id.toString(),
          agentId: resolved.agent_id.toString(),
          agencyId: resolved.agency_id.toString(),
          resolution,
        },
      });
    } catch (error) {
      console.error('[CodDiscrepancyService] Failed to emit cod.discrepancy.resolved:', error);
    }

    return this.toDto(resolved);
  }

  async hasOpenForAgency(agencyId: string): Promise<boolean> {
    const count = await CodDiscrepancyModel.countDocuments({
      agency_id: agencyId,
      status: 'open',
    }).limit(1);
    return count > 0;
  }

  async hasOpenShortfallForAgent(agentId: string): Promise<boolean> {
    const count = await CodDiscrepancyModel.countDocuments({
      agent_id: agentId,
      type: 'cash_shortfall',
      status: 'open',
    }).limit(1);
    return count > 0;
  }

  async list(
    filter: { agencyId?: string; agentId?: string; status?: CodDiscrepancyStatus },
    page: number,
    limit: number
  ) {
    const query: Record<string, unknown> = {};
    if (filter.agencyId) query.agency_id = filter.agencyId;
    if (filter.agentId) query.agent_id = filter.agentId;
    if (filter.status) query.status = filter.status;

    const [total, docs] = await Promise.all([
      CodDiscrepancyModel.countDocuments(query).exec(),
      CodDiscrepancyModel.find(query)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    return {
      data: docs.map((d) => this.toDto(d)),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  private async emitOpened(discrepancy: ICodDiscrepancy) {
    try {
      await eventBus.publish('cod.discrepancy.opened', {
        eventType: 'cod.discrepancy.opened',
        aggregateId: discrepancy._id.toString(),
        occurredAt: new Date(),
        payload: {
          discrepancyId: discrepancy._id.toString(),
          agentId: discrepancy.agent_id.toString(),
          agencyId: discrepancy.agency_id.toString(),
          type: discrepancy.type,
          amount: discrepancy.amount,
        },
      });
    } catch (error) {
      console.error('[CodDiscrepancyService] Failed to emit cod.discrepancy.opened:', error);
    }
  }

  private toDto(d: ICodDiscrepancy) {
    return {
      id: d._id.toString(),
      agentId: d.agent_id.toString(),
      agencyId: d.agency_id.toString(),
      type: d.type,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      raisedBy: d.raised_by,
      note: d.note,
      resolutionNote: d.resolution_note,
      openedAt: d.opened_at,
      resolvedAt: d.resolved_at,
    };
  }
}

export const codDiscrepancyService = new CodDiscrepancyService();
