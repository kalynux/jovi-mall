import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { adminCallerActor } from '../../../api/middlewares/admin-caller.middleware';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { sendCreated, sendPaginated, sendSuccess } from '../../../core/responses';
import { EarningsAdjustmentRepository } from '../repositories/earnings-adjustment.repository';
import { agencyClaimService } from '../services/agency-claim.service';
import { toAgencyClaimAdminDto, toAgencyClaimPartyDto, toEarningsAdjustmentDto } from '../dto/earnings-explanations.dto';
import {
  AgencyClaimEligibilityQuerySchema,
  AgencyClaimIdParamSchema,
  CreateAgencyClaimBodySchema,
  ListAgencyClaimsQuerySchema,
  PartyListQuerySchema,
} from '../validators/agency-claim.validator';

const adjustments = new EarningsAdjustmentRepository();
const pagesOf = (total: number, limit: number) => Math.ceil(total / limit);

/**
 * "Why was my money taken?" for the vendor, the agency and the agent, and the damage claims an
 * administrator records (owner decisions F-6…F-8 and the explanation objective, 2026-10-22).
 * Contract: `api-doc/admin/agency-claims.md`, and each role's `earnings.md`.
 */
export class EarningsExplanationsController {
  // ── The parties (their own rows only; the owner comes from the session, never the query) ──

  /** GET /api/{vendor,agency,agent}/earnings/adjustments */
  static listMyAdjustments = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = PartyListQuerySchema.parse(req.query);
    const role = req.auth!.role as 'vendor' | 'agency' | 'agent';
    const ownerId = req.auth!.role_entity._id.toString();
    const { items, total } = await adjustments.pageForOwner(role, ownerId, page, limit);
    sendPaginated(res, items.map(toEarningsAdjustmentDto), { total, page, limit, pages: pagesOf(total, limit) });
  });

  /** GET /api/agency/earnings/claims — damage claims charged to this agency. */
  static listAgencyClaims = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = PartyListQuerySchema.parse(req.query);
    const agencyId = req.auth!.role_entity._id.toString();
    const { items, total } = await agencyClaimService.list({ agencyId }, page, limit);
    sendPaginated(res, items.map(toAgencyClaimPartyDto), { total, page, limit, pages: pagesOf(total, limit) });
  });

  /** GET /api/vendor/earnings/agency-claims — damage claims that compensated this vendor. */
  static listVendorClaims = asyncHandler(async (req: Request, res: Response) => {
    const { page, limit } = PartyListQuerySchema.parse(req.query);
    const vendorId = req.auth!.role_entity._id.toString();
    const { items, total } = await agencyClaimService.list({ vendorId }, page, limit);
    sendPaginated(res, items.map(toAgencyClaimPartyDto), { total, page, limit, pages: pagesOf(total, limit) });
  });

  // ── Administrators (wi-admin, behind requireAdminCaller) ──────────────────────────────────

  /** GET /api/internal/admin/agency-claims */
  static adminList = asyncHandler(async (req: Request, res: Response) => {
    const { agencyId, vendorId, shipmentId, page, limit } = ListAgencyClaimsQuerySchema.parse(req.query);
    const { items, total } = await agencyClaimService.list({ agencyId, vendorId, shipmentId }, page, limit);
    sendPaginated(res, items.map(toAgencyClaimAdminDto), { total, page, limit, pages: pagesOf(total, limit) });
  });

  /** GET /api/internal/admin/agency-claims/eligibility?shipmentId=&refundRequestId= */
  static adminEligibility = asyncHandler(async (req: Request, res: Response) => {
    const { shipmentId, refundRequestId } = AgencyClaimEligibilityQuerySchema.parse(req.query);
    sendSuccess(res, await agencyClaimService.eligibility(shipmentId, refundRequestId ?? null));
  });

  /** GET /api/internal/admin/agency-claims/:id */
  static adminGet = asyncHandler(async (req: Request, res: Response) => {
    const { id } = AgencyClaimIdParamSchema.parse(req.params);
    const claim = await agencyClaimService.getById(id);
    if (!claim) throw createAppError(ERROR_CODES.AGENCY_CLAIM_NOT_FOUND, 404);
    sendSuccess(res, toAgencyClaimAdminDto(claim));
  });

  /** POST /api/internal/admin/agency-claims — charge a damage claim. The actor is `X-Actor-*`. */
  static adminCreate = asyncHandler(async (req: Request, res: Response) => {
    const body = CreateAgencyClaimBodySchema.parse(req.body ?? {});
    const actor = adminCallerActor(req);
    const claim = await agencyClaimService.create({
      shipmentId: body.shipmentId,
      itemCount: body.itemCount,
      amount: body.amount,
      note: body.note,
      refundRequestId: body.refundRequestId ?? null,
      actor: { id: actor?.id ?? null, name: actor?.name ?? null },
    });
    sendCreated(res, toAgencyClaimAdminDto(claim), { message: 'Damage claim charged' });
  });
}
