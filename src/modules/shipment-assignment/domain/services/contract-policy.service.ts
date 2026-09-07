import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IShipment } from '../../../shipments/shipment.model';
import { IOrder } from '../../../orders/order.model';
import {
  AgentContractRepository,
  agentContractRepository,
  IAgentAgencyMembership,
  IDeliveryAgent,
  contractCoversRegion,
  contractAllowsShipmentValue,
} from '../../../agents';
import { CashCollectionService, cashCollectionService } from '../../../cod/services/cash-collection.service';
import {
  CodExposureService,
  codExposureService,
  CodCapacityVerdict,
} from '../../../cod/services/cod-exposure.service';

/**
 * The contract-term gates on giving a shipment to an agent, in the order they
 * are applied.
 */
export type ContractPolicyGateName =
  | 'contract_active'
  | 'coverage_region'
  | 'shipment_value_ceiling'
  | 'cod_exposure';

/**
 * Four outcomes, not two.
 *
 * `skipped` and `not_applicable` are deliberately distinct: the first means the
 * caller did not supply what the gate needs (no shipment, so no delivery region
 * to test), the second means the gate does not apply to this shipment at all (a
 * prepaid order has no cash to cap). Collapsing them would tell an operator a
 * rule passed when it was never run.
 */
export type GateStatus = 'passed' | 'failed' | 'skipped' | 'not_applicable';

/** A remedy an operator can actually act on, as a code plus its numbers. */
export interface GateRemedy {
  action:
    | 'deposit_cash'
    | 'raise_trust_score'
    | 'raise_contract_threshold'
    | 'resolve_cash_shortfall'
    | 'add_coverage_region'
    | 'raise_shipment_value_ceiling'
    | 'activate_contract'
    | 'wait_for_deliveries';
  /** Whatever the action needs — an amount, a target score, a region key. */
  params?: Record<string, unknown>;
}

export interface ContractPolicyGate {
  gate: ContractPolicyGateName;
  status: GateStatus;
  /**
   * The stable code this gate refuses with, matching the `ERROR_CODES` value the
   * assert path throws. Null unless `status` is `failed`.
   *
   * ⚠ A CODE, never prose — the eligibility service's rule, and the reason is the
   * same: this is analysed and translated downstream. The English lives in
   * `summary`, which exists only because the surface consuming it is an internal
   * admin console. Do not put a sentence here.
   */
  reason: string | null;
  /** What the rule actually saw — makes a refusal explainable without a re-run. */
  observed: Record<string, unknown>;
  /** One English line for the admin console. Never parsed, never translated. */
  summary: string;
  remedies: GateRemedy[];
}

export interface ContractPolicyResult {
  agentId: string;
  agencyId: string;
  shipmentId: string | null;
  /** True only when no gate is `failed`. Skipped gates do not make it false. */
  allowed: boolean;
  gates: ContractPolicyGate[];
  /** The contract the gates were evaluated against, when there is an active one. */
  contract: {
    contractId: string;
    status: string;
    codThreshold: number;
    outstandingBalance: number;
    shipmentValueCeiling: number | null;
    coverageRegions: string[];
  } | null;
  /** The shipment's monetary value, or null when it could not be computed. */
  shipmentValue: number | null;
  paymentMethod: string | null;
  /**
   * The same numbers as the `cod_exposure` gate's `observed`, typed.
   *
   * Exists so `assert` can throw from the evaluation it already ran instead of
   * re-running it — the gate path must not become more expensive than the chain
   * of throws it replaced.
   */
  codVerdict: CodCapacityVerdict | null;
}

/**
 * ContractPolicyService — every contract-term gate on giving THIS shipment to
 * THIS agent, in one place, evaluated two ways.
 *
 * ── Why this was extracted ──────────────────────────────────────────────────
 *
 * These four rules used to live inline in `ShipmentAssignmentService.assert-
 * ContractPolicy`, as a chain of throws. That is the right shape for a gate and
 * the wrong shape for an explanation: a chain of throws can only ever report the
 * FIRST refusal, and it reports it as an exception rather than as a set of
 * numbers. The admin assignability diagnostic needs every gate and every number.
 *
 * The alternative — a second implementation behind the diagnostic — is the one
 * thing this module's own route header warns against, and for a sharper reason
 * here than usual: a drifted diagnostic does not fail, it lies. An operator
 * reads it, believes it, and tells an agency something untrue about their agent.
 * So `assert` is a thin throw over `evaluate`, and nothing anywhere else may
 * re-derive one of these rules.
 *
 * ── Order is meaning ────────────────────────────────────────────────────────
 *
 * Cheapest and most-explanatory first: contract, then coverage, then value, then
 * cash. An operator reading "outside their coverage" learns more than one
 * reading "over their COD limit" for the same shipment — and the cash gate is
 * the only one that costs queries.
 */
export class ContractPolicyService {
  constructor(
    private readonly contracts: AgentContractRepository = agentContractRepository,
    private readonly cashCollection: CashCollectionService = cashCollectionService,
    private readonly exposure: CodExposureService = codExposureService
  ) {}

  /**
   * Every gate, evaluated without throwing.
   *
   * @param shipment null to ask the agent-and-agency question on its own — "could
   *        this agent take COD work from this agency at all right now?". The two
   *        shipment-scoped gates then report `skipped` rather than guessing, and
   *        the cash gate runs with an additional amount of zero, which is exactly
   *        the "is he already over his limit" question support asks first.
   * @param opts.full report every number even once something has already
   *        refused. OFF for the gate, which must stay as cheap as the chain of
   *        throws it replaced; ON for the diagnostic, which exists precisely to
   *        report what a short-circuit hides.
   */
  async evaluate(
    agent: IDeliveryAgent,
    agencyId: string,
    shipment: IShipment | null,
    order: IOrder | null,
    opts: { full?: boolean } = {}
  ): Promise<ContractPolicyResult> {
    const agentId = agent._id.toString();
    const contract = await this.contracts.findActive(agentId, agencyId);

    const gates: ContractPolicyGate[] = [await this.gateContractActive(agentId, agencyId, contract, opts.full)];
    let codVerdict: CodCapacityVerdict | null = null;

    const shipmentValue = shipment && order ? this.resolveShipmentValue(order, shipment) : null;
    const paymentMethod = order?.payment_method ?? null;

    if (!contract) {
      // Nothing below can be evaluated against terms that do not exist. Reporting
      // them as passed would be a lie; reporting them as failed would send an
      // operator to fix a coverage list on a contract nobody signed.
      gates.push(
        this.skipped('coverage_region', 'No active contract to read coverage from.'),
        this.skipped('shipment_value_ceiling', 'No active contract to read a value ceiling from.'),
        this.skipped('cod_exposure', 'No active contract, so no COD threshold applies to this agency.')
      );
    } else {
      gates.push(this.gateCoverage(contract, order));
      gates.push(this.gateValueCeiling(contract, shipmentValue, shipment !== null));
      const cod = await this.gateCodExposure(agent, contract, shipmentValue, order, shipment !== null, opts.full);
      codVerdict = cod.verdict;
      gates.push(cod.gate);
    }

    return {
      agentId,
      agencyId,
      shipmentId: shipment ? shipment._id.toString() : null,
      allowed: gates.every((g) => g.status !== 'failed'),
      gates,
      contract: contract
        ? {
            contractId: contract._id.toString(),
            status: contract.status,
            codThreshold: contract.cod?.threshold ?? 0,
            outstandingBalance: contract.cod?.outstanding_balance ?? 0,
            shipmentValueCeiling: contract.shipment_value_ceiling ?? null,
            coverageRegions: contract.coverage?.regions ?? [],
          }
        : null,
      shipmentValue,
      paymentMethod,
      codVerdict,
    };
  }

  /**
   * The gate form, for command paths. Throws the FIRST failure with exactly the
   * code, status and `details` each rule threw before this service existed —
   * those shapes are consumed by three dashboards and are not free to change.
   */
  async assert(
    agent: IDeliveryAgent,
    agencyId: string,
    shipment: IShipment,
    order: IOrder
  ): Promise<void> {
    const result = await this.evaluate(agent, agencyId, shipment, order, { full: false });
    const failed = result.gates.find((g) => g.status === 'failed');
    if (!failed) return;

    switch (failed.gate) {
      case 'contract_active':
        throw createAppError(ERROR_CODES.AGENT_MEMBERSHIP_NOT_APPROVED, 422, undefined, {
          agentId: result.agentId,
          agencyId,
        });

      case 'coverage_region':
        throw createAppError(ERROR_CODES.CONTRACT_COVERAGE_REGION_NOT_COVERED, 422, undefined, {
          deliveryRegion: failed.observed.deliveryRegion,
          coveredRegions: failed.observed.coveredRegions,
          hint: 'This delivery is outside the regions this contract covers.',
        });

      case 'shipment_value_ceiling':
        throw createAppError(ERROR_CODES.CONTRACT_SHIPMENT_VALUE_EXCEEDED, 422, undefined, {
          shipmentValue: failed.observed.shipmentValue,
          ceiling: failed.observed.ceiling,
          hint: 'This shipment is worth more than this contract allows for a single delivery.',
        });

      case 'cod_exposure':
        // Thrown from the verdict `evaluate` already produced — NOT by calling
        // `assertCanTakeCodShipment`, which would evaluate a second time. The
        // three failure shapes stay `CodExposureService`'s, which owns them.
        this.exposure.assertVerdict(result.codVerdict!);
        return;
    }
  }

  // ─── Gates ────────────────────────────────────────────────────────────────

  /**
   * An ACTIVE contract with the dispatching agency.
   *
   * When there is none AND the caller asked for the full picture, this goes one
   * query further than the gate ever did and reports what contracts DO exist
   * with this agency. "Never approved" and "you paused it yourself last Tuesday"
   * send an operator to different places, and the gate could not tell them
   * apart. The gate path skips that query — it is about to throw either way.
   */
  private async gateContractActive(
    agentId: string,
    agencyId: string,
    contract: IAgentAgencyMembership | null,
    full = false
  ): Promise<ContractPolicyGate> {
    if (contract) {
      return {
        gate: 'contract_active',
        status: 'passed',
        reason: null,
        observed: { contractId: contract._id.toString(), status: contract.status },
        summary: 'An active contract with this agency is in place.',
        remedies: [],
      };
    }

    const withAgency = full
      ? (await this.contracts.listAllForAgent(agentId))
          .filter((c) => c.agency_id.toString() === agencyId)
          .map((c) => ({ contractId: c._id.toString(), status: c.status }))
      : [];

    return {
      gate: 'contract_active',
      status: 'failed',
      reason: ERROR_CODES.AGENT_MEMBERSHIP_NOT_APPROVED,
      observed: { activeContract: null, otherContractsWithThisAgency: full ? withAgency : null },
      summary: !full
        ? 'There is no active contract between this agent and this agency.'
        : withAgency.length === 0
          ? 'This agent has no contract with this agency at all.'
          : `This agent has a contract with this agency, but it is ${withAgency
              .map((c) => c.status)
              .join(' / ')} rather than active.`,
      remedies: [{ action: 'activate_contract', params: { contracts: withAgency } }],
    };
  }

  /** Does the contract's coverage list include the delivery's region? */
  private gateCoverage(contract: IAgentAgencyMembership, order: IOrder | null): ContractPolicyGate {
    if (!order) return this.skipped('coverage_region', 'No shipment supplied, so there is no delivery region to test.');

    const deliveryRegion = order.delivery_address?.components?.region ?? null;
    const countryCode = order.delivery_address?.components?.country_code ?? null;
    const coveredRegions = contract.coverage?.regions ?? [];
    const passed = contractCoversRegion(contract.coverage, deliveryRegion, countryCode);

    return {
      gate: 'coverage_region',
      status: passed ? 'passed' : 'failed',
      reason: passed ? null : ERROR_CODES.CONTRACT_COVERAGE_REGION_NOT_COVERED,
      observed: { deliveryRegion, countryCode, coveredRegions },
      summary: passed
        ? coveredRegions.length === 0
          ? 'This contract declares no coverage regions, which means no restriction.'
          : `The delivery region (${deliveryRegion ?? 'unknown'}) is covered by this contract.`
        : `The delivery region (${deliveryRegion ?? 'unknown'}) is not in this contract's coverage list.`,
      remedies: passed ? [] : [{ action: 'add_coverage_region', params: { region: deliveryRegion } }],
    };
  }

  /** Is one package worth little enough for this contract to carry? */
  private gateValueCeiling(
    contract: IAgentAgencyMembership,
    shipmentValue: number | null,
    hasShipment: boolean
  ): ContractPolicyGate {
    if (!hasShipment) {
      return this.skipped('shipment_value_ceiling', 'No shipment supplied, so there is no value to test.');
    }

    const ceiling = contract.shipment_value_ceiling ?? null;
    const passed = contractAllowsShipmentValue(ceiling, shipmentValue);

    return {
      gate: 'shipment_value_ceiling',
      status: passed ? 'passed' : 'failed',
      reason: passed ? null : ERROR_CODES.CONTRACT_SHIPMENT_VALUE_EXCEEDED,
      observed: { shipmentValue, ceiling },
      summary:
        ceiling === null
          ? 'This contract sets no per-shipment value ceiling.'
          : shipmentValue === null
            ? 'The shipment could not be valued, so the ceiling was not applied — this gate fails open.'
            : passed
              ? `The shipment is worth ${shipmentValue}, within this contract's ceiling of ${ceiling}.`
              : `The shipment is worth ${shipmentValue}, more than this contract's ceiling of ${ceiling}.`,
      remedies: passed ? [] : [{ action: 'raise_shipment_value_ceiling', params: { required: shipmentValue } }],
    };
  }

  /**
   * The cash gate — the whole COD verdict, not just its boolean.
   *
   * With `full` on, an agent refused for trust still gets their cash picture
   * reported. That is the opposite of what the dispatch path wants, and it is
   * the entire difference between a gate and a diagnostic.
   */
  private async gateCodExposure(
    agent: IDeliveryAgent,
    contract: IAgentAgencyMembership,
    shipmentValue: number | null,
    order: IOrder | null,
    hasShipment: boolean,
    full = false
  ): Promise<{ gate: ContractPolicyGate; verdict: CodCapacityVerdict | null }> {
    if (hasShipment && order?.payment_method !== 'cash_on_delivery') {
      return {
        verdict: null,
        gate: {
          gate: 'cod_exposure',
          status: 'not_applicable',
          reason: null,
          observed: { paymentMethod: order?.payment_method ?? null },
          summary: 'This shipment is not cash on delivery, so no cash limit applies to it.',
          remedies: [],
        },
      };
    }

    const threshold = contract.cod?.threshold ?? 0;
    // Zero when no shipment was supplied: the question becomes "is this agent
    // already at or over their limit", which is what support asks first.
    const additional = hasShipment ? (shipmentValue ?? 0) : 0;
    const verdict = await this.exposure.evaluate(agent, additional, threshold, { full });

    return {
      verdict,
      gate: {
        gate: 'cod_exposure',
        status: verdict.allowed ? 'passed' : 'failed',
        reason: verdict.allowed ? null : this.codReasonCode(verdict),
        observed: {
          blocker: verdict.blocker,
          additionalAmount: verdict.additionalAmount,
          exposure: verdict.exposure,
          limit: verdict.limit,
          headroom: verdict.headroom,
          depositNeeded: verdict.depositNeeded,
          openCashShortfall: verdict.openCashShortfall,
        },
        summary: this.codSummary(verdict, hasShipment),
        remedies: this.codRemedies(verdict),
      },
    };
  }

  // ─── Explanation helpers ──────────────────────────────────────────────────

  private codReasonCode(verdict: CodCapacityVerdict): string {
    return verdict.blocker === 'exposure_exceeded'
      ? ERROR_CODES.COD_AGENT_EXPOSURE_EXCEEDED
      : ERROR_CODES.COD_AGENT_TRUST_TOO_LOW;
  }

  private codSummary(verdict: CodCapacityVerdict, hasShipment: boolean): string {
    const { limit, exposure } = verdict;
    const tier =
      limit.tier === 'full'
        ? `full trust (${limit.trustScore} ≥ ${limit.fullThreshold}), so the limit is the contract threshold of ${limit.base}`
        : limit.tier === 'reduced'
          ? `reduced trust (${limit.trustScore}, under ${limit.fullThreshold}), so the contract threshold of ${limit.base} is halved to ${limit.effectiveLimit}`
          : `trust below ${limit.reducedThreshold} (${limit.trustScore}), which blocks COD entirely`;

    switch (verdict.blocker) {
      case 'trust_too_low':
        return `Refused on trust: ${tier}.`;
      case 'open_cash_shortfall':
        return 'Refused on an open cash-shortfall discrepancy — it must be resolved before this agent takes new COD work.';
      case 'exposure_exceeded':
        return (
          `Refused on cash: the agent is already exposed to ${exposure!.total} ` +
          `(${exposure!.cashHeld} held plus ${exposure!.pendingCollections.total} expected from ` +
          `${exposure!.pendingCollections.count} undelivered package(s), across every agency they serve)` +
          (hasShipment ? ` and this shipment adds ${verdict.additionalAmount}` : '') +
          `, against a limit of ${limit.effectiveLimit} — ${tier}.`
        );
      default:
        // `exposure` is null only on the gate path, where nothing renders this.
        return exposure === null
          ? `Within limits — ${tier}.`
          : `Within limits: exposed to ${exposure.total} against ${limit.effectiveLimit}, ` +
            `leaving ${verdict.headroom} of headroom — ${tier}.`;
    }
  }

  private codRemedies(verdict: CodCapacityVerdict): GateRemedy[] {
    if (verdict.allowed) return [];

    if (verdict.blocker === 'open_cash_shortfall') {
      return [{ action: 'resolve_cash_shortfall' }];
    }

    const remedies: GateRemedy[] = [];

    if (verdict.depositNeeded && verdict.depositNeeded > 0) {
      remedies.push({ action: 'deposit_cash', params: { amount: verdict.depositNeeded } });
    }

    // Only worth offering when it would actually change the answer. Raising a
    // score that is already at the full tier buys nothing, and offering it there
    // sends an operator to adjust trust for no reason.
    if (verdict.limit.tier !== 'full') {
      const wouldBecome = verdict.limit.base;
      const enough =
        verdict.exposure === null || verdict.exposure.total + verdict.additionalAmount <= wouldBecome;
      remedies.push({
        action: 'raise_trust_score',
        params: { to: verdict.limit.fullThreshold, from: verdict.limit.trustScore, wouldRaiseLimitTo: wouldBecome, sufficientOnItsOwn: enough },
      });
    }

    remedies.push({
      action: 'raise_contract_threshold',
      params: {
        current: verdict.limit.contractThreshold,
        // What the threshold would have to become for the CURRENT exposure to
        // fit, given the multiplier that will be applied to it.
        requiredForCurrentExposure:
          verdict.exposure && verdict.limit.multiplier > 0
            ? Math.ceil((verdict.exposure.total + verdict.additionalAmount) / verdict.limit.multiplier)
            : null,
        note: 'Bounded by the agent COD pool — see GET /api/internal/admin/agents/:agentId/cod-allocation for the headroom.',
      },
    });

    remedies.push({ action: 'wait_for_deliveries' });
    return remedies;
  }

  private skipped(gate: ContractPolicyGateName, summary: string): ContractPolicyGate {
    return { gate, status: 'skipped', reason: null, observed: {}, summary, remedies: [] };
  }

  /**
   * A shipment's monetary value, or null when it cannot be determined.
   *
   * `computeExpectedAmount` THROWS `ORDER_ITEM_NOT_FOUND` (500) when a shipment
   * references an order item that no longer exists. On the COD path that throw
   * was always reachable and is arguably right — no cash figure, no collection.
   * Now that every payment method consults it for the value ceiling, an
   * unguarded call would turn a corrupt prepaid shipment into a 500 on accept
   * and would kill an entire `buildRanking`, leaving a shipment with no
   * candidates and no explanation.
   *
   * So it fails open, loudly. A bookkeeping inconsistency must not be able to
   * block a delivery through a cap that was never about it.
   */
  private resolveShipmentValue(order: IOrder, shipment: IShipment): number | null {
    try {
      return this.cashCollection.computeExpectedAmount(order, shipment);
    } catch (error) {
      console.error(
        `[ContractPolicyService] Could not value shipment ${shipment._id.toString()} ` +
          `on order ${order._id.toString()} — value-ceiling and COD checks will be skipped:`,
        error
      );
      return null;
    }
  }
}

export const contractPolicyService = new ContractPolicyService();
