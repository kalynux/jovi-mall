import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { clearable } from '../../../core/validation/zod.helpers';
import { actorFromRequest } from '../../../core/types/actor-source.types';
import { agencyRemittanceService } from '../services/agency-remittance.service';
import { agentDepositService } from '../services/agent-deposit.service';
import { codDiscrepancyService } from '../services/cod-discrepancy.service';
import { codTrustService } from '../services/cod-trust.service';
import { resolveEffectiveTrustScore } from '../../agents/domain/services/agent-trust-override';
import { codSummaryService } from '../services/cod-summary.service';
import {
  CodPaginationQuerySchema,
  AgentDepositStatusSchema,
  AgentDepositRecipientSchema,
  RejectDepositSchema,
} from '../validators/cod.validators';

const ListRemittancesQuerySchema = CodPaginationQuerySchema.extend({
  status: z.enum(['declared', 'confirmed', 'rejected']).optional(),
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

/**
 * A reviewer's endorsement of a declared remittance or deposit.
 *
 * Shared by both, because the stamp is the same on both records. There is no verdict
 * field: the only verdict this route records is "endorsed", and a rejection is the
 * reject route, because rejection is terminal and terminal outcomes are statuses.
 */
const TriageCodSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
});

const RejectRemittanceSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(500),
});

const ListDepositsQuerySchema = CodPaginationQuerySchema.extend({
  status: AgentDepositStatusSchema.optional(),
  recipient: AgentDepositRecipientSchema.optional(),
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

const RecordDirectDepositSchema = z.object({
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agent ID'),
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid agency ID'),
  amount: z.number().int().positive('Amount must be a positive integer (minor units)'),
  reference: z.string().trim().min(1, 'A transfer/receipt reference is required').max(200),
  note: clearable(z.string().trim().max(500)),
});

const ListDiscrepanciesQuerySchema = CodPaginationQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'written_off']).optional(),
  type: z.enum(['late_deposit', 'cash_shortfall', 'deposit_not_confirmed', 'other']).optional(),
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  agentId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

const ResolveDiscrepancySchema = z.object({
  resolution: z.enum(['resolved', 'written_off']),
  note: z.string().trim().min(1, 'A resolution note is required').max(500),
});

const TrustAdjustmentSchema = z.object({
  delta: z.number().int().min(-100).max(100),
  note: z.string().trim().min(1, 'A justification note is required').max(500),
});

/**
 * The persistent trust override (O-7). `score: null` releases it.
 *
 * ⚠ Note this is an ABSOLUTE score where the sibling above is a DELTA, and that
 * difference is the point rather than an inconsistency. A delta is a correction
 * to a computed number and is consumed by the next recompute; an override is a
 * judgement that replaces the computed number and outlives every recompute.
 * `.nullable()` and not `clearable()` — an omitted `score` must be a 400, not a
 * silent release of somebody else's pin.
 */
const TrustOverrideSchema = z.object({
  score: z.number().int().min(0).max(100).nullable(),
  reason: z.string().trim().min(1, 'A justification is required').max(500),
});

/**
 * Admin COD Controller - platform-side oversight of the cash chain: the
 * platform-wide cash position, and confirming/rejecting agency remittances
 * (confirmation is what settles collections and unlocks earnings release).
 */
export class AdminCodController {
  /**
   * GET /api/admin/cod/overview
   * Platform-wide COD cash position: cash held by agents, agency liabilities,
   * and collected cash not yet covered by confirmed remittances.
   */
  static overview = asyncHandler(async (_req: Request, res: Response) => {
    const overview = await codSummaryService.adminOverview();

    res.json({ success: true, data: overview });
  });

  /** GET /api/admin/cod/remittances — all agencies' remittances. Query: status?, agencyId?, page?, limit? */
  static listRemittances = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, status, agencyId } = ListRemittancesQuerySchema.parse(req.query);

    const result = await agencyRemittanceService.listForAdmin(page, limit, status, agencyId);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * POST /api/admin/cod/remittances/:id/confirm
   * Confirm the platform received the declared cash: lowers the agency's
   * liability and FIFO-settles its collections (unlocking earnings release).
   */
  static confirmRemittance = asyncHandler(async (req: Request, res: Response) => {
    const result = await agencyRemittanceService.confirm(req.params.id, actorFromRequest(req));

    res.json({
      success: true,
      data: result,
      message: `Remittance confirmed — ${result.settledCollectionIds.length} collection(s) fully settled.`,
    });
  });

  /**
   * POST /api/admin/cod/remittances/:id/triage
   * Endorse a declared remittance as genuine. No money moves and nothing is gated — an
   * un-endorsed remittance is exactly as confirmable as an endorsed one.
   */
  static triageRemittance = asyncHandler(async (req: Request, res: Response) => {
    const { note } = TriageCodSchema.parse(req.body);

    const remittance = await agencyRemittanceService.triage(
      req.params.id,
      actorFromRequest(req),
      note ?? null
    );

    res.json({
      success: true,
      data: remittance,
      message: 'Remittance endorsed — confirmation is still required before the liability moves.',
    });
  });

  /**
   * POST /api/admin/cod/remittances/:id/reject
   * Reject a declared remittance (nothing arrived / amount mismatch). No money moves.
   * Body: { reason }
   */
  static rejectRemittance = asyncHandler(async (req: Request, res: Response) => {
    const { reason } = RejectRemittanceSchema.parse(req.body);

    const remittance = await agencyRemittanceService.reject(req.params.id, actorFromRequest(req), reason);

    res.json({ success: true, data: remittance, message: 'Remittance declaration rejected.' });
  });

  /**
   * GET /api/admin/cod/deposits — every agent hand-over.
   * Query: status?, recipient?, agencyId?, page?, limit?
   *
   * `?status=declared&recipient=platform` is the platform's own inbox: agents
   * who paid the platform directly and are waiting on confirmation. Nothing
   * sweeps these — an agency's silence gets flagged automatically, but the
   * platform's own backlog is an ops queue, not a cash-chain fault.
   */
  static listDeposits = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, status, recipient, agencyId } = ListDepositsQuerySchema.parse(req.query);

    const result = await agentDepositService.listForAdmin(page, limit, {
      status,
      recipient,
      agencyId,
    });

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * POST /api/admin/cod/deposits
   * Record cash an agent paid the platform DIRECTLY, in one step (the platform
   * is the receiving party, so its own record needs no counter-signature).
   *
   * Settles both legs at once: the agent's liability and the contract balance
   * fall, and so does the agency's liability — the collections it backs are
   * FIFO-settled exactly as a confirmed remittance would.
   * Body: { agentId, agencyId, amount, reference, note? }
   */
  static recordDirectDeposit = asyncHandler(async (req: Request, res: Response) => {
    const { agentId, agencyId, amount, reference, note } = RecordDirectDepositSchema.parse(req.body);

    const actor = actorFromRequest(req);

    const deposit = await agentDepositService.record({
      agencyId,
      agentId,
      amount,
      recipient: 'platform',
      reference,
      note,
      recordedByUserId: actor.userId,
      actorSource: actor.source,
      actorName: actor.name,
    });

    res.status(201).json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agentId,
        agencyId,
        amount: deposit.amount,
        currency: deposit.currency,
        recipient: deposit.recipient,
        status: deposit.status,
        reference: deposit.reference,
        recordedAt: deposit.created_at,
      },
      message:
        'Direct deposit recorded — the agent and the agency were both cleared, and the agency\'s collections settled.',
    });
  });

  /**
   * POST /api/admin/cod/deposits/:id/triage
   * Endorse a declared direct-to-platform deposit as genuine.
   *
   * ⚠ Refused on an AGENCY-recipient deposit (`assertConfirmer`), and deliberately: that
   * handover is already counter-signed by two organisations, and the platform has no way to
   * verify cash it never received.
   */
  static triageDeposit = asyncHandler(async (req: Request, res: Response) => {
    const { note } = TriageCodSchema.parse(req.body);
    const actor = actorFromRequest(req);

    const deposit = await agentDepositService.triage({
      depositId: req.params.id,
      by: 'admin',
      note: note ?? null,
      reviewedByUserId: actor.userId,
      reviewerName: actor.name,
    });

    res.json({
      success: true,
      data: { id: deposit._id.toString(), status: deposit.status, triage: deposit.triage },
      message: 'Deposit endorsed — confirmation is still required before the cash chain settles.',
    });
  });

  /**
   * POST /api/admin/cod/deposits/:id/confirm
   * Confirm a direct-to-platform hand-over the agent declared. Same effect as
   * recording one: both legs settle.
   */
  static confirmDeposit = asyncHandler(async (req: Request, res: Response) => {
    const actor = actorFromRequest(req);

    const deposit = await agentDepositService.confirm({
      depositId: req.params.id,
      by: 'admin',
      confirmedByUserId: actor.userId,
      actorName: actor.name,
    });

    res.json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agentId: deposit.agent_id.toString(),
        agencyId: deposit.agency_id.toString(),
        amount: deposit.amount,
        currency: deposit.currency,
        status: deposit.status,
        resolvedAt: deposit.resolved_at,
      },
      message: 'Direct deposit confirmed — the agent and the agency were both cleared.',
    });
  });

  /**
   * POST /api/admin/cod/deposits/:id/reject
   * Reject a declared direct-to-platform hand-over (nothing arrived / the
   * reference does not match). No money moves.
   * Body: { reason }
   */
  static rejectDeposit = asyncHandler(async (req: Request, res: Response) => {
    const { reason } = RejectDepositSchema.parse(req.body);

    const actor = actorFromRequest(req);

    const deposit = await agentDepositService.reject({
      depositId: req.params.id,
      by: 'admin',
      reason,
      rejectedByUserId: actor.userId,
      actorName: actor.name,
    });

    res.json({
      success: true,
      data: {
        id: deposit._id.toString(),
        agentId: deposit.agent_id.toString(),
        amount: deposit.amount,
        status: deposit.status,
        rejectionReason: deposit.rejection_reason,
      },
      message: 'Direct deposit declaration rejected — nothing was settled.',
    });
  });

  /** GET /api/admin/cod/discrepancies — all flags. Query: status?, type?, agencyId?, agentId?, page?, limit? */
  static listDiscrepancies = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, status, type, agencyId, agentId } = ListDiscrepanciesQuerySchema.parse(req.query);

    const result = await codDiscrepancyService.list({ agencyId, agentId, status, type }, page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * POST /api/admin/cod/discrepancies/:id/resolve
   * Close a flag: 'resolved' (recovered/explained) or 'written_off' (loss taken).
   * Open discrepancies block the agency's reserve releases, so resolving
   * unblocks them. Body: { resolution, note }
   */
  static resolveDiscrepancy = asyncHandler(async (req: Request, res: Response) => {
    const { resolution, note } = ResolveDiscrepancySchema.parse(req.body);

    const discrepancy = await codDiscrepancyService.resolve(
      req.params.id,
      resolution,
      note,
      actorFromRequest(req)
    );

    res.json({ success: true, data: discrepancy, message: `Discrepancy ${resolution}.` });
  });

  /** GET /api/admin/cod/agents — agents currently holding cash (+ trust context). */
  static listAgents = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const result = await codSummaryService.listAgentsForAdmin(page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /**
   * POST /api/admin/cod/agents/:id/trust-adjustment
   * Manual trust-score correction (e.g. restore after a resolved discrepancy).
   * Body: { delta: -100..100, note }
   */
  static adjustTrust = asyncHandler(async (req: Request, res: Response) => {
    const { delta, note } = TrustAdjustmentSchema.parse(req.body);

    const result = await codTrustService.applyEvent({
      agentId: req.params.id,
      eventType: 'admin_adjustment',
      delta,
      refType: 'admin',
      note,
    });

    res.json({
      success: true,
      data: { agentId: req.params.id, trustScore: result.scoreAfter },
      message: 'Trust score adjusted.',
    });
  });

  /**
   * PUT /api/internal/admin/cod/agents/:id/trust-override
   * Pin a trust score that OUTRANKS the computed one, or release it with
   * `score: null`. Body: { score: 0..100 | null, reason }
   *
   * This is O-7's answer. See `resolveEffectiveTrustScore` for why it is a
   * separate field rather than a write to `cod.trust_score`: the computed score
   * is derived and every recompute overwrites it, so a judgement written there
   * does not survive the night — which is exactly the failure that blocks the
   * trust cutover.
   */
  static setTrustOverride = asyncHandler(async (req: Request, res: Response) => {
    const { score, reason } = TrustOverrideSchema.parse(req.body);

    const agent = await codTrustService.setOverride({
      agentId: req.params.id,
      score,
      reason,
      // `actorFromRequest` plus the role — the three-field stamp is what makes an
      // administrator's id resolvable later, since they hold no row in this
      // database and the cross-database join cannot exist.
      actor: { ...actorFromRequest(req), role: req.auth!.role },
    });

    const effective = resolveEffectiveTrustScore(agent);

    res.json({
      success: true,
      data: {
        agentId: req.params.id,
        // Both numbers, always. A screen that shows only the effective score
        // cannot tell an operator what releasing the override would do.
        effectiveTrustScore: effective.score,
        computedTrustScore: effective.computed,
        trustSource: effective.source,
        override: effective.override,
      },
      message: score === null ? 'Trust override released.' : 'Trust override set.',
    });
  });

  /** GET /api/admin/cod/agencies — agencies currently owing the platform cash. */
  static listAgencies = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const result = await codSummaryService.listAgenciesForAdmin(page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });
}
