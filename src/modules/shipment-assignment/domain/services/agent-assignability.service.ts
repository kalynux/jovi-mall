import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { ShipmentRepository } from '../../../shipments/shipment.repository';
import { IShipment } from '../../../shipments/shipment.model';
import { OrderModel, IOrder } from '../../../orders/order.model';
import {
  AgentRepository,
  agentRepository,
  AgentEligibilityService,
  agentEligibilityService,
  AgentEligibilityResult,
  EligibilityRuleResult,
} from '../../../agents';
import {
  ContractPolicyService,
  contractPolicyService,
  ContractPolicyResult,
  ContractPolicyGate,
  GateStatus,
  GateRemedy,
} from './contract-policy.service';

/**
 * One gate, in the one shape a console can render.
 *
 * The two families underneath report differently — `AgentEligibilityService`
 * returns `{rule, passed, reason, observed}` and `ContractPolicyService` returns
 * a richer gate — so they are normalised here rather than at the caller. A
 * dashboard rendering "why was this refused" should not have to know that the
 * rules come from two services.
 */
export interface AssignabilityGate {
  /** `platform` for the availability/identity rules, `contract` for the terms. */
  family: 'platform' | 'contract';
  gate: string;
  status: GateStatus;
  /** The stable code, never prose. Null unless `status` is `failed`. */
  reason: string | null;
  observed: Record<string, unknown>;
  /** One English line for the internal admin console. Never parsed. */
  summary: string;
  remedies: GateRemedy[];
}

export interface AgentAssignabilityResult {
  agentId: string;
  agencyId: string;
  shipmentId: string | null;
  /** True only when no gate failed. Skipped gates do not make it false. */
  assignable: boolean;
  /** Every failed gate's name, in evaluation order. Empty when assignable. */
  blockers: string[];
  gates: AssignabilityGate[];
  /** Context the gates were evaluated against — what the operator is looking at. */
  context: {
    shipment: {
      shipmentId: string;
      status: string;
      agencyId: string;
      currentAgentId: string | null;
      orderId: string;
      paymentMethod: string | null;
      currency: string | null;
      /** What this shipment is worth, and therefore what it adds to exposure. */
      value: number | null;
      deliveryRegion: string | null;
    } | null;
    /** Null when the agent has no active contract with this agency. */
    contract: ContractPolicyResult['contract'];
  };
  /**
   * The two underlying payloads, unmodified.
   *
   * `gates` is a projection of these for rendering; these are the record. Kept
   * because `eligibility` in particular is an existing, separately documented
   * contract (`GET /agents/:agentId/eligibility`) and a caller already parsing
   * that shape must not have to re-learn it here.
   */
  eligibility: AgentEligibilityResult;
  contractPolicy: ContractPolicyResult;
}

/**
 * AgentAssignabilityService — the single "why can this agent not take this
 * work?" answer, for the admin console.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Assignment is gated by TWO independent families of rule, and until this
 * service only one of them was diagnosable:
 *
 *   platform  — banned · KYC · active · available · tracking · device · capacity
 *               (`AgentEligibilityService`, reachable at `/eligibility`)
 *   contract  — active contract · coverage region · value ceiling · COD exposure
 *               (`ContractPolicyService`, reachable NOWHERE before this)
 *
 * The gap mattered because the contract family is where the numbers are. A
 * support agent explaining a `COD_AGENT_EXPOSURE_EXCEEDED` refusal could see the
 * agency's COD threshold (200,000 in the case that prompted this) but neither
 * the agent's actual exposure nor the trust multiplier that had halved that
 * threshold — so every screen they had told them the opposite of what the gate
 * had decided.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It re-derives no rule. Every verdict here comes from the same service the
 * dispatch path calls, and the numbers come back from the same evaluation. See
 * `ContractPolicyService`'s header: a diagnostic built on a second copy of a
 * rule does not fail, it lies, and an operator repeats the lie to an agency.
 *
 * It is also READ-ONLY and admin-only. It reports an agent's cash position
 * across every agency they serve — which is exactly what the gate compares
 * against, and exactly what one agency must not be shown about another's.
 */
export class AgentAssignabilityService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly eligibility: AgentEligibilityService = agentEligibilityService,
    private readonly contractPolicy: ContractPolicyService = contractPolicyService,
    private readonly shipments: ShipmentRepository = new ShipmentRepository()
  ) {}

  /**
   * @param shipmentId optional. With one, every gate runs and the answer is
   *        "may this agent take THIS shipment". Without one, the two
   *        shipment-scoped gates report `skipped` and the cash gate answers "is
   *        this agent already at their limit for this agency" — which is the
   *        question support asks before it has a shipment id to hand.
   */
  async evaluate(
    agentId: string,
    agencyId: string,
    shipmentId: string | null = null
  ): Promise<AgentAssignabilityResult> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const { shipment, order } = await this.resolveShipment(shipmentId, agencyId);

    const [eligibility, contractPolicy] = await Promise.all([
      this.eligibility.evaluate(agentId, agencyId),
      this.contractPolicy.evaluate(agent, agencyId, shipment, order, { full: true }),
    ]);

    const gates = [...this.platformGates(eligibility), ...this.contractGates(contractPolicy)];

    return {
      agentId,
      agencyId,
      shipmentId,
      assignable: gates.every((g) => g.status !== 'failed'),
      blockers: gates.filter((g) => g.status === 'failed').map((g) => g.gate),
      gates,
      context: {
        shipment: shipment
          ? {
              shipmentId: shipment._id.toString(),
              status: shipment.status,
              agencyId: shipment.agency_id.toString(),
              currentAgentId: shipment.agent_id ? shipment.agent_id.toString() : null,
              orderId: shipment.order_id.toString(),
              paymentMethod: order?.payment_method ?? null,
              currency: order?.currency ?? null,
              value: contractPolicy.shipmentValue,
              deliveryRegion: order?.delivery_address?.components?.region ?? null,
            }
          : null,
        contract: contractPolicy.contract,
      },
      eligibility,
      contractPolicy,
    };
  }

  // ─── Normalisation ────────────────────────────────────────────────────────

  /**
   * The eligibility rules, in this service's shape.
   *
   * ⚠ `approved` is DROPPED. It asks the same question as the contract family's
   * `contract_active` and would render as two rows saying the same thing — and
   * the contract one is strictly better, because it also reports which
   * non-active contracts exist. It stays in the `eligibility` payload below,
   * untouched; only the merged view omits it.
   */
  private platformGates(result: AgentEligibilityResult): AssignabilityGate[] {
    return result.rules
      .filter((rule) => rule.rule !== 'approved')
      .map((rule) => ({
        family: 'platform' as const,
        gate: rule.rule,
        status: (rule.passed ? 'passed' : 'failed') as GateStatus,
        reason: rule.passed ? null : rule.reason,
        observed: (rule.observed ?? {}) as Record<string, unknown>,
        summary: this.platformSummary(rule, result),
        remedies: [],
      }));
  }

  private contractGates(result: ContractPolicyResult): AssignabilityGate[] {
    return result.gates.map((gate: ContractPolicyGate) => ({
      family: 'contract' as const,
      gate: gate.gate,
      status: gate.status,
      reason: gate.reason,
      observed: gate.observed,
      summary: gate.summary,
      remedies: gate.remedies,
    }));
  }

  /**
   * English for one platform rule.
   *
   * These live here rather than in `AgentEligibilityService` on purpose: that
   * service's own header states its reasons are codes "surfaced to dispatchers
   * and must be translatable/analysable, not prose", and three dashboards
   * already translate them. Prose belongs to the admin console, which is
   * English-only, so it is added at the console's edge instead of pushed down
   * into a contract that four callers share.
   */
  private platformSummary(rule: EligibilityRuleResult, result: AgentEligibilityResult): string {
    const seen = (rule.observed ?? {}) as Record<string, any>;

    switch (rule.rule) {
      case 'platform_ban':
        return rule.passed
          ? 'The agent is not banned from the platform.'
          : `The agent is banned from the platform${seen.reason ? ` (${seen.reason})` : ''}.`;
      case 'kyc':
        return rule.passed
          ? 'KYC is verified.'
          : `KYC is ${seen.kycStatus ?? 'unverified'} — an agent can only be dispatched once it is verified.`;
      case 'active':
        return rule.passed
          ? 'The agent account is active.'
          : `The agent account is ${seen.status ?? 'not active'}.`;
      case 'available':
        return rule.passed
          ? 'The agent is online.'
          : `The agent is ${seen.availability ?? 'offline'} — they must be online to receive work.`;
      case 'tracking_allowed':
        return rule.passed
          ? 'Tracking is allowed for this agent.'
          : `Tracking is disabled for this agent${seen.reason ? ` (${seen.reason})` : ''}, and the platform will not dispatch without it.`;
      case 'device_location':
        return rule.passed
          ? seen.enabled === true
            ? 'The device is reporting location.'
            : 'Device location is unknown, which current policy allows.'
          : seen.enabled === false
            ? 'The device has location switched off.'
            : 'Device location is unknown and policy denies dispatch on unknown.';
      case 'capacity':
        return rule.passed
          ? `Carrying ${result.activeShipmentCount} of a maximum ${result.maxConcurrentShipments} concurrent shipments.`
          : `At capacity — carrying ${result.activeShipmentCount} of a maximum ${result.maxConcurrentShipments} concurrent shipments.`;
      case 'agent_exists':
        return 'No such agent.';
      default:
        return rule.passed ? `${rule.rule}: passed.` : `${rule.rule}: failed.`;
    }
  }

  /**
   * Load the shipment and its order, or `{null, null}` when none was named.
   *
   * The shipment must belong to the agency being asked about. A diagnostic that
   * happily explains one agency's shipment under another agency's terms produces
   * a confident, wrong answer — the exact failure mode this whole service exists
   * to avoid.
   */
  private async resolveShipment(
    shipmentId: string | null,
    agencyId: string
  ): Promise<{ shipment: IShipment | null; order: IOrder | null }> {
    if (!shipmentId) return { shipment: null, order: null };

    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    if (shipment.agency_id.toString() !== agencyId) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, {
        hint: 'This shipment does not belong to the agency named in agencyId.',
      });
    }

    const order = await OrderModel.findById(shipment.order_id);
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);

    return { shipment, order };
  }
}

export const agentAssignabilityService = new AgentAssignabilityService();
