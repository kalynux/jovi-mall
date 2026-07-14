import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agencyRemittanceService } from '../services/agency-remittance.service';
import { codDiscrepancyService } from '../services/cod-discrepancy.service';
import { codTrustService } from '../services/cod-trust.service';
import { codSummaryService } from '../services/cod-summary.service';
import { CodPaginationQuerySchema } from '../validators/cod.validators';

const ListRemittancesQuerySchema = CodPaginationQuerySchema.extend({
  status: z.enum(['declared', 'confirmed', 'rejected']).optional(),
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

const RejectRemittanceSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(500),
});

const ListDiscrepanciesQuerySchema = CodPaginationQuerySchema.extend({
  status: z.enum(['open', 'resolved', 'written_off']).optional(),
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
    const result = await agencyRemittanceService.confirm(req.params.id, req.auth!.user.id);

    res.json({
      success: true,
      data: result,
      message: `Remittance confirmed — ${result.settledCollectionIds.length} collection(s) fully settled.`,
    });
  });

  /**
   * POST /api/admin/cod/remittances/:id/reject
   * Reject a declared remittance (nothing arrived / amount mismatch). No money moves.
   * Body: { reason }
   */
  static rejectRemittance = asyncHandler(async (req: Request, res: Response) => {
    const { reason } = RejectRemittanceSchema.parse(req.body);

    const remittance = await agencyRemittanceService.reject(req.params.id, req.auth!.user.id, reason);

    res.json({ success: true, data: remittance, message: 'Remittance declaration rejected.' });
  });

  /** GET /api/admin/cod/discrepancies — all flags. Query: status?, agencyId?, agentId?, page?, limit? */
  static listDiscrepancies = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit, status, agencyId, agentId } = ListDiscrepanciesQuerySchema.parse(req.query);

    const result = await codDiscrepancyService.list({ agencyId, agentId, status }, page, limit);

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
      req.auth!.user.id
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

  /** GET /api/admin/cod/agencies — agencies currently owing the platform cash. */
  static listAgencies = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = CodPaginationQuerySchema.parse(req.query);

    const result = await codSummaryService.listAgenciesForAdmin(page, limit);

    res.json({ success: true, data: result.data, meta: result.meta });
  });
}
