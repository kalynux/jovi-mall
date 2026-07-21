import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agentTrackingPolicyService } from '../domain/services/agent-tracking-policy.service';
import { agentDeviceService } from '../domain/services/agent-device.service';
import { agentEligibilityService } from '../domain/services/agent-eligibility.service';
import {
  AgentIdParamSchema,
  ResolveTrackingPoliciesSchema,
  ReportTrackingStateSchema,
  EligibilityQuerySchema,
} from '../validators/agent.validator';
import { IGeoPoint } from '../../../core/types/geo.types';

/**
 * InternalAgentController — the API surface geo-tracker consumes.
 *
 * Authenticated by shared service token, not a user session: geo-tracker is a
 * service, and making it impersonate a user would corrupt the audit trail.
 *
 * ── The contract, stated so it survives future edits ────────────────────────
 *
 *   jovi-mall answers "may this agent be tracked?"      (business policy)
 *   geo-tracker answers "where is this agent?"          (execution)
 *
 * These endpoints only ever do the first. Nothing here returns a live position,
 * and `POST /tracking-state` accepts geo-tracker's report purely as a business
 * mirror — jovi-mall must never serve it back as if it were live. If a future
 * endpoint here starts answering "where", the boundary has been broken.
 */
export class InternalAgentController {
  /**
   * GET /api/internal/agents/:agentId/tracking-policy
   * The single question geo-tracker asks before opening a stream.
   */
  static getTrackingPolicy = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const policy = await agentTrackingPolicyService.resolve(agentId);
    res.json({ success: true, data: policy });
  });

  /**
   * POST /api/internal/agents/tracking-policies
   * Body: { agentIds: string[] }
   *
   * Batch form: geo-tracker resolves a whole watch-set on connect, and N round
   * trips per viewer would put jovi-mall on its latency path.
   */
  static resolveTrackingPolicies = asyncHandler(async (req: Request, res: Response) => {
    const { agentIds } = ResolveTrackingPoliciesSchema.parse(req.body);
    const policies = await agentTrackingPolicyService.resolveMany(agentIds);
    res.json({ success: true, data: { policies } });
  });

  /**
   * POST /api/internal/agents/:agentId/tracking-state
   * geo-tracker reporting what it observed: stream liveness, last position,
   * and (crucially) whether the device actually has location enabled.
   *
   * That last signal is the one input the assignment rules cannot get any other
   * way — see IAgentDeviceLocationProvider.
   */
  static reportTrackingState = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const input = ReportTrackingStateSchema.parse(req.body);

    const position: IGeoPoint | null | undefined =
      input.position === undefined
        ? undefined
        : input.position === null
          ? null
          : { type: 'Point', coordinates: input.position.coordinates };

    await agentTrackingPolicyService.recordTrackingState(agentId, {
      status: input.status,
      position,
      reportedAt: input.reportedAt,
      source: 'geo_tracker',
    });

    // Device signals are optional on this call — a liveness ping need not
    // re-report capabilities it has not re-checked.
    if (
      input.locationServicesEnabled !== undefined ||
      input.backgroundLocationEnabled !== undefined
    ) {
      await agentDeviceService.reportFromTracker(agentId, {
        locationServicesEnabled: input.locationServicesEnabled,
        backgroundLocationEnabled: input.backgroundLocationEnabled,
      });
    }

    res.json({ success: true, message: 'Tracking state recorded.' });
  });

  /**
   * GET /api/internal/agents/:agentId/eligibility?agencyId=
   * Exposed to geo-tracker for diagnostics — "why is this agent not being
   * dispatched?" is a question support asks from either side of the boundary.
   * Read-only; it decides nothing.
   */
  static getEligibility = asyncHandler(async (req: Request, res: Response) => {
    const { agentId } = AgentIdParamSchema.parse(req.params);
    const { agencyId } = EligibilityQuerySchema.parse(req.query);
    const result = await agentEligibilityService.evaluate(agentId, agencyId);
    res.json({ success: true, data: result });
  });
}
