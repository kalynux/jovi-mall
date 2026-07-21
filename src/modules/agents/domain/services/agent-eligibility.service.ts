import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import {
  AgentContractRepository,
  agentContractRepository,
} from '../../repositories/agent-contract.repository';
import { IDeliveryAgent } from '../../models/agent.model';
import { IAgentAgencyMembership } from '../../models/agent-agency-membership.model';
import { AGENT_CONFIG } from '../../config/agent.config';

import { getDeviceLocationProvider } from '../../ports/device-location.port';

/**
 * Why an agent may not receive a shipment. Stable string codes — these are
 * surfaced to dispatchers and must be translatable/analysable, not prose.
 */
export type IneligibilityReason =
  | 'agent_not_found'
  // Platform gates — evaluated FIRST; they outrank everything below.
  | 'platform_banned'
  | 'kyc_not_verified'
  | 'agent_not_active'
  | 'membership_not_approved'
  | 'not_available'
  | 'tracking_not_allowed'
  | 'device_location_disabled'
  | 'device_location_unknown'
  | 'at_capacity';

export interface EligibilityRuleResult {
  rule: string;
  passed: boolean;
  reason: IneligibilityReason | null;
  /** What the rule actually saw — makes a denial explainable without a re-run. */
  observed: unknown;
}

export interface AgentEligibilityResult {
  agentId: string;
  agencyId: string;
  eligible: boolean;
  reasons: IneligibilityReason[];
  rules: EligibilityRuleResult[];
  activeShipmentCount: number;
  maxConcurrentShipments: number;
}

/**
 * AgentEligibilityService — "may this agent receive a shipment from this agency
 * right now?"
 *
 * The five rules from the domain requirements, evaluated together:
 *
 *   1. Active           — agent.status === 'active'
 *   2. Approved         — an approved membership with the DISPATCHING agency
 *   3. Available        — agent.availability.state === 'online'
 *   4. Tracking allowed — agent.tracking.allowed (jovi-mall's business flag)
 *   5. Device location  — reported enabled (geo-tracker's signal, via a port)
 *
 * Plus capacity, which is not a permission but a limit: an agent MAY hold
 * several shipments at once, so this bounds rather than forbids.
 *
 * ── Two deliberate design choices ───────────────────────────────────────────
 *
 * ALL rules are evaluated even after one fails. A dispatcher who fixes
 * "offline" only to be told "tracking disabled" — then "at capacity" — is
 * being made to play twenty questions. `reasons` returns every blocker at once.
 *
 * Rule 5 is resolved through IAgentDeviceLocationProvider, never read from the
 * agent document directly. jovi-mall cannot observe device location; geo-tracker
 * will. The rule asks the port and treats `null` (unknown) per config, so the
 * day geo-tracker starts reporting is a wiring change, not a rewrite. Defaults
 * are chosen so that today — with no provider — nobody is blocked.
 */
export class AgentEligibilityService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly memberships: AgentContractRepository = agentContractRepository
  ) {}

  /** Full evaluation. Never throws for ineligibility — inspect `.eligible`. */
  async evaluate(agentId: string, agencyId: string): Promise<AgentEligibilityResult> {
    const agent = await this.agents.findById(agentId);
    if (!agent) {
      return {
        agentId,
        agencyId,
        eligible: false,
        reasons: ['agent_not_found'],
        rules: [{ rule: 'agent_exists', passed: false, reason: 'agent_not_found', observed: null }],
        activeShipmentCount: 0,
        maxConcurrentShipments: 0,
      };
    }

    const membership = await this.memberships.findActive(agentId, agencyId);
    const deviceLocation = await this.resolveDeviceLocation(agentId);
    const activeShipmentCount = agent.capacity?.active_shipment_count ?? 0;

    // Platform gates lead: an unverified or banned agent must be refused for
    // THAT, not for happening to be offline as well. Ordering is meaning here —
    // it decides which reason an operator is sent to fix first.
    const rules: EligibilityRuleResult[] = [
      ...this.rulePlatformGates(agent),
      this.ruleActive(agent),
      this.ruleApproved(membership),
      this.ruleAvailable(agent),
      this.ruleTrackingAllowed(agent),
      this.ruleDeviceLocation(deviceLocation),
      this.ruleCapacity(agent, activeShipmentCount),
    ];

    const reasons = rules
      .filter((r) => !r.passed && r.reason !== null)
      .map((r) => r.reason as IneligibilityReason);

    return {
      agentId,
      agencyId,
      eligible: reasons.length === 0,
      reasons,
      rules,
      activeShipmentCount,
      maxConcurrentShipments: this.maxConcurrent(agent),
    };
  }

  /**
   * Throwing form for command paths (e.g. shipment assignment). Carries every
   * failed rule in `details` so the caller's error response explains itself.
   */
  async assertEligible(agentId: string, agencyId: string): Promise<AgentEligibilityResult> {
    const result = await this.evaluate(agentId, agencyId);
    if (!result.eligible) {
      throw createAppError(ERROR_CODES.AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT, 422, undefined, {
        agentId,
        agencyId,
        reasons: result.reasons,
        rules: result.rules.filter((r) => !r.passed),
      });
    }
    return result;
  }

  /** Batch evaluation for dispatch screens picking among candidates. */
  async evaluateMany(agentIds: string[], agencyId: string): Promise<AgentEligibilityResult[]> {
    return await Promise.all(agentIds.map((id) => this.evaluate(id, agencyId)));
  }

  /** The subset of an agency's approved agents that can take work right now. */
  async listEligibleAgentIds(agencyId: string): Promise<string[]> {
    const candidates = await this.memberships.listActiveAgentIds(agencyId);
    const results = await this.evaluateMany(candidates, agencyId);
    return results.filter((r) => r.eligible).map((r) => r.agentId);
  }

  // ─── Individual rules ─────────────────────────────────────────────────────

  /**
   * KYC + platform ban. Both reported when both fail, but the ban is listed
   * first — a banned agent's KYC status is beside the point.
   */
  private rulePlatformGates(agent: IDeliveryAgent): EligibilityRuleResult[] {
    const banned = agent.platform_ban?.banned === true;
    const kycStatus = agent.kyc?.status ?? 'unverified';

    return [
      {
        rule: 'platform_ban',
        passed: !banned,
        reason: banned ? 'platform_banned' : null,
        observed: { banned, reason: agent.platform_ban?.reason ?? null },
      },
      {
        rule: 'kyc',
        passed: kycStatus === 'verified',
        reason: kycStatus === 'verified' ? null : 'kyc_not_verified',
        observed: { kycStatus },
      },
    ];
  }

  private ruleActive(agent: IDeliveryAgent): EligibilityRuleResult {
    const passed = agent.status === 'active';
    return {
      rule: 'active',
      passed,
      reason: passed ? null : 'agent_not_active',
      observed: { status: agent.status },
    };
  }

  /**
   * An ACTIVE contract with the dispatching agency. `paused` and `suspended`
   * both fail: they still hold their COD slice, but they receive no new work —
   * that is the entire point of the distinction from `deactivated`.
   */
  private ruleApproved(contract: IAgentAgencyMembership | null): EligibilityRuleResult {
    const passed = contract !== null;
    return {
      rule: 'approved',
      passed,
      reason: passed ? null : 'membership_not_approved',
      observed: { contractStatus: contract?.status ?? null },
    };
  }

  private ruleAvailable(agent: IDeliveryAgent): EligibilityRuleResult {
    const state = agent.availability?.state ?? 'offline';
    const passed = state === 'online';
    return {
      rule: 'available',
      passed,
      reason: passed ? null : 'not_available',
      observed: { availability: state },
    };
  }

  private ruleTrackingAllowed(agent: IDeliveryAgent): EligibilityRuleResult {
    const allowed = agent.tracking?.allowed === true;
    return {
      rule: 'tracking_allowed',
      passed: allowed,
      reason: allowed ? null : 'tracking_not_allowed',
      observed: { allowed: agent.tracking?.allowed ?? null, reason: agent.tracking?.reason ?? null },
    };
  }

  /**
   * Device location. The tri-state from the port maps to policy:
   *
   *   false → always blocks. A phone with location off cannot be tracked, and
   *           that is true regardless of configuration.
   *   null  → UNKNOWN. Blocks only when device location is required AND policy
   *           says unknown is a denial. Default config (requirement off) means
   *           unknown passes — otherwise enabling this rule before geo-tracker
   *           reports anything would make every agent permanently ineligible.
   *   true  → passes.
   */
  private ruleDeviceLocation(enabled: boolean | null): EligibilityRuleResult {
    const provider = getDeviceLocationProvider().name;

    if (enabled === false) {
      return {
        rule: 'device_location',
        passed: false,
        reason: 'device_location_disabled',
        observed: { enabled, provider },
      };
    }

    if (enabled === null) {
      const blocks =
        AGENT_CONFIG.REQUIRE_DEVICE_LOCATION && AGENT_CONFIG.UNKNOWN_DEVICE_LOCATION_POLICY === 'deny';
      return {
        rule: 'device_location',
        passed: !blocks,
        reason: blocks ? 'device_location_unknown' : null,
        observed: {
          enabled: null,
          provider,
          required: AGENT_CONFIG.REQUIRE_DEVICE_LOCATION,
          unknownPolicy: AGENT_CONFIG.UNKNOWN_DEVICE_LOCATION_POLICY,
        },
      };
    }

    return { rule: 'device_location', passed: true, reason: null, observed: { enabled, provider } };
  }

  /**
   * Capacity — a limit, not a permission. Multiple concurrent shipments are
   * expected; this only stops an agent being buried.
   */
  private ruleCapacity(agent: IDeliveryAgent, activeShipmentCount: number): EligibilityRuleResult {
    const max = this.maxConcurrent(agent);
    const passed = activeShipmentCount < max;
    return {
      rule: 'capacity',
      passed,
      reason: passed ? null : 'at_capacity',
      observed: { activeShipmentCount, max },
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * The agent's ceiling. Capacity is global, not sub-allocated per agency:
   * one agent, one pair of hands. The count is read from the maintained
   * counter (`capacity.active_shipment_count`) rather than counted here — the
   * counter is what admission control atomically reserves against, so reading
   * anything else would let this rule disagree with the thing that decides.
   */
  private maxConcurrent(agent: IDeliveryAgent): number {
    const configured = agent.capacity?.max_active_shipments ?? AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_DEFAULT;
    return Math.min(configured, AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX);
  }

  /** Never let a provider failure become an exception on the dispatch path. */
  private async resolveDeviceLocation(agentId: string): Promise<boolean | null> {
    try {
      return await getDeviceLocationProvider().isDeviceLocationEnabled(agentId);
    } catch {
      return null;
    }
  }
}

export const agentEligibilityService = new AgentEligibilityService();
