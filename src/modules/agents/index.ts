/**
 * Agent domain — public surface.
 *
 * Other modules import from here, not from files inside the module. Reaching
 * past this barrel couples callers to internal layout and is what turned the
 * old agent code into something spread across delivery/, cod/ and shipments/.
 *
 * The domain owns:
 *   - the agent identity, profile, preferences and settings
 *   - agent↔agency memberships (an agent may serve several agencies)
 *   - availability (declared) and working state (derived)
 *   - the tracking-allow business flag  — geo-tracker enforces, never decides
 *   - device capabilities and the business mirror of tracking state
 *   - assignment eligibility
 */

// ─── Models & types ──────────────────────────────────────────────────────────
export {
  DeliveryAgentModel,
  agentDefaults,
} from './models/agent.model';
export type {
  IDeliveryAgent,
  IAgentVehicleInfo,
  IAgentLegalIdentity,
  IAgentEmergencyContact,
  IAgentAvailability,
  IAgentWorkingState,
  IAgentTracking,
  IAgentDeviceCapabilities,
  IAgentLastKnownTrackingState,
  IAgentPreferences,
  IAgentSettings,
  IAgentCodProfile,
  AgentStatus,
  AgentAvailabilityState,
  AgentWorkingState,
  AgentDevicePlatform,
  AgentLocationPermission,
  AgentTrackingStateStatus,
} from './models/agent.model';

export {
  AgentAgencyMembershipModel,
  AgentAgencyContractModel,
  LIVE_MEMBERSHIP_STATUSES,
  ALLOCATING_CONTRACT_STATUSES,
  NEGOTIABLE_TERM_GROUPS,
  AGENT_NEGOTIABLE_TERM_GROUPS,
} from './models/agent-agency-membership.model';
export type {
  IAgentAgencyMembership,
  MembershipStatus,
  MembershipOrigin,
  EmploymentType,
  IMembershipEmployment,
  ContractTermsParty,
  NegotiableTermGroup,
} from './models/agent-agency-membership.model';

export { AgentMembershipEventModel } from './models/agent-membership-event.model';
export type { IAgentMembershipEvent, MembershipEventType } from './models/agent-membership-event.model';

/**
 * Exported for the notification catalogs, which keep a localized label per
 * transition and per resolution. Typing those tables on these unions rather than
 * on `string` is the point: adding a transition then fails the build in the
 * catalogs instead of silently rendering an untranslated English enum value.
 */
export type {
  ContractTransition,
  StatusRequestState,
  ContractParty,
} from './models/contract-status-request.model';

/**
 * Terms negotiation. `TermsProposalState` is exported for the same reason as
 * `StatusRequestState` above — the notification catalogs key a localized label
 * table on it, so adding a state fails the build there rather than rendering an
 * untranslated enum value.
 */
export {
  ContractTermsProposalModel,
} from './models/contract-terms-proposal.model';
export type {
  IContractTermsProposal,
  TermsProposalState,
  ProposedTerms,
} from './models/contract-terms-proposal.model';
export {
  ContractTermsProposalRepository,
  contractTermsProposalRepository,
} from './repositories/contract-terms-proposal.repository';
export {
  ContractTermsProposalMapper,
  diffTerms,
} from './dto/contract-terms-proposal.dto';
export type {
  ContractTermsProposalDto,
  TermsProposalAction,
  TermsProposalViewer,
  TermsDiffEntry,
} from './dto/contract-terms-proposal.dto';

// ─── Repositories ────────────────────────────────────────────────────────────
export { AgentRepository, agentRepository } from './repositories/agent.repository';
export {
  AgentContractRepository,
  agentContractRepository,
  // Aliases kept so COD/shipments call sites that still speak "membership"
  // keep working while the contract rename settles. Prefer the contract names.
  AgentMembershipRepository,
  agentMembershipRepository,
} from './repositories/agent-contract.repository';
export {
  AgentCodThresholdService,
  agentCodThresholdService,
} from './domain/services/agent-cod-threshold.service';
export type { ThresholdAllocation } from './domain/services/agent-cod-threshold.service';
export {
  AgentCapacityService,
  agentCapacityService,
} from './domain/services/agent-capacity.service';
export type { CapacityReleaseReason } from './domain/services/agent-capacity.service';
export { AgentGateService, agentGateService } from './domain/services/agent-gate.service';
export type { GateResult, GateFailure } from './domain/services/agent-gate.service';
export {
  AgentMembershipEventRepository,
  agentMembershipEventRepository,
} from './repositories/agent-membership-event.repository';

// ─── Services ────────────────────────────────────────────────────────────────
export { AgentProfileService, agentProfileService } from './domain/services/agent-profile.service';
export {
  AgentContractService,
  agentContractService,
} from './domain/services/agent-contract.service';
export type { Actor } from './domain/services/agent-contract.service';
export {
  AgentAvailabilityService,
  agentAvailabilityService,
} from './domain/services/agent-availability.service';
export {
  AgentEligibilityService,
  agentEligibilityService,
} from './domain/services/agent-eligibility.service';
export type {
  AgentEligibilityResult,
  EligibilityRuleResult,
  IneligibilityReason,
} from './domain/services/agent-eligibility.service';

/**
 * The two contract terms that constrain WHICH shipments an agent may take.
 * Pure predicates rather than a service — they are consumed by
 * shipment-assignment, which owns the dispatch decision; this module owns only
 * the rule.
 */
export {
  contractCoversRegion,
  contractAllowsShipmentValue,
} from './domain/services/contract-coverage.service';

/**
 * When cash collected under a contract falls due. Consumed by the COD
 * late-deposit sweep — this module owns the negotiated cadence, cod/ owns the
 * cash chain that answers to it.
 */
export {
  nextRemittanceDueAt,
  isRemittanceOverdue,
} from './domain/services/remittance-schedule.service';
export {
  AgentTrackingPolicyService,
  agentTrackingPolicyService,
} from './domain/services/agent-tracking-policy.service';
export type { AgentTrackingPolicy } from './domain/services/agent-tracking-policy.service';
export { AgentDeviceService, agentDeviceService } from './domain/services/agent-device.service';

// ─── Ports (geo-tracker integration seams) ───────────────────────────────────
export type { IAgentDeviceLocationProvider } from './ports/device-location.port';
export {
  SelfReportedDeviceLocationProvider,
  NullDeviceLocationProvider,
  setDeviceLocationProvider,
  getDeviceLocationProvider,
} from './ports/device-location.port';

// ─── DTOs ────────────────────────────────────────────────────────────────────
export { AgentProfileMapper } from './dto/agent-profile.dto';
export type {
  GetAgentProfileResponseDto,
  AgentCompletionStatusDto,
  AgentRosterEntryDto,
  AgentTrackingDto,
  AgentTrackingStateDto,
} from './dto/agent-profile.dto';
export { AgentMembershipMapper } from './dto/agent-membership.dto';
export type {
  AgentMembershipDto,
  AgentMembershipWithAgencyDto,
  MembershipEmploymentDto,
  MembershipRemittanceTermsDto,
  MembershipCoverageDto,
  MembershipFeeSplitDto,
  MembershipEventDto,
} from './dto/agent-membership.dto';

// ─── Config ──────────────────────────────────────────────────────────────────
export { AGENT_CONFIG, ACTIVE_SHIPMENT_STATUSES, internalApiEnabled } from './config/agent.config';

// ─── Bootstrap ───────────────────────────────────────────────────────────────
export { initializeAgentDomain } from './agent.bootstrap';

/**
 * ── Routes are deliberately NOT exported here ────────────────────────────────
 *
 * Import them directly from ./routes/* in api/index.ts instead.
 *
 * Routers pull in `requireAuth`, and auth.middleware → auth.service → this
 * barrel. Re-exporting routes closed that into a genuine require cycle:
 * auth.service loaded the barrel, the barrel loaded a router, the router loaded
 * auth.middleware, which called `new AuthService()` on a half-initialised module
 * and crashed at boot with "AuthService is not a constructor".
 *
 * The deeper point: a barrel is the domain's surface for DOMAIN consumers.
 * Transport wiring belongs to the application layer, and mixing the two makes
 * every importer of a type drag in the HTTP stack.
 */
