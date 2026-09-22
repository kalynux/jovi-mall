import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentProfileService } from '../domain/services/agent-profile.service';
import { agentTrackingPolicyService } from '../domain/services/agent-tracking-policy.service';
import { agentContractService } from '../domain/services/agent-contract.service';
import { agentEligibilityService } from '../domain/services/agent-eligibility.service';
import { agentGateService } from '../domain/services/agent-gate.service';
import { agentCodThresholdService } from '../domain/services/agent-cod-threshold.service';
import { agentCodPoolService } from '../domain/services/agent-cod-pool.service';
import { describeCodPool } from '../domain/services/agent-cod-pool';
import { agentRepository } from '../repositories/agent.repository';
import { agentMembershipEventRepository } from '../repositories/agent-membership-event.repository';
import { AgentMembershipMapper } from '../dto/agent-membership.dto';
import { AgentProfileMapper } from '../dto/agent-profile.dto';
import { RoleActorRef, roleActorFromRequest } from '../../../core/types/actor-source.types';
import {
  SetAgentStatusSchema,
  SetTrackingAllowedSchema,
  TransferAgentSchema,
  AgentIdParamSchema,
  EligibilityQuerySchema,
  SetKycStatusSchema,
  SetPlatformBanSchema,
  SetAgentThresholdSchema,
  ContractIdParamSchema,
  AdminContractInterventionSchema,
  AdminContractReinstateSchema,
} from '../validators/agent.validator';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { resolveFileDetail } from '../../catalog/read-models/file-detail.resolver';
import { IDeliveryAgent } from '../models/agent.model';

const fileRepository = new FileRepositoryMongo();
const storageProvider = getStorageProvider();

/** Resolve one agent's avatar File reference into a `FileDetail` object (or null). */
async function agentAvatar(agent: IDeliveryAgent) {
  return resolveFileDetail(agent.avatar_file_id?.toString(), fileRepository, storageProvider);
}

/** Same, for the vehicle photo — the full profile DTO carries both. */
async function agentVehiclePhoto(agent: IDeliveryAgent) {
  return resolveFileDetail(agent.vehicle_info?.photo_file_id?.toString(), fileRepository, storageProvider);
}

/** An administrator's COD-pool pin, camelCased, or null. Admin reads only. */
function overrideDto(agent: IDeliveryAgent) {
  const pin = agent.cod?.pool_override ?? null;
  if (!pin) return null;
  return {
    amount: pin.amount,
    reason: pin.reason,
    setAt: pin.set_at,
    setByUserId: pin.set_by_user_id ?? null,
    setBySource: pin.set_by_source,
    setByName: pin.set_by_name ?? null,
  };
}

/**
 * Who is acting, in the form every write on this controller stamps.
 *
 * `role` and `source` are not the same thing and both are stored. Under
 * `requireAdminCaller` — the door wi-admin comes through — `req.auth` is SYNTHESISED from
 * headers with no database read, so `user.id` is a `wi-admin` `admin_accounts._id` that
 * resolves to nothing here. `actorFromRequest` is what marks it as such and snapshots the
 * name, because a cross-database join is not available at any price.
 */
function actorOf(req: Request): RoleActorRef {
  return roleActorFromRequest(req);
}

/**
 * AdminAgentController — platform-level agent administration.
 *
 * Two powers live here and nowhere else, both because they cross agency
 * boundaries:
 *   - account status (suspending the person, not one relationship)
 *   - transfer (moving an agent between agencies — an agency must not be able
 *     to pull an agent off a rival's roster)
 */
export class AdminAgentController {
  /** GET /api/admin/agents/:agentId */
  static getAgent = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const agent = await agentRepository.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    // Unpaginated on purpose: the admin view is "this agent's whole history",
    // and a page boundary would quietly hide contracts an investigation needs.
    // The agent's and agency's own list endpoints page; this one must not.
    const memberships = await agentContractService.listAllForAgent(agentId);

    res.json({
      success: true,
      data: {
        agent: AgentProfileMapper.toResponseDto(
          agent,
          new Date(),
          await agentAvatar(agent),
          await agentVehiclePhoto(agent),
        ),
        // Arrow, not bare: `toDto`'s second parameter is the open terms-proposal
        // id, and `map` would supply the element index for it.
        memberships: memberships.map((m) => AgentMembershipMapper.toDto(m)),
      },
    });
  });

  /**
   * PATCH /api/admin/agents/:agentId/status
   * Suspending the ACCOUNT deliberately leaves memberships intact so that
   * reinstating restores the agent's relationships as they were.
   */
  static setStatus = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { status, reason } = SetAgentStatusSchema.parse(req.body);

    const profile = await agentProfileService.setStatus(agentId, status, reason ?? null);

    res.json({ success: true, data: profile, message: `Agent status set to ${status}.` });
  });

  /**
   * PUT /api/admin/agents/:agentId/tracking-allow
   * jovi-mall owns this flag; geo-tracker enforces it.
   */
  static setTrackingAllowed = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { allowed, reason } = SetTrackingAllowedSchema.parse(req.body);

    const agent = await agentTrackingPolicyService.setTrackingAllowed(
      agentId,
      allowed,
      reason ?? null,
      actorOf(req)
    );

    res.json({
      success: true,
      data: AgentProfileMapper.toResponseDto(agent).tracking,
      message: allowed ? 'Tracking enabled for this agent.' : 'Tracking disabled for this agent.',
    });
  });

  /** GET /api/admin/agents/:agentId/tracking-policy — what geo-tracker would see. */
  static getTrackingPolicy = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const policy = await agentTrackingPolicyService.resolve(agentId);
    res.json({ success: true, data: policy });
  });

  /**
   * POST /api/admin/agents/transfer
   * Body: { agentId, fromAgencyId, toAgencyId, reason? }
   */
  static transfer = asyncHandler(async (req: Request, res: Response) => {
    const { agentId, fromAgencyId, toAgencyId, reason } = TransferAgentSchema.parse(req.body);

    const result = await agentContractService.transfer(
      agentId,
      fromAgencyId,
      toAgencyId,
      reason ?? null,
      actorOf(req)
    );

    res.json({
      success: true,
      data: {
        from: AgentMembershipMapper.toDto(result.from),
        to: AgentMembershipMapper.toDto(result.to),
      },
      message: 'Agent transferred.',
    });
  });

  /**
   * POST /contracts/:contractId/suspend — body `{ reason }`.
   *
   * Freezes one agent↔agency relationship. Runs the agency's own `suspend` path with the
   * contract's own agency resolved from the row, so the authority matrix, the legal
   * `from` states and the membership-event history are all unchanged — an administrator
   * gets a different door, not different rules.
   */
  static suspendContract = asyncHandler(async (req: Request, res: Response) => {
    const { contractId } = ContractIdParamSchema.parse(req.params);
    const { reason } = AdminContractInterventionSchema.parse(req.body);

    const contract = await agentContractService.adminSuspend(contractId, reason, actorOf(req));

    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(contract),
      message: 'Contract suspended.',
    });
  });

  /** POST /contracts/:contractId/reinstate — back to `active` from `paused` or `suspended`. */
  static reinstateContract = asyncHandler(async (req: Request, res: Response) => {
    const { contractId } = ContractIdParamSchema.parse(req.params);
    AdminContractReinstateSchema.parse(req.body ?? {});

    const contract = await agentContractService.adminReinstate(contractId, actorOf(req));

    res.json({
      success: true,
      data: AgentMembershipMapper.toDto(contract),
      message: 'Contract reinstated.',
    });
  });

  /**
   * POST /contracts/:contractId/deactivate — body `{ reason }`.
   *
   * ⚠ **This proposes termination; it does not perform one.** `deactivate` needs the
   * counterparty's agreement AND the §4 cash conditions — the agent's outstanding COD
   * settled and what the agency owes them paid. `contract` is `null` whenever those are
   * not met, and `blockers` says which.
   *
   * There is no administrative override, deliberately: ending a relationship while it
   * still owes an agent money is how that money stops being anybody's responsibility.
   */
  static deactivateContract = asyncHandler(async (req: Request, res: Response) => {
    const { contractId } = ContractIdParamSchema.parse(req.params);
    const { reason } = AdminContractInterventionSchema.parse(req.body);

    const result = await agentContractService.adminRequestDeactivation(
      contractId,
      reason,
      actorOf(req)
    );

    res.json({
      success: true,
      data: {
        contract: result.contract ? AgentMembershipMapper.toDto(result.contract) : null,
        pendingRequest: result.contract ? null : { id: String(result.request._id) },
        blockers: result.blockers,
      },
      message: result.contract
        ? 'Contract deactivated.'
        : 'Termination requested — it completes once the counterparty agrees and the outstanding balances are clear.',
    });
  });

  /**
   * PUT /api/admin/agents/:agentId/kyc
   * Body: { status, reference?, rejectionReason? } — reason required on reject.
   *
   * `kyc.status` defaults to `unverified` and eligibility requires `verified`,
   * so until an admin calls this an agent cannot be dispatched at all.
   */
  static setKyc = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { status, reference, rejectionReason } = SetKycStatusSchema.parse(req.body);

    const agent = await agentGateService.setKycStatus(agentId, status, actorOf(req), {
      reference,
      rejectionReason,
    });

    res.json({
      success: true,
      // `codPool` because the verdict moves it: `verified` opens the pool from the plan,
      // anything else closes it to 0. Showing the result beside the verdict is what lets
      // a reviewer see the consequence of what they just decided.
      data: { agentId, kyc: agent.kyc, codPool: describeCodPool(agent) },
      message: `KYC set to ${status}.`,
    });
  });

  /**
   * PUT /api/admin/agents/:agentId/ban
   * Body: { banned: boolean, reason? } — reason required when banning.
   *
   * Deliberately does NOT cascade to contracts: flipping each to paused would
   * be lossy, since un-banning could not tell which were already paused.
   */
  static setBan = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { banned, reason } = SetPlatformBanSchema.parse(req.body);

    const agent = await agentGateService.setPlatformBan(agentId, banned, reason, actorOf(req));

    res.json({
      success: true,
      data: { agentId, platformBan: agent.platform_ban },
      message: banned ? 'Agent banned from the platform.' : 'Platform ban lifted.',
    });
  });

  /**
   * PUT /api/internal/admin/agents/:agentId/cod-threshold
   * Body: { maxThreshold: number | null, reason }
   *
   * PINS the agent's COD pool, replacing their plan's value as the ceiling until
   * released with `maxThreshold: null` (owner decision 2026-09-21). The pin does
   * not outrank KYC: an unverified agent's pool stays 0 and the pin waits for the
   * verdict. Leaving the pool below what contracts already sub-allocate is
   * rejected with the shortfall and the offending contracts — on release too.
   *
   * ⚠ The body gained a required `reason` and a nullable `maxThreshold` in the
   * same change; wi-admin's gateway sends both.
   */
  static setCodThreshold = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { maxThreshold, reason } = SetAgentThresholdSchema.parse(req.body);

    const agent = await agentCodPoolService.setOverride({
      agentId,
      amount: maxThreshold,
      reason,
      actor: actorOf(req),
    });
    const allocation = await agentCodThresholdService.getAllocation(agentId);

    res.json({
      success: true,
      data: { ...allocation, override: overrideDto(agent) },
      message: maxThreshold === null ? 'COD pool pin released.' : 'COD pool pinned.',
    });
  });

  /**
   * GET /api/admin/agents/:agentId/cod-allocation
   * The pool, every contract's slice of it, and the unallocated headroom — the
   * view to consult before changing either level.
   */
  static getCodAllocation = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const allocation = await agentCodThresholdService.getAllocation(agentId);
    const agent = await agentRepository.findById(agentId);
    // The pin's reason and author ride on the ADMIN read only — the agent's own
    // `/agent/cod/allocation` carries `pool.source: 'override'` and nothing more.
    res.json({ success: true, data: { ...allocation, override: agent ? overrideDto(agent) : null } });
  });

  /** GET /api/admin/agents/:agentId/history — the full membership trail. */
  static getHistory = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const events = await agentMembershipEventRepository.listForAgent(agentId, 500);
    res.json({ success: true, data: events.map(AgentMembershipMapper.toEventDto) });
  });

  /** GET /api/admin/agents/:agentId/eligibility?agencyId= */
  static getEligibility = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { agencyId } = EligibilityQuerySchema.parse(req.query);
    const result = await agentEligibilityService.evaluate(agentId, agencyId);
    res.json({ success: true, data: result });
  });
}
