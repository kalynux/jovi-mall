import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { cashCollectionService } from '../services/cash-collection.service';
import { codCashAccountService } from '../services/cod-cash-account.service';
import { codExposureService } from '../services/cod-exposure.service';
import { agentDepositService } from '../services/agent-deposit.service';
import { codDiscrepancyService } from '../services/cod-discrepancy.service';
import {
  CollectCashSchema,
  CodPaginationQuerySchema,
  DeclareDepositSchema,
  AgentDepositStatusSchema,
  AgentRaiseDiscrepancySchema,
} from '../validators/cod.validators';
import { IDeliveryAgent, agentCodThresholdService } from '../../agents';
import { resolveEffectiveTrustScore } from '../../agents/domain/services/agent-trust-override';
import { agentCodPoolService } from '../../agents/domain/services/agent-cod-pool.service';
import { SetOwnCodPoolSchema } from '../../agents/validators/agent.validator';
import {
  agentActionAuditService,
  outcomeFromError,
} from '../../tracking-integration/services/agent-action-audit.service';
import { AgentActionOutcome } from '../../tracking-integration/models/tracking-outbox.model';

const ListDepositsQuerySchema = CodPaginationQuerySchema.extend({
  status: AgentDepositStatusSchema.optional(),
});

/**
 * Agent COD Controller - the agent side of cash on delivery: submit the
 * customer's delivery code at handoff (records the cash + delivers the
 * shipment), re-request a code for the customer, declare cash handed back, and
 * report an agency that has not accounted for it.
 */
export class AgentCodController {
  /**
   * POST /api/agent/shipments/:id/cod/collect
   * Body: { code, location?: {lat,lng}, deviceInfo? }
   */
  static collect = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const agentUserId = req.auth!.user.id;
    const shipmentId = req.params.id;

    // Phase 6 audit: this is the one genuine agent-initiated shipment action
    // (COD delivery). Emit the full outcome spectrum — attempt up front, then
    // success or the specific failure — fire-and-forget so it never disturbs the
    // collection. geo-tracker captures the agent's GPS for each.
    const audit = (outcome: AgentActionOutcome, reason?: string | null): void => {
      void agentActionAuditService
        .emit({ action: 'delivery', outcome, agentId, shipmentId, actorRole: 'agent', reason })
        .catch((err) => console.error('[AgentCodController] agent-action audit emit failed:', err));
    };

    audit('attempt');
    try {
      const input = CollectCashSchema.parse(req.body);

      const result = await cashCollectionService.collect(agentId, agentUserId, shipmentId, {
        code: input.code,
        location: input.location ?? null,
        deviceInfo: input.deviceInfo ?? null,
        ip: req.ip ?? null,
      });

      audit('success');
      res.json({
        success: true,
        data: result,
        message: 'Cash collected and shipment delivered.',
      });
    } catch (err) {
      audit(outcomeFromError(err), err instanceof Error ? err.message : null);
      throw err;
    }
  });

  /**
   * POST /api/agent/shipments/:id/cod/resend-code
   * Sends a FRESH code to the customer (locked or lost code). Rate-limited.
   */
  static resendCode = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const shipmentId = req.params.id;

    const result = await cashCollectionService.resendCodeAsAgent(agentId, shipmentId);

    res.json({
      success: true,
      data: result,
      message: 'A new delivery code was sent to the customer.',
    });
  });

  /**
   * GET /api/agent/cod/balance
   * The agent's full COD position: cash held (owed to the agency), current
   * exposure (held + pending collections), effective exposure limit after
   * trust scaling, and the trust score itself.
   */
  static getBalance = asyncHandler(async (req: Request, res: Response) => {
    const agent = req.auth!.role_entity as IDeliveryAgent;
    const agentId = agent._id.toString();

    // The agent holds ONE pot of cash across every agency, and their own
    // `cod.max_threshold` is the pool that bounds it — so a self-view has a
    // single honest limit, and it is the agent's own. Each contract's threshold
    // is a slice of this and binds only that agency's dispatches; none of them
    // is "my limit". (Since 2026-09-21 the exposure gate also caps every dispatch
    // at this pool, so the self-view and the gate now agree on the ceiling.)
    const [{ balance, currency }, exposure] = await Promise.all([
      codCashAccountService.getBalance('agent', agentId),
      codExposureService.currentExposure(agentId),
    ]);

    // ⚠ The EFFECTIVE score, not `cod.trust_score`. `effectiveExposureLimit`
    // beside it has ALWAYS honoured an administrator's pinned override, so
    // reporting the computed score here put two numbers in one body that
    // disagreed about the same agent — the limit scaled by a score the response
    // did not show.
    const trust = resolveEffectiveTrustScore(agent);

    res.json({
      success: true,
      data: {
        cashHeld: balance,
        currency,
        currentExposure: exposure,
        effectiveExposureLimit: codExposureService.effectiveLimit(agent, agent.cod?.max_threshold ?? 0),
        trustScore: trust.score,
        // Deliberately NOT the override's reason: that is an administrator's
        // internal note about this agent, and this is the agent's own view.
        trustSource: trust.source,
      },
    });
  });

  /**
   * GET /api/agent/cod/allocation
   *
   * How the agent's one COD pool is split across the agencies they serve, and
   * what is left unallocated. `/cod/balance` answers "how much cash am I
   * holding?"; this answers "how much am I permitted to hold, and who granted
   * it?" — the question an agent asks when an agency's dispatch is refused on
   * exposure while another agency's still goes through.
   */
  static getAllocation = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const allocation = await agentCodThresholdService.getAllocation(agentId);
    res.json({ success: true, data: allocation });
  });

  /**
   * PUT /api/agent/cod/pool — body `{ maxThreshold: number | null }`.
   *
   * The one COD-pool write an agent has, and it only goes DOWN: carry less than the
   * ceiling their plan (or an administrator's pin) allows, never more — `null` puts
   * them back on the whole ceiling. Unverified agents have a ceiling of 0, so for them
   * this can only confirm 0. Refused below what their contracts already hold, naming
   * the contracts in the way. Answers the same body as `GET /cod/allocation`.
   */
  static setPool = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { maxThreshold } = SetOwnCodPoolSchema.parse(req.body);

    await agentCodPoolService.setAgentLimit(agentId, maxThreshold);
    const allocation = await agentCodThresholdService.getAllocation(agentId);

    res.json({
      success: true,
      data: allocation,
      message: maxThreshold === null ? 'COD pool restored to your full limit.' : 'COD pool updated.',
    });
  });

  /** GET /api/agent/cod/ledger — append-only history of this agent's cash movements. */
  static getLedger = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const result = await codCashAccountService.getLedger('agent', agentId, page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * GET /api/agent/cod/deposits — this agent's cash hand-overs.
   * Query: status?, page?, limit?
   */
  static listDeposits = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { page, limit, status } = ListDepositsQuerySchema.parse(req.query);

    const result = await agentDepositService.listForAgent(agentId, page, limit, status);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * POST /api/agent/cod/deposits
   * Declare a cash hand-over. Moves no money — the receiving party confirms it,
   * and that is when the agent's balance falls.
   *
   * `recipient: 'agency'` is the normal route; `'platform'` means the agent paid
   * the platform directly, bypassing the agency, and needs a transfer
   * `reference`. Either way the declaration is a timestamped claim the receiver
   * has to answer, which is what an agent previously had no way to create.
   *
   * Body: { agencyId, amount, recipient?, reference?, note? }
   */
  static declareDeposit = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { agencyId, amount, recipient, reference, note } = DeclareDepositSchema.parse(req.body);

    const deposit = await agentDepositService.declare({
      agentId,
      agencyId,
      amount,
      recipient,
      reference,
      note,
      declaredByUserId: req.auth!.user.id,
    });

    res.status(201).json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agencyId,
        amount: deposit.amount,
        currency: deposit.currency,
        recipient: deposit.recipient,
        status: deposit.status,
        reference: deposit.reference,
        declaredAt: deposit.declared_at,
      },
      message:
        recipient === 'platform'
          ? 'Deposit declared — the platform will confirm receipt, which clears it with your agency too.'
          : 'Deposit declared — your agency will confirm receipt. Your cash balance falls when they do.',
    });
  });

  /**
   * POST /api/agent/cod/discrepancies
   * Report a cash problem with an agency — most usefully, that they recorded
   * less than was handed over, or nothing at all.
   * Body: { agencyId, amount?, depositId?, note }
   */
  static raiseDiscrepancy = asyncHandler(async (req: Request, res: Response) => {
    const agentId = req.auth!.role_entity._id.toString();
    const { agencyId, amount, depositId, note } = AgentRaiseDiscrepancySchema.parse(req.body);

    const discrepancy = await codDiscrepancyService.raiseByAgent({
      agentId,
      agencyId,
      amount,
      depositId,
      note,
      raisedByUserId: req.auth!.user.id,
    });

    res.status(201).json({
      success: true,
      data: {
        id: discrepancy._id.toString(),
        agencyId,
        type: discrepancy.type,
        amount: discrepancy.amount,
        status: discrepancy.status,
        openedAt: discrepancy.opened_at,
      },
      message: 'Report raised — an admin will review it.',
    });
  });
}
