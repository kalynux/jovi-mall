/**
 * Test: Agent Domain — eligibility rules, tracking policy, working state,
 * membership guards and DTO redaction.
 *
 * Follows the existing scripts/test convention (plain ts-node, hand-rolled
 * asserts, no framework — this project has none, and adding one for a single
 * domain would be a larger decision than this change should make).
 *
 * Everything here is chosen to be DB-free: the pure derivations are extracted
 * onto services precisely so they can be tested without Mongo. Rules that need
 * a database (membership transitions, cash guards) are exercised through the
 * repository seams with in-memory fakes.
 *
 * Run: npx ts-node scripts/test/test-agent-domain.ts   (npm run test:agent-domain)
 */
import { AgentEligibilityService } from '../../src/modules/agents/domain/services/agent-eligibility.service';
import { AgentAvailabilityService } from '../../src/modules/agents/domain/services/agent-availability.service';
import {
    AgentContractService,
    contractTermsOf,
} from '../../src/modules/agents/domain/services/agent-contract.service';
import { AgentTrackingPolicyService } from '../../src/modules/agents/domain/services/agent-tracking-policy.service';
import { AgentDepositService } from '../../src/modules/cod/services/agent-deposit.service';
import { CashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { EarningsSplitService, resolveEarnedFee } from '../../src/modules/earnings/services/earnings-split.service';
import { EarningsQuoteService } from '../../src/modules/earnings/services/earnings-quote.service';
import { OrderCompletionService } from '../../src/modules/orders/order-completion.service';
import { AppError } from '../../src/core/errors';
import { AgentProfileMapper } from '../../src/modules/agents/dto/agent-profile.dto';
import { AgentMembershipMapper } from '../../src/modules/agents/dto/agent-membership.dto';
import { AgentDirectoryMapper } from '../../src/modules/agents/dto/agent-directory.dto';
import {
    AgentAgencyContractModel,
    LIVE_CONTRACT_STATUSES,
    ALLOCATING_CONTRACT_STATUSES,
    COUNTED_CONTRACT_STATUSES,
} from '../../src/modules/agents/models/agent-agency-membership.model';
import { ContractStatusRequestModel } from '../../src/modules/agents/models/contract-status-request.model';
import {
    ContractTermsProposalMapper,
    diffTerms,
} from '../../src/modules/agents/dto/contract-terms-proposal.dto';
import {
    nextRemittanceDueAt,
    isRemittanceOverdue,
} from '../../src/modules/agents/domain/services/remittance-schedule.service';
import {
    contractCoversRegion,
    contractAllowsShipmentValue,
    normalizeContractRegions,
} from '../../src/modules/agents/domain/services/contract-coverage.service';
import { AgentMembershipEventModel } from '../../src/modules/agents/models/agent-membership-event.model';
import {
    setDeviceLocationProvider,
    NullDeviceLocationProvider,
    SelfReportedDeviceLocationProvider,
    IAgentDeviceLocationProvider,
} from '../../src/modules/agents/ports/device-location.port';
import { AGENT_CONFIG } from '../../src/modules/agents/config/agent.config';
import {
    SetKycStatusSchema,
    SetPlatformBanSchema,
    SetAgentThresholdSchema,
    RequestTransitionSchema,
    ListMembershipsQuerySchema,
    ResolveStatusRequestSchema,
    CancelStatusRequestSchema,
} from '../../src/modules/agents/validators/agent.validator';
import { AgentContractRepository } from '../../src/modules/agents/repositories/agent-contract.repository';
import {
    assertAgentCatalogComplete,
    renderAgentInApp,
} from '../../src/modules/notifications/catalog/agent-notification-catalog';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then((ok) => {
            if (ok) {
                console.log(`  ✅ ${name}`);
                passed++;
            } else {
                console.error(`  ❌ FAIL: ${name}`);
                failed++;
            }
        })
        .catch((err) => {
            console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
            failed++;
        });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(overrides: Record<string, any> = {}): any {
    return {
        _id: { toString: () => overrides.id ?? 'agent-1' },
        name: 'Test Agent',
        email: 'agent@test.com',
        email_verified: true,
        phone: '+237670000001',
        phone_verified: false,
        avatar_url: null,
        vehicle_info: { vehicle_type: 'bike', plate_number: 'ABC-123', color: 'red' },
        legal_identity: { drivers_license_number: 'DL-SECRET', national_id_number: 'NID-SECRET' },
        emergency_contact: null,
        // The agent's own COD pool; every contract threshold is a slice of it.
        cod: { trust_score: 100, max_threshold: 500_000 },
        // Capacity is a maintained COUNTER, agent-level and shared across every
        // agency — not derived, and not sub-allocated per contract. The
        // eligibility rule reads active_shipment_count straight off here, which
        // is why makeEligibility injects it rather than stubbing a query.
        capacity: { max_active_shipments: 5, active_shipment_count: 0, reconciled_at: null },
        // Platform gates. Both are evaluated BEFORE availability/COD/capacity, so
        // a fixture that omits them is ineligible for reasons the test never
        // intended — kyc defaults to 'unverified'.
        kyc: { status: 'verified', verified_at: new Date(), verified_by_user_id: null, rejection_reason: null, reference: null },
        platform_ban: { banned: false, reason: null, banned_at: null, banned_by_user_id: null, lifted_at: null },
        availability: { state: 'online', changed_at: new Date(), reason: null },
        working_state: { state: 'idle', active_shipment_count: 0, computed_at: new Date() },
        tracking: { allowed: true, reason: null, changed_at: new Date(), changed_by_user_id: null, changed_by_role: null },
        device: {
            platform: 'android',
            app_version: '1.0.0',
            location_permission: 'always',
            location_services_enabled: true,
            background_location_enabled: true,
            battery_optimization_exempt: null,
            push_enabled: true,
            reported_at: new Date(),
        },
        last_known_tracking_state: { status: 'unknown', last_position: null, last_reported_at: null, source: null },
        // Notification delivery is AgentNotificationPreference's business; the two
        // notify_* flags that used to sit here gated nothing and were removed.
        preferences: { navigation_app: 'google_maps' },
        // max_concurrent_shipments moved to capacity.max_active_shipments; only
        // auto_accept_assignments is left here.
        settings: { auto_accept_assignments: false },
        wa: { verified: false },
        timezone: 'Africa/Douala',
        preferred_language: 'en',
        status: 'active',
        status_reason: null,
        onboarding_step: 0,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

/**
 * A contract, not a membership flag. `approved` is an ACTION here, not a state —
 * approving lands the contract in `active`, which is what the rules look for.
 */
function makeMembership(overrides: Record<string, any> = {}): any {
    return {
        _id: { toString: () => 'membership-1' },
        agent_id: { toString: () => 'agent-1' },
        agency_id: { toString: () => 'agency-1' },
        status: 'active',
        origin: 'invitation',
        is_primary: true,
        employment: { employment_type: 'contractor', employee_ref: null, started_at: null, ends_at: null },
        // This agency's slice of the agent's pool, plus the cash currently
        // attributable to it. Replaces the old independent max_exposure_override.
        cod: { threshold: 200_000, outstanding_balance: 0, lifetime_settled: 0, last_settled_at: null },
        payment: { outstanding_to_agent: 0, lifetime_paid: 0, last_paid_at: null },
        invited_by_user_id: { toString: () => 'user-9' },
        invited_at: new Date(),
        requested_at: null,
        approved_at: new Date(),
        approved_by_user_id: { toString: () => 'user-9' },
        suspended_at: null,
        suspended_by_user_id: null,
        suspension_reason: null,
        deactivated_at: null,
        deactivated_by_user_id: null,
        deactivation_reason: null,
        transferred_to_agency_id: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

/**
 * Eligibility service wired to fakes: no Mongo, no shipment collection.
 *
 * `activeShipments` is merged onto the agent's capacity counter rather than
 * stubbed as a query. That mirrors the real model — admission control atomically
 * reserves against this counter, and the rule reads the same field, so nothing
 * here can disagree with the thing that actually decides.
 */
function makeEligibility(opts: {
    agent: any | null;
    membership: any | null;
    activeShipments: number;
}) {
    const agent = opts.agent
        ? {
              ...opts.agent,
              capacity: { ...opts.agent.capacity, active_shipment_count: opts.activeShipments },
          }
        : null;
    const agents: any = { findById: async () => agent };
    const memberships: any = {
        findActive: async () => opts.membership,
        listActiveAgentIds: async () => ['agent-1'],
    };
    return new AgentEligibilityService(agents, memberships);
}

async function run(): Promise<void> {
    // ─── Eligibility: the five rules ──────────────────────────────────────────
    console.log('\n── Eligibility rules ──────────────────────────────────────────────────');

    setDeviceLocationProvider(new NullDeviceLocationProvider());

    await assert('a fully-ready agent is eligible', async () => {
        const svc = makeEligibility({ agent: makeAgent(), membership: makeMembership(), activeShipments: 0 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return r.eligible && r.reasons.length === 0;
    });

    await assert('inactive agent is rejected (agent_not_active)', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ status: 'inactive' }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('agent_not_active');
    });

    await assert('suspended agent is rejected', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ status: 'suspended' }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('agent_not_active');
    });

    await assert('no approved membership is rejected (membership_not_approved)', async () => {
        const svc = makeEligibility({ agent: makeAgent(), membership: null, activeShipments: 0 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('membership_not_approved');
    });

    await assert('offline agent is rejected (not_available)', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ availability: { state: 'offline', changed_at: new Date(), reason: null } }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('not_available');
    });

    await assert('on_break counts as unavailable', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ availability: { state: 'on_break', changed_at: new Date(), reason: 'lunch' } }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('not_available');
    });

    await assert('tracking disallowed is rejected (tracking_not_allowed)', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ tracking: { allowed: false, reason: 'privacy request', changed_at: new Date() } }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('tracking_not_allowed');
    });

    await assert('missing agent yields agent_not_found and never throws', async () => {
        const svc = makeEligibility({ agent: null, membership: null, activeShipments: 0 });
        const r = await svc.evaluate('nope', 'agency-1');
        return !r.eligible && r.reasons.includes('agent_not_found');
    });

    // ─── Platform gates (KYC + ban) ───────────────────────────────────────────
    // These outrank everything below them: they are the platform's judgement on
    // the person, not one agency's on a relationship.
    console.log('\n── Platform gates ─────────────────────────────────────────────────────');

    await assert('an unverified agent is rejected (kyc_not_verified)', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ kyc: { status: 'unverified', verified_at: null, rejection_reason: null } }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('kyc_not_verified');
    });

    await assert('a pending KYC is not a verified KYC', async () => {
        const svc = makeEligibility({
            agent: makeAgent({ kyc: { status: 'pending', verified_at: null, rejection_reason: null } }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('kyc_not_verified');
    });

    await assert('a banned agent is rejected (platform_banned)', async () => {
        const svc = makeEligibility({
            agent: makeAgent({
                platform_ban: { banned: true, reason: 'fraud', banned_at: new Date(), lifted_at: null },
            }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('platform_banned');
    });

    // The ban is an override, not a cascade — it does not walk contracts flipping
    // each to paused. So an active contract plus a ban is a REACHABLE state, and
    // the gate is the only thing standing between it and a dispatch.
    await assert('a ban blocks even with an otherwise perfect active contract', async () => {
        const svc = makeEligibility({
            agent: makeAgent({
                platform_ban: { banned: true, reason: 'fraud', banned_at: new Date(), lifted_at: null },
            }),
            membership: makeMembership({ status: 'active' }),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('platform_banned');
    });

    console.log('\n── Eligibility rules (continued) ──────────────────────────────────────');

    await assert('ALL failing rules are reported at once, not just the first', async () => {
        const svc = makeEligibility({
            agent: makeAgent({
                status: 'inactive',
                availability: { state: 'offline', changed_at: new Date(), reason: null },
                tracking: { allowed: false, reason: 'x', changed_at: new Date() },
            }),
            membership: null,
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return (
            r.reasons.includes('agent_not_active') &&
            r.reasons.includes('membership_not_approved') &&
            r.reasons.includes('not_available') &&
            r.reasons.includes('tracking_not_allowed')
        );
    });

    // ─── Multiple active shipments (requirement: more than one is allowed) ────
    console.log('\n── Concurrent shipments ───────────────────────────────────────────────');

    await assert('agent with 3 of 5 active shipments is STILL eligible', async () => {
        const svc = makeEligibility({ agent: makeAgent(), membership: makeMembership(), activeShipments: 3 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return r.eligible && r.activeShipmentCount === 3;
    });

    await assert('agent at their ceiling is rejected (at_capacity)', async () => {
        const svc = makeEligibility({ agent: makeAgent(), membership: makeMembership(), activeShipments: 5 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('at_capacity');
    });

    await assert('per-agent capacity.max_active_shipments is honoured', async () => {
        const svc = makeEligibility({
            agent: makeAgent({
                capacity: { max_active_shipments: 2, active_shipment_count: 0, reconciled_at: null },
            }),
            membership: makeMembership(),
            activeShipments: 2,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('at_capacity') && r.maxConcurrentShipments === 2;
    });

    await assert('a per-agent limit above the platform ceiling is clamped', async () => {
        const svc = makeEligibility({
            agent: makeAgent({
                capacity: { max_active_shipments: 9999, active_shipment_count: 0, reconciled_at: null },
            }),
            membership: makeMembership(),
            activeShipments: 0,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return r.maxConcurrentShipments === AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX;
    });

    // Capacity is global by design: one agent, one pair of hands. It is NOT
    // sub-allocated per agency the way the COD threshold is, so work for another
    // agency still fills the agent up.
    await assert('capacity counts across ALL agencies, not just the dispatching one', async () => {
        const svc = makeEligibility({
            agent: makeAgent({
                capacity: { max_active_shipments: 3, active_shipment_count: 0, reconciled_at: null },
            }),
            membership: makeMembership({ agency_id: { toString: () => 'agency-2' } }),
            activeShipments: 3,
        });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return !r.eligible && r.reasons.includes('at_capacity');
    });

    // ─── Device location: the tri-state contract ──────────────────────────────
    console.log('\n── Device-location signal (geo-tracker seam) ──────────────────────────');

    await assert('unknown (null) does NOT block while the rule is not required', async () => {
        setDeviceLocationProvider(new NullDeviceLocationProvider());
        const svc = makeEligibility({ agent: makeAgent(), membership: makeMembership(), activeShipments: 0 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        return r.eligible;
    });

    await assert('an explicit false ALWAYS blocks, regardless of config', async () => {
        const off: IAgentDeviceLocationProvider = {
            name: 'fake_off',
            isDeviceLocationEnabled: async () => false,
            isDeviceLocationEnabledBatch: async (ids) => new Map(ids.map((i) => [i, false as boolean | null])),
        };
        setDeviceLocationProvider(off);
        const svc = makeEligibility({ agent: makeAgent(), membership: makeMembership(), activeShipments: 0 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        setDeviceLocationProvider(new NullDeviceLocationProvider());
        return !r.eligible && r.reasons.includes('device_location_disabled');
    });

    await assert('a throwing provider degrades to unknown, never to an exception', async () => {
        const broken: IAgentDeviceLocationProvider = {
            name: 'fake_broken',
            isDeviceLocationEnabled: async () => {
                throw new Error('geo-tracker unreachable');
            },
            isDeviceLocationEnabledBatch: async () => {
                throw new Error('geo-tracker unreachable');
            },
        };
        setDeviceLocationProvider(broken);
        const svc = makeEligibility({ agent: makeAgent(), membership: makeMembership(), activeShipments: 0 });
        const r = await svc.evaluate('agent-1', 'agency-1');
        setDeviceLocationProvider(new NullDeviceLocationProvider());
        // A geo-tracker outage must not halt dispatch platform-wide.
        return r.eligible;
    });

    await assert('self-reported provider treats a denied OS permission as off', async () => {
        const provider = new SelfReportedDeviceLocationProvider(async () =>
            makeAgent({
                device: { location_permission: 'denied', location_services_enabled: true },
            })
        );
        return (await provider.isDeviceLocationEnabled('agent-1')) === false;
    });

    await assert('self-reported provider returns null when never reported', async () => {
        const provider = new SelfReportedDeviceLocationProvider(async () =>
            makeAgent({ device: { location_permission: 'unknown', location_services_enabled: null } })
        );
        return (await provider.isDeviceLocationEnabled('agent-1')) === null;
    });

    await assert('self-reported provider returns null for a missing agent', async () => {
        const provider = new SelfReportedDeviceLocationProvider(async () => null);
        return (await provider.isDeviceLocationEnabled('ghost')) === null;
    });

    // ─── Working state derivation ─────────────────────────────────────────────
    console.log('\n── Working state ──────────────────────────────────────────────────────');

    const availability = new AgentAvailabilityService({} as any);

    await assert('0 shipments → idle', () => availability.deriveWorkingState(makeAgent(), 0) === 'idle');
    await assert('1 of 5 → working', () => availability.deriveWorkingState(makeAgent(), 1) === 'working');
    await assert('4 of 5 → working', () => availability.deriveWorkingState(makeAgent(), 4) === 'working');
    await assert('5 of 5 → at_capacity', () => availability.deriveWorkingState(makeAgent(), 5) === 'at_capacity');
    await assert('over ceiling → at_capacity (never negative-capacity)', () =>
        availability.deriveWorkingState(makeAgent(), 99) === 'at_capacity'
    );

    // ─── Tracking policy (what geo-tracker enforces) ──────────────────────────
    console.log('\n── Tracking policy ────────────────────────────────────────────────────');

    const tracking = new AgentTrackingPolicyService({} as any, {} as any);

    await assert('active + allowed + an approved agency → trackingAllowed', () => {
        const p = tracking.buildPolicy(makeAgent(), ['agency-1']);
        return p.trackingAllowed && p.denyReason === null;
    });

    await assert('tracking flag off → denied with tracking_disabled', () => {
        const p = tracking.buildPolicy(
            makeAgent({ tracking: { allowed: false, reason: 'privacy', changed_at: new Date() } }),
            ['agency-1']
        );
        return !p.trackingAllowed && p.denyReason === 'tracking_disabled';
    });

    await assert('inactive account → denied with agent_not_active', () => {
        const p = tracking.buildPolicy(makeAgent({ status: 'inactive' }), ['agency-1']);
        return !p.trackingAllowed && p.denyReason === 'agent_not_active';
    });

    await assert('no approved agency → denied (nobody may watch an unaffiliated person)', () => {
        const p = tracking.buildPolicy(makeAgent(), []);
        return !p.trackingAllowed && p.denyReason === 'no_approved_agency';
    });

    await assert('policy carries the note explaining a manual revocation', () => {
        const p = tracking.buildPolicy(
            makeAgent({ tracking: { allowed: false, reason: 'court order', changed_at: new Date() } }),
            ['agency-1']
        );
        return p.note === 'court order';
    });

    // ─── Tracking-state staleness ─────────────────────────────────────────────
    console.log('\n── Tracking-state mirror ──────────────────────────────────────────────');

    await assert('a never-reported mirror is stale', () =>
        tracking.isTrackingStateStale(makeAgent())
    );

    await assert('a fresh report is not stale', () =>
        !tracking.isTrackingStateStale(
            makeAgent({
                last_known_tracking_state: { status: 'streaming', last_reported_at: new Date(), last_position: null, source: 'geo_tracker' },
            })
        )
    );

    await assert('a stored "streaming" degrades to "stale" once old — it never lies', () => {
        const old = new Date(Date.now() - (AGENT_CONFIG.TRACKING_STATE_STALE_AFTER_SECONDS + 60) * 1000);
        const agent = makeAgent({
            last_known_tracking_state: { status: 'streaming', last_reported_at: old, last_position: null, source: 'geo_tracker' },
        });
        return tracking.effectiveTrackingStateStatus(agent) === 'stale';
    });

    await assert('the DTO applies the same staleness correction as the service', () => {
        const old = new Date(Date.now() - (AGENT_CONFIG.TRACKING_STATE_STALE_AFTER_SECONDS + 60) * 1000);
        const dto = AgentProfileMapper.toTrackingStateDto(
            makeAgent({
                last_known_tracking_state: { status: 'streaming', last_reported_at: old, last_position: null, source: 'geo_tracker' },
            })
        );
        return dto.status === 'stale' && dto.isStale === true;
    });

    // ─── DTO redaction ────────────────────────────────────────────────────────
    console.log('\n── DTO security ───────────────────────────────────────────────────────');

    const dto = AgentProfileMapper.toResponseDto(makeAgent());
    const serialized = JSON.stringify(dto);

    await assert('legal_identity is never exposed on the profile DTO', () =>
        !('legalIdentity' in dto) && !('legal_identity' in dto)
    );
    await assert("the driver's licence number never leaks through serialization", () =>
        !serialized.includes('DL-SECRET')
    );
    await assert('the national id number never leaks through serialization', () =>
        !serialized.includes('NID-SECRET')
    );
    await assert('the profile DTO carries no agencyId (an agent may have several)', () =>
        !('agencyId' in dto)
    );
    await assert('tracking allow is exposed for the agent to see', () =>
        dto.tracking.allowed === true
    );

    const rosterDto = AgentProfileMapper.toRosterEntryDto(makeAgent());
    await assert('roster entry exposes no legal identity either', () =>
        !JSON.stringify(rosterDto).includes('SECRET')
    );

    const membershipDto = AgentMembershipMapper.toDto(makeMembership());
    await assert('membership DTO omits actor user ids (cross-role identity leak)', () => {
        const s = JSON.stringify(membershipDto);
        return !s.includes('user-9') && !('approvedByUserId' in membershipDto);
    });
    await assert("membership DTO exposes this contract's COD slice, not a cap", () =>
        membershipDto.codThreshold === 200_000 && 'codOutstandingBalance' in membershipDto
    );
    await assert('membership DTO no longer carries the old independent override', () =>
        !('codMaxExposureOverride' in membershipDto) &&
        !JSON.stringify(membershipDto).includes('maxExposureOverride')
    );

    // ─── Contract settlement + the §4 termination gate ────────────────────────
    // These two fields were dead until the settlement work: nothing wrote them,
    // so evaluateDeactivationBlockers always returned clear and the gate was
    // decorative. Both directions are asserted here because "may this contract
    // end?" is the question the whole lifecycle is built around.
    console.log('\n── Contract settlement (§4 gate) ──────────────────────────────────────');

    const contractSvc = new AgentContractService(
        {} as any, {} as any, {} as any, {} as any, {} as any, {} as any
    );

    await assert('a contract owing nothing in either direction is clear to end', async () => {
        const b = await contractSvc.evaluateDeactivationBlockers(makeMembership());
        return b.clear && b.outstandingCod === 0 && b.outstandingPayment === 0;
    });

    await assert('cash the agent still holds blocks termination', async () => {
        const b = await contractSvc.evaluateDeactivationBlockers(
            makeMembership({ cod: { threshold: 200_000, outstanding_balance: 50_000 } })
        );
        return !b.clear && b.outstandingCod === 50_000;
    });

    await assert('wages the agency still owes block termination too', async () => {
        const b = await contractSvc.evaluateDeactivationBlockers(
            makeMembership({ payment: { outstanding_to_agent: 12_000, lifetime_paid: 0, last_paid_at: null } })
        );
        return !b.clear && b.outstandingPayment === 12_000;
    });

    await assert('both blockers are reported together, not one at a time', async () => {
        const b = await contractSvc.evaluateDeactivationBlockers(
            makeMembership({
                cod: { threshold: 200_000, outstanding_balance: 50_000 },
                payment: { outstanding_to_agent: 12_000, lifetime_paid: 0, last_paid_at: null },
            })
        );
        return !b.clear && b.outstandingCod === 50_000 && b.outstandingPayment === 12_000;
    });

    // ─── Deposit attribution ──────────────────────────────────────────────────
    console.log('\n── Deposit attribution ────────────────────────────────────────────────');

    interface DepositWorld {
        agentCashHeld: number;
        contractOutstanding: number;
        /** What the agency still owes the platform — only the direct route reads it. */
        agencyOwesPlatform?: number;
    }

    /** Deposit service wired to fakes; every assert throws before any DB work. */
    function makeDeposits(opts: DepositWorld) {
        return new AgentDepositService(
            {
                // Keyed on ownerType: the agent's pot and the agency's debt to the
                // platform are different questions, and the direct-payment guard
                // asks the second one. A fake that answered both the same would
                // make that guard untestable.
                getBalance: async (ownerType: string) => ({
                    balance:
                        ownerType === 'agency'
                            ? opts.agencyOwesPlatform ?? 0
                            : opts.agentCashHeld,
                    currency: 'XAF',
                }),
            } as any,
            { findById: async () => makeAgent() } as any,
            {
                findLive: async () =>
                    makeMembership({
                        cod: { threshold: 500_000, outstanding_balance: opts.contractOutstanding },
                    }),
            } as any
        );
    }

    async function depositErrorCode(
        opts: DepositWorld,
        amount: number,
        recipient: 'agency' | 'platform' = 'agency'
    ): Promise<string | null> {
        try {
            await makeDeposits(opts).record({
                agencyId: 'agency-1',
                agentId: 'agent-1',
                amount,
                recipient,
                reference: recipient === 'platform' ? 'TRF-1' : null,
                recordedByUserId: 'user-1',
            });
            return null;
        } catch (err) {
            return (err as AppError).code ?? null;
        }
    }

    // THE multi-agency guard. The agent's pot covers 150k, so the old
    // pot-only check would have waved this through and drawn 150k off a
    // contract owed 100k — booking another agency's cash against this one.
    await assert('an agency cannot bank cash the agent holds for a DIFFERENT agency', async () =>
        (await depositErrorCode({ agentCashHeld: 300_000, contractOutstanding: 100_000 }, 150_000)) ===
        'CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING'
    );

    // The guard must be `>`, never `>=`: settling a contract in FULL is the
    // normal way it reaches zero, and it is the only way a contract ever becomes
    // terminable. An off-by-one here would strand every agent at their last
    // franc, permanently. (This gets past the guard and dies on the DB instead —
    // the assertion is only that it is not refused for the wrong reason.)
    await assert('settling a contract in full is allowed — the guard is >, not >=', async () =>
        (await depositErrorCode({ agentCashHeld: 100_000, contractOutstanding: 100_000 }, 100_000)) !==
        'CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING'
    );

    await assert('the physical-pot check still fires first when the agent holds less', async () =>
        (await depositErrorCode({ agentCashHeld: 40_000, contractOutstanding: 100_000 }, 50_000)) ===
        'COD_DEPOSIT_EXCEEDS_BALANCE'
    );

    await assert('a zero or negative deposit is refused before anything else', async () =>
        (await depositErrorCode({ agentCashHeld: 100_000, contractOutstanding: 100_000 }, 0)) ===
        'COD_DEPOSIT_INVALID_AMOUNT'
    );

    // ─── Direct-to-platform deposits (the agency bypass) ──────────────────────
    // An agent may pay the platform directly. That settles BOTH legs at once —
    // the agent's liability and the agency's — so it is only meaningful while
    // the platform is actually still owed the cash.
    console.log('\n── Direct-to-platform deposits ────────────────────────────────────────');

    // THE guard. Agencies are liable whether or not their agent has paid up, so a
    // diligent one may already have remitted this cash from its own pocket. Then
    // the platform is square and the agent's debt is genuinely to the AGENCY —
    // taking the money here would leave the platform holding it twice and owing
    // the agency a refund, which this ledger does not model.
    await assert('the platform refuses cash the agency has already remitted', async () =>
        (await depositErrorCode(
            { agentCashHeld: 100_000, contractOutstanding: 100_000, agencyOwesPlatform: 0 },
            100_000,
            'platform'
        )) === 'COD_DEPOSIT_AGENCY_ALREADY_SETTLED'
    );

    // Partial cover: the platform takes what it is still owed and no more. The
    // agent pays the rest to the agency.
    await assert('a direct deposit is bounded by what the agency still owes', async () =>
        (await depositErrorCode(
            { agentCashHeld: 100_000, contractOutstanding: 100_000, agencyOwesPlatform: 60_000 },
            100_000,
            'platform'
        )) === 'COD_DEPOSIT_AGENCY_ALREADY_SETTLED'
    );

    // The normal case must NOT be refused. (Gets past every guard and dies on the
    // DB instead — the assertion is only that it is not refused for the wrong
    // reason, matching the `>` vs `>=` test above.)
    await assert('a direct deposit within the agency\'s liability is allowed through', async () =>
        (await depositErrorCode(
            { agentCashHeld: 100_000, contractOutstanding: 100_000, agencyOwesPlatform: 100_000 },
            100_000,
            'platform'
        )) !== 'COD_DEPOSIT_AGENCY_ALREADY_SETTLED'
    );

    // The contract guard still runs first for direct payments: paying the
    // platform must not become a way to settle a debt owed to another agency.
    await assert('a direct deposit cannot dodge the wrong-contract guard', async () =>
        (await depositErrorCode(
            { agentCashHeld: 300_000, contractOutstanding: 100_000, agencyOwesPlatform: 500_000 },
            150_000,
            'platform'
        )) === 'CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING'
    );

    // ─── Declarations (the agent's claim) ─────────────────────────────────────
    // A declaration moves no money — it is a timestamped claim the receiving
    // party must answer. It is what an agent previously had no way to create.
    console.log('\n── Deposit declarations ───────────────────────────────────────────────');

    async function declareErrorCode(
        opts: DepositWorld,
        amount: number,
        recipient: 'agency' | 'platform',
        reference?: string | null
    ): Promise<string | null> {
        try {
            await makeDeposits(opts).declare({
                agentId: 'agent-1',
                agencyId: 'agency-1',
                amount,
                recipient,
                reference,
                declaredByUserId: 'user-1',
            });
            return null;
        } catch (err) {
            return (err as AppError).code ?? null;
        }
    }

    const solvent: DepositWorld = {
        agentCashHeld: 100_000,
        contractOutstanding: 100_000,
        agencyOwesPlatform: 100_000,
    };

    // The platform is not present at the handover, so the transfer reference is
    // the only thing tying the claim to real money.
    await assert('a direct declaration without a transfer reference is refused', async () =>
        (await declareErrorCode(solvent, 50_000, 'platform', null)) ===
        'COD_DEPOSIT_REFERENCE_REQUIRED'
    );

    await assert('whitespace does not count as a reference', async () =>
        (await declareErrorCode(solvent, 50_000, 'platform', '   ')) ===
        'COD_DEPOSIT_REFERENCE_REQUIRED'
    );

    // The agency route has a counterparty standing there; no reference needed.
    await assert('an agency declaration needs no reference', async () =>
        (await declareErrorCode(solvent, 50_000, 'agency', null)) !==
        'COD_DEPOSIT_REFERENCE_REQUIRED'
    );

    // A declaration is still bounded by what the agent could possibly owe — it
    // is evidence, not a wish.
    await assert('an agent cannot declare more than this contract is owed', async () =>
        (await declareErrorCode(
            { agentCashHeld: 300_000, contractOutstanding: 100_000, agencyOwesPlatform: 300_000 },
            150_000,
            'agency'
        )) === 'CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING'
    );

    // ─── COD auto-collection (the 7-day window elapsed, no code ever came) ────
    // A COD shipment left at `agent_delivered` past the dispute window is
    // collected WITHOUT a code, because an agent who was not paid is required to
    // return it instead. What is asserted here is the fail-closed half: the
    // conditions under which the sweep must decline to record cash. Only the
    // pre-transaction guards are reachable DB-free — the money movement itself
    // (liability credit, split, completion) needs Mongo and is owed an
    // integration test, like the rest of the COD flow.
    console.log('\n── COD auto-collection ────────────────────────────────────────────────');

    const staleShipment: any = {
        _id: { toString: () => 'shipment-1' },
        order_id: { toString: () => 'order-1' },
        agent_id: { toString: () => 'agent-1' },
        agency_id: { toString: () => 'agency-1' },
        status: 'agent_delivered',
    };

    /** Collection service wired to fakes; only the collection lookup is exercised. */
    function autoCollect(collection: any): Promise<boolean> {
        const svc = new CashCollectionService(
            { findByShipmentId: async () => collection } as any
        );
        return svc.autoCollectWithoutCode(staleShipment);
    }

    // THE guard that keeps the silent ledger hole shut. A COD shipment with no
    // collection has no expected amount to record, so confirming it anyway would
    // deliver and complete an order that no allocation — not even the vendor's —
    // is ever created for. Better stuck and logged than silently unpayable.
    await assert('a COD shipment with no collection is never auto-confirmed', async () =>
        (await autoCollect(null)) === false
    );

    // The agent's code landed while the sweep was mid-flight. Their collection
    // carries real customer evidence; ours would carry none, so they win.
    await assert('an already-collected collection is left alone', async () =>
        (await autoCollect({ status: 'collected' })) === false
    );

    // The shipment came back and its collection was voided — there is no cash.
    await assert('a cancelled collection is never auto-collected', async () =>
        (await autoCollect({ status: 'cancelled' })) === false
    );

    // ─── Agent fee split (what the platform pays the agent) ───────────────────
    // The agent's cut is carved OUT of the agency's delivery fee, per the
    // contract's fee_split. The vendor pays the same either way.
    console.log('\n── Agent fee split ────────────────────────────────────────────────────');

    /**
     * Split service wired to fakes; only the contract lookup is exercised.
     *
     * The cut arithmetic lives in EarningsQuoteService now (so the agent's
     * offer-time estimate and the delivery-time actual cannot drift), and
     * EarningsSplitService delegates to it — so the fake contract repository has
     * to be injected THERE, not only into the split service, or the delegate
     * reaches for the real repository and a live Mongo connection.
     */
    function makeSplit(contract: any) {
        const contracts = { findLive: async () => contract } as any;
        return new EarningsSplitService(
            {} as any, {} as any, {} as any, {} as any, {} as any,
            contracts,
            new EarningsQuoteService({} as any, contracts)
        );
    }

    function agentCut(contract: any, deliveryFee: number): Promise<number> {
        return (makeSplit(contract) as any).computeAgentCut('agent-1', 'agency-1', deliveryFee);
    }

    const percentageContract = (percent: number) =>
        makeMembership({
            fee_split: { model: 'percentage', agent_share_percent: percent, agent_flat_fee: null, currency: 'XAF' },
        });
    const flatContract = (flat: number) =>
        makeMembership({
            fee_split: { model: 'flat', agent_share_percent: null, agent_flat_fee: flat, currency: 'XAF' },
        });

    await assert('a percentage split takes that share of the delivery fee', async () =>
        (await agentCut(percentageContract(20), 1_000)) === 200
    );

    await assert('a flat split takes the agreed fee per delivery', async () =>
        (await agentCut(flatContract(300), 1_000)) === 300
    );

    // Minor units are indivisible; rounding must favour the agency, never mint
    // a franc the platform did not collect.
    await assert('a percentage split rounds DOWN, never up', async () =>
        (await agentCut(percentageContract(33), 100)) === 33
    );

    // A flat fee negotiated above what the delivery earns would otherwise drive
    // the agency's allocation negative — the platform can only divide the fee it
    // actually collected.
    await assert('a flat fee above the delivery fee is clamped to it', async () =>
        (await agentCut(flatContract(1_500), 1_000)) === 1_000
    );

    await assert('a zero delivery fee yields no cut', async () =>
        (await agentCut(percentageContract(20), 0)) === 0
    );

    // Same cause as the unattributed-collection case: a contract terminated with
    // a shipment still in flight. The fee stays whole with the agency rather
    // than failing the split.
    await assert('no live contract means no cut, not a failed split', async () =>
        (await agentCut(null, 1_000)) === 0
    );

    await assert('a contract with no agreed share pays the agent nothing', async () =>
        (await agentCut(percentageContract(0), 1_000)) === 0
    );

    // ─── Delivery outcome → what the run earned (prepaid) ─────────────────────
    // On an ONLINE-paid order the vendor is charged the delivery fee at payment,
    // but the agency and agent are not paid until the run is over — that is what
    // finally pays an agent on a prepaid delivery. `resolveEarnedFee` decides how
    // much of the reserved fee the run actually earned; the remainder goes back
    // to the vendor, so the order's gross always reconciles.
    console.log('\n── Prepaid delivery outcome ───────────────────────────────────────────');

    const policiesWithRto = (rto: number): any => ({
        pricing: { additional_fees: { rto_fee: rto } },
    });

    await assert('a completed delivery earns the whole reserved fee', () =>
        resolveEarnedFee('delivered', 1_000, policiesWithRto(300)) === 1_000
    );

    // The run happened, but not the run that was quoted — the agency's own
    // return-to-origin rate is what it earned.
    await assert('a returned shipment earns the agency rto_fee instead', () =>
        resolveEarnedFee('returned', 1_000, policiesWithRto(300)) === 300
    );

    // The split can only divide money that was actually charged; an rto_fee
    // above the reserved fee would otherwise pay out more than came in.
    await assert('an rto_fee above the reserved fee is clamped to it', () =>
        resolveEarnedFee('returned', 1_000, policiesWithRto(1_500)) === 1_000
    );

    await assert('an agency with no rto_fee earns nothing on a return', () =>
        resolveEarnedFee('returned', 1_000, policiesWithRto(0)) === 0
    );

    await assert('a missing policy earns nothing on a return, never a guess', () =>
        resolveEarnedFee('returned', 1_000, null) === 0
    );

    await assert('a zero reserved fee earns nothing either way', () =>
        resolveEarnedFee('delivered', 0, policiesWithRto(300)) === 0
    );

    // The whole point of the two-moment split: every franc the vendor was charged
    // is accounted for, whichever way the run ended.
    await assert('delivered — agency + agent + vendor refund = the reserved fee', async () => {
        const reserved = 1_000;
        const earned = resolveEarnedFee('delivered', reserved, policiesWithRto(300));
        const cut = await agentCut(percentageContract(20), earned);
        return (earned - cut) + cut + (reserved - earned) === reserved;
    });

    await assert('returned — agency + agent + vendor refund = the reserved fee', async () => {
        const reserved = 1_000;
        const earned = resolveEarnedFee('returned', reserved, policiesWithRto(300));
        const cut = await agentCut(percentageContract(20), earned);
        // 300 earned → 60 to the agent, 240 to the agency, 700 back to the vendor.
        return cut === 60 && (earned - cut) === 240 && (reserved - earned) === 700;
    });

    // ─── Order settlement (what starts EVERY actor's hold window) ─────────────
    // One order, one maturity date: vendor, platform, agency and agent all
    // release together, a hold period after the order completes. `isSettled`
    // decides when an order is finished, and it is deliberately NOT
    // "fulfillment_status === 'delivered'".
    console.log('\n── Order settlement ───────────────────────────────────────────────────');

    const completion = new OrderCompletionService({} as any, {} as any);

    const physicalOrder = (...itemStatuses: (string | null)[]): any => ({
        order_type: 'physical',
        fulfillment_status: 'partially_delivered',
        items: itemStatuses.map((s) => (s === null ? {} : { delivery: { status: s } })),
    });

    await assert('an order with every item delivered is settled', () =>
        completion.isSettled(physicalOrder('delivered', 'delivered'))
    );

    // THE case this exists for. One delivered, one returned: nothing further
    // will happen, but fulfillment_status is stuck at 'partially_delivered'
    // forever — and for COD the delivered item's cash is already in hand, so
    // never completing would strand it permanently.
    await assert('delivered + returned is settled, though never "delivered"', () =>
        completion.isSettled(physicalOrder('delivered', 'returned'))
    );

    await assert('an all-returned order is settled too', () =>
        completion.isSettled(physicalOrder('returned', 'returned'))
    );

    // 'failed' is NOT terminal: the agent still holds the package and the
    // agency can push it back to in_transit. Treating it as finished would
    // release escrow on a delivery that may still happen.
    await assert('a failed item leaves the order unsettled — it can still retry', () =>
        !completion.isSettled(physicalOrder('delivered', 'failed'))
    );

    await assert('an item still in transit leaves the order unsettled', () =>
        !completion.isSettled(physicalOrder('delivered', 'in_transit'))
    );

    // agent_delivered is the agent's claim, not the customer's confirmation.
    await assert('agent_delivered is not settled — it is a claim, not a confirmation', () =>
        !completion.isSettled(physicalOrder('agent_delivered'))
    );

    await assert('an order awaiting agency reassignment is not settled', () =>
        !completion.isSettled(physicalOrder('delivered', 'pending_agency_reassignment'))
    );

    await assert('an order with no delivery info at all is not settled', () =>
        !completion.isSettled(physicalOrder(null, null))
    );

    await assert('a digital order is settled once fulfilled', () =>
        completion.isSettled({ order_type: 'digital', fulfillment_status: 'fulfilled', items: [] } as any)
    );

    await assert('an unfulfilled digital order is not settled', () =>
        !completion.isSettled({ order_type: 'digital', fulfillment_status: 'processing', items: [] } as any)
    );

    // ─── Agent deposit notifications (catalog rendering) ──────────────────────
    // The dispatch side needs Mongo (prefs + agent lookups), but the catalog is
    // pure. These lock down the two things that would silently break it: a
    // missing translation, and copy that fails to name the amount or actor — the
    // whole point of the 'recorded' message is that an agent can spot an
    // under-recorded hand-over, which a vague template would defeat.
    console.log('\n── Agent deposit notifications ─────────────────────────────────────────');

    // Completeness across every supported language, for every situation.
    await assert('the agent catalog is complete in all languages', () => {
        assertAgentCatalogComplete();
        return true;
    });

    const depositCtx = {
        depositId: 'deposit-1',
        agencyName: 'Douala Express',
        confirmedByName: 'Douala Express',
        currency: 'XAF',
        amountFormatted: '78,000',
    };

    // The recorded-without-declaration message must carry the amount and the
    // agency — it is the agent's only chance to notice a wrong figure.
    await assert('the recorded notification names the amount and the agency', () => {
        const { message } = renderAgentInApp('cod.deposit.recorded', 'en', depositCtx);
        return message.includes('78,000') && message.includes('Douala Express');
    });

    // recorded (told about it) and confirmed (answered my claim) must not render
    // the same — that distinction is the reason the payload carries declaredAt.
    await assert('recorded and confirmed are genuinely different copy', () => {
        const recorded = renderAgentInApp('cod.deposit.recorded', 'en', depositCtx).message;
        const confirmed = renderAgentInApp('cod.deposit.confirmed', 'en', depositCtx).message;
        return recorded !== confirmed;
    });

    // The rejection copy must surface the reason and that the clock restarts —
    // an agent who does not know either will not act in time.
    await assert('the rejection notification includes the reason', () => {
        const { message } = renderAgentInApp('cod.deposit.rejected', 'en', {
            ...depositCtx,
            rejectionReason: 'Nothing arrived at the desk',
        });
        return message.includes('Nothing arrived at the desk');
    });

    // A non-English language resolves to real translated copy, not a fallback
    // that silently ships English.
    await assert('French renders distinct localized copy', () => {
        const en = renderAgentInApp('cod.deposit.recorded', 'en', depositCtx).title;
        const fr = renderAgentInApp('cod.deposit.recorded', 'fr', depositCtx).title;
        return en !== fr && fr.length > 0;
    });

    // ─── Contract terms: fee split coherence ──────────────────────────────────
    // The fee split is what the earnings split divides by at delivery, twice over
    // (the agent's offer-time estimate and the actual). An incoherent one would
    // not fail here — it would quietly mispay an agent weeks later.
    console.log('\n── Contract terms: fee split ──────────────────────────────────────────');

    function makeTermsService(contract: any) {
        const contracts: any = {
            findById: async () => contract,
            updateTerms: async () => contract,
        };
        const events: any = { append: async () => undefined };
        return new AgentContractService(
            { findById: async () => null } as any,
            contracts,
            events,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            // Stubbed so the post-commit notifier does not try to resolve a fake
            // agency id against Mongo. It is fire-and-forget and swallows the
            // failure either way — this just keeps the test output honest.
            { findNameByAgencyId: async () => 'Test Agency' } as any
        );
    }

    // Coherence is checked on the NEGOTIATION path, so these exercise a pending
    // contract: `updateTerms` on a pending one delegates to `counterTerms`,
    // which is where the merge-then-check happens. On a live contract the same
    // call is refused outright (asserted separately below) — terms of a running
    // contract change by proposal, not by edit.
    async function termsErrorCode(contract: any, terms: any): Promise<string | null> {
        try {
            await makeTermsService({ ...contract, status: 'pending' }).updateTerms(
                'agency-1',
                'membership-1',
                terms,
                { userId: 'user-1', role: 'agency' }
            );
            return null;
        } catch (err) {
            return (err as AppError).code ?? null;
        }
    }

    await assert('a percentage split with no share is refused', async () =>
        (await termsErrorCode(percentageContract(40), {
            fee_split: { model: 'percentage', agent_share_percent: null },
        })) === 'CONTRACT_FEE_SPLIT_INVALID'
    );

    await assert('a flat split with no flat fee is refused', async () =>
        (await termsErrorCode(percentageContract(40), { fee_split: { model: 'flat' } })) ===
        'CONTRACT_FEE_SPLIT_INVALID'
    );

    // The patch is merged OVER the stored split before checking. Switching a
    // contract that already carries a flat fee to the flat model changes one key
    // and must not be rejected for a field it is not touching.
    await assert('switching model to one the contract already has a value for is allowed', async () =>
        (await termsErrorCode(flatContract(500), { fee_split: { model: 'flat' } })) === null
    );

    await assert('a partial patch that leaves the split coherent is allowed', async () =>
        (await termsErrorCode(percentageContract(40), { fee_split: { agent_share_percent: 55 } })) === null
    );

    // Terms other than fee_split are not gated by this rule at all.
    await assert('a non-fee-split term update skips the coherence check', async () =>
        (await termsErrorCode(percentageContract(40), { shipment_value_ceiling: 250_000 })) === null
    );

    // ─── Status requests: who may resolve ─────────────────────────────────────
    // `resolveRequest` does NOT check the resolver — it is also the auto-approval
    // path, where there is no counterparty. `resolveRequestAs` is therefore the
    // only safe HTTP entry point, and these are the two checks it adds.
    console.log('\n── Status requests: counterparty consent ──────────────────────────────');

    function makeRequestService(request: any) {
        const requests: any = { findById: async () => request };
        return new AgentContractService(
            {} as any,
            { findById: async () => makeMembership() } as any,
            { append: async () => undefined } as any,
            requests,
            {} as any,
            {} as any
        );
    }

    async function resolveErrorCode(
        request: any,
        party: 'agent' | 'agency',
        ownerId: string
    ): Promise<string | null> {
        try {
            await makeRequestService(request).resolveRequestAs(party, ownerId, 'request-1', 'approve', {
                userId: 'user-1',
                role: party,
            });
            return null;
        } catch (err) {
            return (err as AppError).code ?? null;
        }
    }

    const agencyRaisedRequest = {
        _id: { toString: () => 'request-1' },
        contract_id: { toString: () => 'membership-1' },
        agent_id: { toString: () => 'agent-1' },
        agency_id: { toString: () => 'agency-1' },
        transition: 'deactivate',
        state: 'pending',
        requested_by_role: 'agency',
    };

    // THE consent rule. Without it the party who raised a `requires_counterparty`
    // request could approve it themselves, which is exactly the agreement the
    // authority matrix exists to require.
    await assert('the party who raised a request cannot resolve it', async () =>
        (await resolveErrorCode(agencyRaisedRequest, 'agency', 'agency-1')) ===
        'CONTRACT_STATUS_REQUEST_NOT_YOURS'
    );

    // A foreign request 404s rather than 403s: the caller should not learn it exists.
    await assert('a request addressed to another agent is not found, not forbidden', async () =>
        (await resolveErrorCode(agencyRaisedRequest, 'agent', 'agent-99')) ===
        'CONTRACT_STATUS_REQUEST_NOT_FOUND'
    );

    await assert('a missing request is not found', async () =>
        (await resolveErrorCode(null, 'agent', 'agent-1')) === 'CONTRACT_STATUS_REQUEST_NOT_FOUND'
    );

    // The counterparty gets past both checks (and on into the transaction, which
    // has no DB here — the assertion is only that it is not refused for consent).
    await assert('the counterparty passes the consent checks', async () => {
        const code = await resolveErrorCode(agencyRaisedRequest, 'agent', 'agent-1');
        return code !== 'CONTRACT_STATUS_REQUEST_NOT_YOURS' && code !== 'CONTRACT_STATUS_REQUEST_NOT_FOUND';
    });

    // ─── The contract handshake ───────────────────────────────────────────────
    //
    // Who may answer a pending contract depends on who RAISED it, which the
    // authority matrix cannot express (it is keyed on the party, and the
    // initiator is a property of the contract). The initiator guard carries that
    // rule, and these assertions are the only thing holding it: with no DB here,
    // a request that gets past the guard fails later inside the transaction, so
    // "not refused for initiator reasons" is the positive signal.
    console.log('\n── The contract handshake ─────────────────────────────────────────────');

    function makeHandshakeService(contract: any) {
        return new AgentContractService(
            {} as any,
            { findById: async () => contract } as any,
            { append: async () => undefined } as any,
            { findPending: async () => null, create: async () => ({ _id: { toString: () => 'r-1' } }) } as any,
            {} as any,
            {} as any
        );
    }

    async function transitionErrorCode(
        contract: any,
        transition: 'approve' | 'reject' | 'withdraw',
        party: 'agent' | 'agency'
    ): Promise<string | null> {
        try {
            await makeHandshakeService(contract).requestTransition(
                'membership-1',
                transition,
                party,
                { userId: 'user-1', role: party }
            );
            return null;
        } catch (err) {
            return (err as AppError).code ?? null;
        }
    }

    const NOT_PERMITTED = 'CONTRACT_TRANSITION_NOT_PERMITTED';
    // `join_request` is the ONLY agent-raised origin. Everything else —
    // invitation, transfer, admin, migration — is raised by the agency or the
    // platform, and in each the agent is the party who consents.
    const agentRaised = makeMembership({ status: 'pending', origin: 'join_request' });
    const agencyRaised = makeMembership({ status: 'pending', origin: 'invitation' });

    await assert('the agency cannot approve a request it raised itself', async () =>
        (await transitionErrorCode(agencyRaised, 'approve', 'agency')) === NOT_PERMITTED
    );

    await assert('the agent cannot approve their own join request', async () =>
        (await transitionErrorCode(agentRaised, 'approve', 'agent')) === NOT_PERMITTED
    );

    await assert('the agency cannot reject a request it raised itself', async () =>
        (await transitionErrorCode(agencyRaised, 'reject', 'agency')) === NOT_PERMITTED
    );

    await assert('the agent may answer a request the agency raised', async () =>
        (await transitionErrorCode(agencyRaised, 'approve', 'agent')) !== NOT_PERMITTED
    );

    await assert('the agency may answer an application the agent raised', async () =>
        (await transitionErrorCode(agentRaised, 'approve', 'agency')) !== NOT_PERMITTED
    );

    // Withdraw is the mirror: only the raiser, never the counterparty. Otherwise
    // it would be a second, unaudited way to reject.
    await assert('the agent cannot withdraw a request the agency raised', async () =>
        (await transitionErrorCode(agencyRaised, 'withdraw', 'agent')) === NOT_PERMITTED
    );

    await assert('the agency cannot withdraw an application the agent raised', async () =>
        (await transitionErrorCode(agentRaised, 'withdraw', 'agency')) === NOT_PERMITTED
    );

    await assert('the agency may withdraw its own request', async () =>
        (await transitionErrorCode(agencyRaised, 'withdraw', 'agency')) !== NOT_PERMITTED
    );

    await assert('the agent may withdraw their own application', async () =>
        (await transitionErrorCode(agentRaised, 'withdraw', 'agent')) !== NOT_PERMITTED
    );

    // A non-pending contract must fail on the FSM, not the initiator rule —
    // otherwise "you may not do that" would mask "that is not where this is".
    await assert('withdrawing a non-pending contract is an invalid transition', async () => {
        const active = makeMembership({ status: 'active', origin: 'invitation' });
        return (await transitionErrorCode(active, 'withdraw', 'agency')) === 'CONTRACT_INVALID_TRANSITION';
    });

    // ─── Handshake status/transition drift guards ─────────────────────────────
    //
    // The three transition maps, the ContractStatus union and the two Mongoose
    // enums are five separate lists that must agree. A value added to one and
    // forgotten in another fails at write time in production, not at boot.
    console.log('\n── Handshake status/transition drift guards ───────────────────────────');

    const contractStatusEnum: string[] =
        (AgentAgencyContractModel.schema.path('status') as any).enumValues;
    const requestTransitionEnum: string[] =
        (ContractStatusRequestModel.schema.path('transition') as any).enumValues;
    const requestTargetEnum: string[] =
        (ContractStatusRequestModel.schema.path('target_status') as any).enumValues;
    const requestStateEnum: string[] =
        (ContractStatusRequestModel.schema.path('state') as any).enumValues;
    const eventTypeEnum: string[] =
        (AgentMembershipEventModel.schema.path('type') as any).enumValues;

    await assert('withdrawn is a contract status in the schema enum', () =>
        contractStatusEnum.includes('withdrawn')
    );

    await assert('withdraw is a transition in both request enums', () =>
        requestTransitionEnum.includes('withdraw') && requestTargetEnum.includes('withdrawn')
    );

    await assert('withdrawn is an event type in the schema enum', () =>
        eventTypeEnum.includes('withdrawn')
    );

    await assert('every request target_status is a real contract status', () =>
        requestTargetEnum.every((s) => contractStatusEnum.includes(s))
    );

    // `cancelled` is the terminal state `/status-requests/:id/cancel` writes.
    // The repository passes it straight into a `$set`, so dropping it from the
    // schema enum fails at write time in production, not at boot — exactly the
    // drift this section exists to catch.
    await assert('cancelled is a request state in the schema enum', () =>
        requestStateEnum.includes('cancelled')
    );

    await assert('the four request states are exactly pending + three terminals', () =>
        requestStateEnum.length === 4 &&
        (['pending', 'approved', 'rejected', 'cancelled'] as const).every((s) =>
            requestStateEnum.includes(s)
        )
    );

    // THE index invariant. LIVE_CONTRACT_STATUSES backs the partial unique index
    // on (agent_id, agency_id); a terminal status inside it would make a
    // withdrawn request block the re-request it exists to permit.
    await assert('withdrawn is terminal — absent from every live/allocating set', () =>
        !LIVE_CONTRACT_STATUSES.includes('withdrawn' as any) &&
        !ALLOCATING_CONTRACT_STATUSES.includes('withdrawn' as any) &&
        !COUNTED_CONTRACT_STATUSES.includes('withdrawn' as any)
    );

    await assert('rejected and deactivated are terminal for the same reason', () =>
        !LIVE_CONTRACT_STATUSES.includes('rejected' as any) &&
        !LIVE_CONTRACT_STATUSES.includes('deactivated' as any)
    );

    // The DTO field a client renders its pending-state buttons from. It must
    // agree with the server's rule, or the UI offers a button that 403s.
    await assert('initiatedBy mirrors the server initiator rule', () =>
        AgentMembershipMapper.toDto(makeMembership({ origin: 'join_request' })).initiatedBy === 'agent' &&
        AgentMembershipMapper.toDto(makeMembership({ origin: 'invitation' })).initiatedBy === 'agency' &&
        AgentMembershipMapper.toDto(makeMembership({ origin: 'transfer' })).initiatedBy === 'agency' &&
        AgentMembershipMapper.toDto(makeMembership({ origin: 'admin' })).initiatedBy === 'agency' &&
        AgentMembershipMapper.toDto(makeMembership({ origin: 'migration' })).initiatedBy === 'agency'
    );

    // ─── Handshake surface parity with vendor↔agency ──────────────────────────
    //
    // The two flows are meant to be mirror images. These pin the parts a rename
    // or a "helpful" extra route would quietly break.
    console.log('\n── Handshake surface parity ───────────────────────────────────────────');

    // `deactivate` moved to its own /terminate endpoint. Leaving it in the
    // dispatcher would be a second way to end a contract, with a different
    // status code and response shape from the agency's.
    await assert('the transitions dispatcher no longer accepts deactivate', () =>
        !RequestTransitionSchema.safeParse({ transition: 'deactivate' }).success
    );

    await assert('the transitions dispatcher still accepts pause and reactivate', () =>
        RequestTransitionSchema.safeParse({ transition: 'pause' }).success &&
        RequestTransitionSchema.safeParse({ transition: 'reactivate' }).success
    );

    await assert('the handshake verbs are not routable as transitions', () =>
        ['approve', 'reject', 'withdraw'].every(
            (t) => !RequestTransitionSchema.safeParse({ transition: t }).success
        )
    );

    // The status-request inbox has two exits, and the pair must stay symmetric:
    // /resolve answers the counterparty's request, /cancel pulls back your own.
    // Both controllers parse an ABSENT body (`req.body ?? {}`), so a required
    // field here would 400 the common "just cancel it" call.
    await assert('cancelling a status request needs no body at all', () => {
        const parsed = CancelStatusRequestSchema.safeParse({});
        return parsed.success && parsed.data.note === null;
    });

    await assert('a cancel note is optional, clearable and capped at 300 chars', () =>
        CancelStatusRequestSchema.safeParse({ note: 'changed my mind' }).success &&
        CancelStatusRequestSchema.parse({ note: '   ' }).note === null &&
        !CancelStatusRequestSchema.safeParse({ note: 'x'.repeat(301) }).success
    );

    // Cancelling has exactly one outcome, so there is no decision to make. A
    // `decision` field creeping in would imply the author can approve their own
    // request — precisely the consent the two-verb split exists to require.
    await assert('cancel carries no decision — that belongs to /resolve', () =>
        !('decision' in CancelStatusRequestSchema.parse({ decision: 'approve' })) &&
        !ResolveStatusRequestSchema.safeParse({}).success
    );

    // The list schema backs BOTH "Connections" views. Pagination defaults must
    // match ListConnectionsQuerySchema in the vendor flow.
    await assert('the membership list paginates with the vendor flow defaults', () => {
        const parsed = ListMembershipsQuerySchema.parse({});
        return parsed.page === 1 && parsed.limit === 20 && parsed.status === undefined;
    });

    await assert('the membership list caps limit at 100', () =>
        !ListMembershipsQuerySchema.safeParse({ limit: 101 }).success &&
        ListMembershipsQuerySchema.safeParse({ limit: 100 }).success
    );

    await assert('the membership list accepts every contract status as a filter', () =>
        (['pending', 'rejected', 'withdrawn', 'active', 'paused', 'suspended', 'deactivated'] as const)
            .every((s) => ListMembershipsQuerySchema.safeParse({ status: s }).success)
    );

    // THE history rule: no `status` must mean no status predicate, or the
    // Connections tab silently drops every terminal row. Asserted against the
    // filter the repository actually builds.
    await assert('an unfiltered list query carries no status predicate', async () => {
        let captured: Record<string, unknown> | null = null;
        const repo = new AgentContractRepository();
        // paginateBy is private; reach it the way listForAgent does, with the
        // model calls stubbed so no DB is needed.
        const model: any = (AgentAgencyContractModel as any);
        const origCount = model.countDocuments;
        const origFind = model.find;
        model.countDocuments = (f: Record<string, unknown>) => {
            captured = f;
            return { exec: async () => 0 };
        };
        model.find = () => ({
            sort: () => ({ skip: () => ({ limit: () => ({ exec: async () => [] }) }) }),
        });
        try {
            await repo.listForAgent('agent-1', {}, { page: 1, limit: 20 });
        } finally {
            model.countDocuments = origCount;
            model.find = origFind;
        }
        return captured !== null && !('status' in (captured as Record<string, unknown>));
    });

    await assert('a filtered list query carries exactly that status', async () => {
        let captured: Record<string, unknown> | null = null;
        const repo = new AgentContractRepository();
        const model: any = (AgentAgencyContractModel as any);
        const origCount = model.countDocuments;
        const origFind = model.find;
        model.countDocuments = (f: Record<string, unknown>) => {
            captured = f;
            return { exec: async () => 0 };
        };
        model.find = () => ({
            sort: () => ({ skip: () => ({ limit: () => ({ exec: async () => [] }) }) }),
        });
        try {
            await repo.listForAgency('agency-1', { status: 'withdrawn' }, { page: 1, limit: 20 });
        } finally {
            model.countDocuments = origCount;
            model.find = origFind;
        }
        return (captured as any)?.status === 'withdrawn';
    });

    // ─── Agent directory redaction ────────────────────────────────────────────
    //
    // The directory is the one place an agency sees an agent it has NO contract
    // with. Everything below is deliberately absent; a field added to the
    // projection without a thought here is a privacy regression.
    console.log('\n── Agent directory redaction ──────────────────────────────────────────');

    const directoryItem: Record<string, unknown> = AgentDirectoryMapper.toListItemDto(
        makeAgent({ home_base: { location: { type: 'Point', coordinates: [9.7, 4.05] }, service_radius_km: 12, label: 'Douala — Akwa' } })
    ) as any;
    const directoryJson = JSON.stringify(directoryItem);

    await assert('contact details are never in the directory', () =>
        !('email' in directoryItem) && !('phone' in directoryItem)
    );

    await assert('legal identity never leaks into the directory', () =>
        !directoryJson.includes('DL-SECRET') && !directoryJson.includes('NID-SECRET')
    );

    await assert('financial and capacity internals stay out of the directory', () =>
        !('payoutDetails' in directoryItem) &&
        !('codThreshold' in directoryItem) &&
        !('maxThreshold' in directoryItem) &&
        !('activeShipmentCount' in directoryItem)
    );

    // Load is reported as a LABEL. The raw counters describe the agent's
    // commitments to OTHER agencies, which is none of a browsing agency's
    // business — the roster DTO carries them, this one must not.
    await assert('load is reported as a label, not a count', () =>
        directoryItem.workingState === 'idle' && !('capacity' in directoryItem)
    );

    await assert('the useful public signals ARE present', () =>
        directoryItem.trustScore === 100 &&
        directoryItem.vehicleType === 'bike' &&
        directoryItem.kycVerified === true &&
        (directoryItem.homeBase as any).serviceRadiusKm === 12
    );

    // ─── Admin gate validators ────────────────────────────────────────────────
    // The gate service validates neither its status enum nor its reason, so these
    // schemas are the only thing between a typo and an agent stuck ineligible.
    console.log('\n── Admin gate validators ──────────────────────────────────────────────');

    const parses = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
        schema.safeParse(value).success;

    await assert('rejecting KYC without a reason is refused', () =>
        !parses(SetKycStatusSchema, { status: 'rejected' })
    );

    await assert('rejecting KYC with a reason is accepted', () =>
        parses(SetKycStatusSchema, { status: 'rejected', rejectionReason: 'Blurred document' })
    );

    await assert('verifying KYC needs no reason', () =>
        parses(SetKycStatusSchema, { status: 'verified' })
    );

    await assert('an unknown KYC status is refused', () =>
        !parses(SetKycStatusSchema, { status: 'approved' })
    );

    // An omitted reference must stay omitted: the service only writes it when the
    // key is present, so defaulting it to null would wipe a stored reference on
    // every status change that did not resend it.
    await assert('an omitted KYC reference stays undefined, not null', () => {
        const parsed = SetKycStatusSchema.parse({ status: 'verified' });
        return parsed.reference === undefined;
    });

    await assert('banning without a reason is refused', () =>
        !parses(SetPlatformBanSchema, { banned: true })
    );

    await assert('banning with a reason is accepted', () =>
        parses(SetPlatformBanSchema, { banned: true, reason: 'Cash theft' })
    );

    await assert('lifting a ban needs no reason', () =>
        parses(SetPlatformBanSchema, { banned: false })
    );

    // The pool ceiling, not a contract's slice of it — different constants. Since
    // 2026-09-21 this is an administrator's PIN on the pool (the pool itself is plan × KYC),
    // so it carries a reason, and `null` releases the pin.
    await assert('an agent COD pool pin above the platform ceiling is refused', () =>
        !parses(SetAgentThresholdSchema, { maxThreshold: AGENT_CONFIG.COD_THRESHOLD_MAX + 1, reason: 'too much' })
    );

    await assert('an agent COD pool pin of zero is accepted', () =>
        parses(SetAgentThresholdSchema, { maxThreshold: 0, reason: 'cash shortfall under review' })
    );

    await assert('a COD pool pin WITHOUT a reason is refused — in either direction', () =>
        !parses(SetAgentThresholdSchema, { maxThreshold: 0 })
        && !parses(SetAgentThresholdSchema, { maxThreshold: null })
    );

    await assert('releasing the pin is `maxThreshold: null` with a reason', () =>
        parses(SetAgentThresholdSchema, { maxThreshold: null, reason: 'back to the plan' })
    );

    // ─── Terms negotiation: who holds the offer ───────────────────────────────
    console.log('\n── Terms negotiation: proposer authority ──────────────────────────────');

    // `proposerOf` and `assertProposerRule` are private, which is correct — they
    // are guards, not API. They are reached here through the one public method
    // that funnels every transition, with a stub repository standing in for the
    // contract. That keeps the test DB-free while exercising the real rule.
    const contractSvcFor = (contract: Record<string, unknown>) => {
        const contracts = {
            findById: async () => contract,
            updateTerms: async () => contract,
        } as unknown as AgentContractRepository;
        return new AgentContractService(
            { findById: async () => null } as never,
            contracts,
            { append: async () => undefined } as never,
            undefined,
            undefined,
            undefined,
            undefined,
            // See makeTermsService — keeps the fire-and-forget notifier off Mongo.
            { findNameByAgencyId: async () => 'Test Agency' } as never
        );
    };

    const coherentSplit = { model: 'percentage', agent_share_percent: 30, agent_flat_fee: null, currency: 'XAF' };
    const pendingContract = (over: Record<string, unknown> = {}) => ({
        _id: { toString: () => 'c1' },
        agent_id: { toString: () => 'a1' },
        agency_id: { toString: () => 'ag1' },
        status: 'pending',
        origin: 'invitation',
        fee_split: coherentSplit,
        terms_proposed_by: 'agency',
        terms_version: 1,
        ...over,
    });

    const refuses = async (fn: () => Promise<unknown>, code: string): Promise<boolean> => {
        try {
            await fn();
            return false;
        } catch (err) {
            return err instanceof AppError && err.code === code;
        }
    };

    // The agency invited on its own terms, so the AGENT answers.
    await assert('the party whose terms stand may not approve them', () =>
        refuses(
            () => contractSvcFor(pendingContract()).requestTransition('c1', 'approve', 'agency', { userId: 'u', role: 'agency' }),
            'CONTRACT_TRANSITION_NOT_PERMITTED'
        )
    );

    await assert('the party whose terms stand may not be refused a withdraw', async () => {
        // Reaching the pending-request stage means the proposer guard passed;
        // any later failure is not the guard under test.
        const err = await contractSvcFor(pendingContract())
            .requestTransition('c1', 'withdraw', 'agency', { userId: 'u', role: 'agency' })
            .then(() => null)
            .catch((e) => e);
        return !(err instanceof AppError && err.code === 'CONTRACT_TRANSITION_NOT_PERMITTED');
    });

    await assert('the counterparty may not withdraw the other side\'s offer', () =>
        refuses(
            () => contractSvcFor(pendingContract()).requestTransition('c1', 'withdraw', 'agent', { userId: 'u', role: 'agent' }),
            'CONTRACT_TRANSITION_NOT_PERMITTED'
        )
    );

    // THE case the old origin-keyed rule got wrong. Agency invited (origin stays
    // 'invitation') and the agent countered, so the ball is the AGENCY's now —
    // and the agent, who is no longer the initiator, must still be able to pull
    // their own counter back. Under origin-scoping they could do neither.
    const afterAgentCounter = pendingContract({ terms_proposed_by: 'agent', terms_version: 2 });

    await assert('after the agent counters, the AGENCY approves (not the agent)', () =>
        refuses(
            () => contractSvcFor(afterAgentCounter).requestTransition('c1', 'approve', 'agent', { userId: 'u', role: 'agent' }),
            'CONTRACT_TRANSITION_NOT_PERMITTED'
        )
    );

    await assert('after the agent counters, the agent is NOT trapped — they may withdraw', async () => {
        const err = await contractSvcFor(afterAgentCounter)
            .requestTransition('c1', 'withdraw', 'agent', { userId: 'u', role: 'agent' })
            .then(() => null)
            .catch((e) => e);
        return !(err instanceof AppError && err.code === 'CONTRACT_TRANSITION_NOT_PERMITTED');
    });

    await assert('after the agent counters, the agency may no longer withdraw', () =>
        refuses(
            () => contractSvcFor(afterAgentCounter).requestTransition('c1', 'withdraw', 'agency', { userId: 'u', role: 'agency' }),
            'CONTRACT_TRANSITION_NOT_PERMITTED'
        )
    );

    // Legacy rows carry no `terms_proposed_by`; the fallback must reproduce the
    // pre-change behaviour exactly, which was keyed on `origin`. `join_request`
    // ⇒ the agent raised it ⇒ the agent may not also approve it.
    await assert('a legacy row falls back to origin: join_request ⇒ the agent proposed', () =>
        refuses(
            () =>
                contractSvcFor(
                    pendingContract({ origin: 'join_request', terms_proposed_by: null })
                ).requestTransition('c1', 'approve', 'agent', { userId: 'u', role: 'agent' }),
            'CONTRACT_TRANSITION_NOT_PERMITTED'
        )
    );

    console.log('\n── Terms negotiation: approvability ───────────────────────────────────');

    // The proposer guard runs first, so this must come from the party who WOULD
    // otherwise be entitled to approve — otherwise it proves nothing about
    // approvability.
    await assert('a contract nobody proposed terms on cannot be approved', () =>
        refuses(
            () =>
                contractSvcFor(pendingContract({ terms_proposed_by: null, terms_version: 0 }))
                    .requestTransition('c1', 'approve', 'agent', { userId: 'u', role: 'agent' }),
            'CONTRACT_TERMS_NOT_PROPOSED'
        )
    );

    // The pay-zero trap: a stated percentage split with a null share resolves to
    // a cut of 0 in applyFeeSplit. Approving it would bind the agent to it.
    await assert('a percentage split with a null share cannot be approved', () =>
        refuses(
            () =>
                contractSvcFor(
                    pendingContract({
                        terms_proposed_by: 'agent',
                        fee_split: { model: 'percentage', agent_share_percent: null, agent_flat_fee: null, currency: 'XAF' },
                    })
                ).requestTransition('c1', 'approve', 'agency', { userId: 'u', role: 'agency' }),
            'CONTRACT_FEE_SPLIT_INVALID'
        )
    );

    await assert('a flat split with no fee cannot be approved', () =>
        refuses(
            () =>
                contractSvcFor(
                    pendingContract({
                        terms_proposed_by: 'agent',
                        fee_split: { model: 'flat', agent_share_percent: null, agent_flat_fee: null, currency: 'XAF' },
                    })
                ).requestTransition('c1', 'approve', 'agency', { userId: 'u', role: 'agency' }),
            'CONTRACT_FEE_SPLIT_INVALID'
        )
    );

    await assert('a coherent split passes approvability', async () => {
        const err = await contractSvcFor(pendingContract({ terms_proposed_by: 'agent' }))
            .requestTransition('c1', 'approve', 'agency', { userId: 'u', role: 'agency' })
            .then(() => null)
            .catch((e) => e);
        return !(
            err instanceof AppError &&
            (err.code === 'CONTRACT_TERMS_NOT_PROPOSED' || err.code === 'CONTRACT_FEE_SPLIT_INVALID')
        );
    });

    console.log('\n── Terms negotiation: what each party may write ───────────────────────');

    await assert('an agent may not counter the remittance cadence', () =>
        refuses(
            () =>
                contractSvcFor(pendingContract({ terms_proposed_by: 'agency' })).counterTerms(
                    'agent', 'a1', 'c1',
                    { remittance_terms: { cadence: 'monthly' } },
                    { userId: 'u', role: 'agent' }
                ),
            'CONTRACT_TERMS_NOT_NEGOTIABLE'
        )
    );

    await assert('an agent may not counter the shipment value ceiling', () =>
        refuses(
            () =>
                contractSvcFor(pendingContract({ terms_proposed_by: 'agency' })).counterTerms(
                    'agent', 'a1', 'c1',
                    { shipment_value_ceiling: 999_999 },
                    { userId: 'u', role: 'agent' }
                ),
            'CONTRACT_TERMS_NOT_NEGOTIABLE'
        )
    );

    await assert('an agent MAY counter the fee split and coverage', async () => {
        const err = await contractSvcFor(pendingContract({ terms_proposed_by: 'agency' }))
            .counterTerms(
                'agent', 'a1', 'c1',
                { fee_split: { model: 'percentage', agent_share_percent: 45 }, coverage: { regions: ['littoral'] } },
                { userId: 'u', role: 'agent' }
            )
            .then(() => null)
            .catch((e) => e);
        return !(err instanceof AppError && err.code === 'CONTRACT_TERMS_NOT_NEGOTIABLE');
    });

    // Revising your own unanswered offer is allowed — see counterTerms. Forcing
    // a withdraw-and-re-request to fix a mistyped percentage would destroy the
    // contract row and the agent's notification thread for no safety gain.
    await assert('revising your OWN unanswered terms is allowed', async () => {
        const err = await contractSvcFor(pendingContract({ terms_proposed_by: 'agency' }))
            .counterTerms(
                'agency', 'ag1', 'c1',
                { fee_split: { model: 'percentage', agent_share_percent: 10 } },
                { userId: 'u', role: 'agency' }
            )
            .then(() => null)
            .catch((e) => e);
        return !(err instanceof AppError && err.code === 'CONTRACT_TRANSITION_NOT_PERMITTED');
    });

    await assert('a live contract refuses a direct terms edit', () =>
        refuses(
            () =>
                contractSvcFor(pendingContract({ status: 'active' })).updateTerms(
                    'ag1', 'c1',
                    { fee_split: { model: 'percentage', agent_share_percent: 20 } },
                    { userId: 'u', role: 'agency' }
                ),
            'CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED'
        )
    );

    console.log('\n── Terms negotiation: DTO button rules ────────────────────────────────');

    const dtoFor = (over: Record<string, unknown>) =>
        AgentMembershipMapper.toDto(pendingContract(over) as never);

    await assert('awaitingDecisionFrom is the counterparty of the proposer', () =>
        dtoFor({ terms_proposed_by: 'agency' }).awaitingDecisionFrom === 'agent' &&
        dtoFor({ terms_proposed_by: 'agent' }).awaitingDecisionFrom === 'agency'
    );

    // The distinction the UI depends on: nobody may approve, so the agency's
    // control is "Propose terms", not "Approve".
    await assert('awaitingDecisionFrom is null when nobody has proposed terms', () =>
        dtoFor({ terms_proposed_by: null }).awaitingDecisionFrom === null
    );

    await assert('awaitingDecisionFrom is null on a non-pending contract', () =>
        dtoFor({ status: 'active', terms_proposed_by: 'agency' }).awaitingDecisionFrom === null
    );

    await assert('initiatedBy still reports origin, independent of who proposed', () =>
        dtoFor({ origin: 'invitation', terms_proposed_by: 'agent' }).initiatedBy === 'agency'
    );

    await assert('a proposal diff reports only CHANGED leaves', () => {
        const d = diffTerms(
            { fee_split: { model: 'percentage', agent_share_percent: 30 } },
            { fee_split: { model: 'percentage', agent_share_percent: 45 } }
        );
        return d.length === 1 && d[0].path === 'fee_split.agent_share_percent' && d[0].after === 45;
    });

    await assert('a no-op proposal produces an empty diff', () =>
        diffTerms(
            { fee_split: { model: 'percentage', agent_share_percent: 30 } },
            { fee_split: { agent_share_percent: 30 } }
        ).length === 0
    );

    await assert('a scalar term group diffs at its bare path', () => {
        const d = diffTerms({ shipment_value_ceiling: null }, { shipment_value_ceiling: 50_000 });
        return d.length === 1 && d[0].path === 'shipment_value_ceiling';
    });

    // An agent cannot author an agency-reserved group, so offering them a
    // Counter button on such a proposal would render a control that always 403s.
    await assert('an agent is offered no Counter on an agency-only proposal', () => {
        const proposal = {
            _id: { toString: () => 'p1' },
            contract_id: { toString: () => 'c1' },
            agent_id: { toString: () => 'a1' },
            agency_id: { toString: () => 'ag1' },
            proposed_by_role: 'agency',
            state: 'pending',
            terms_before: {},
            proposed_terms: { remittance_terms: { cadence: 'weekly' } },
            supersedes_id: null,
            note: null,
            resolved_by_role: null,
            resolved_at: null,
            resolution_note: null,
            created_at: new Date(),
            updated_at: new Date(),
        };
        const dto = ContractTermsProposalMapper.toDto(proposal as never, 'agent');
        return (
            dto.awaitingMyDecision &&
            dto.availableActions.join(',') === 'approve,reject'
        );
    });

    await assert('an agent IS offered Counter on a fee-split proposal', () => {
        const proposal = {
            _id: { toString: () => 'p2' },
            contract_id: { toString: () => 'c1' },
            agent_id: { toString: () => 'a1' },
            agency_id: { toString: () => 'ag1' },
            proposed_by_role: 'agency',
            state: 'pending',
            terms_before: {},
            proposed_terms: { fee_split: { agent_share_percent: 20 } },
            supersedes_id: null,
            note: null,
            resolved_by_role: null,
            resolved_at: null,
            resolution_note: null,
            created_at: new Date(),
            updated_at: new Date(),
        };
        return ContractTermsProposalMapper.toDto(proposal as never, 'agent')
            .availableActions.join(',') === 'approve,reject,counter';
    });

    console.log('\n── Transfer carries the negotiated terms ──────────────────────────────');

    // A transfer lands the destination contract `active`, so it never passes
    // through `approve` and `assertTermsApprovable` cannot catch a split that
    // pays nothing. Without the carry-over the agent arrives on
    // contractDefaults.feeSplit() — a null share, i.e. a cut of ZERO — and
    // works for free until somebody notices.
    // `transfer` itself runs inside a transaction and so is unreachable in this
    // DB-free harness; `contractTermsOf` is the pure part that carries the terms,
    // and dropping a group there is the failure that matters.
    const carried = contractTermsOf(
        makeMembership({
            employment: { employment_type: 'contractor', employee_ref: 'A-91', started_at: null, ends_at: null },
            remittance_terms: { cadence: 'weekly', day_of_week: 5, day_of_month: null, grace_hours: 48 },
            coverage: { regions: ['littoral'], area: null },
            fee_split: { model: 'percentage', agent_share_percent: 42, agent_flat_fee: null, currency: 'XAF' },
            shipment_value_ceiling: 250_000,
        })
    );

    await assert('a transfer carries the fee split — the agent must not arrive on a zero cut', () =>
        carried.fee_split?.model === 'percentage' && carried.fee_split?.agent_share_percent === 42
    );

    await assert('a transfer carries the remittance cadence and grace', () =>
        carried.remittance_terms?.cadence === 'weekly' &&
        carried.remittance_terms?.day_of_week === 5 &&
        carried.remittance_terms?.grace_hours === 48
    );

    await assert('a transfer carries coverage, the value ceiling and employment', () =>
        carried.coverage?.regions?.[0] === 'littoral' &&
        carried.shipment_value_ceiling === 250_000 &&
        carried.employment?.employee_ref === 'A-91'
    );

    // Every negotiable group plus employment — a group added to the contract and
    // forgotten here would silently reset on every transfer.
    await assert('a transfer carries EVERY term group, none dropped', () =>
        ['employment', 'remittance_terms', 'coverage', 'fee_split', 'shipment_value_ceiling']
            .every((g) => (carried as Record<string, unknown>)[g] !== undefined)
    );

    // ─── Remittance schedule (B2) ─────────────────────────────────────────────
    console.log('\n── Remittance schedule ────────────────────────────────────────────────');

    const at = (iso: string) => new Date(iso);
    const due = (
        cadence: Parameters<typeof nextRemittanceDueAt>[0],
        dow: number | null,
        dom: number | null,
        grace: number,
        since: string
    ) => nextRemittanceDueAt(cadence, dow, dom, grace, at(since));

    // THE distinction that must never be flattened to a boolean: no schedule
    // means no deadline, so nothing under this contract is ever late.
    await assert('on_demand has no deadline at all', () =>
        due('on_demand', null, null, 24, '2026-08-02T10:00:00Z') === null
    );

    await assert('per_delivery is due after the grace period alone', () =>
        due('per_delivery', null, null, 6, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-02T16:00:00.000Z'
    );

    await assert('daily is due the NEXT midnight UTC, plus grace', () =>
        due('daily', null, null, 12, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-03T12:00:00.000Z'
    );

    await assert('grace_hours of 0 is honoured, not treated as a default', () =>
        due('daily', null, null, 0, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-03T00:00:00.000Z'
    );

    // 2026-08-02 is a Sunday (day 0); the next Wednesday (3) is the 5th.
    await assert('weekly lands on the agreed weekday', () =>
        due('weekly', 3, null, 0, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-05T00:00:00.000Z'
    );

    // Cash collected ON the settlement day is not due that same day — it rolls a
    // full stride, or an agent would be late the moment they collected.
    await assert('weekly on the settlement day rolls a full week forward', () =>
        due('weekly', 0, null, 0, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-09T00:00:00.000Z'
    );

    // With no settlement day agreed there is no calendar date to land on, so the
    // window rolls from the collection INSTANT — same promise, no fixed date.
    await assert('weekly with no agreed weekday falls back to a rolling 7 days', () =>
        due('weekly', null, null, 0, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-09T10:00:00.000Z'
    );

    await assert('biweekly with no agreed weekday rolls 14 days', () =>
        due('biweekly', null, null, 0, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-16T10:00:00.000Z'
    );

    await assert('monthly lands on the agreed day of the same month when still ahead', () =>
        due('monthly', null, 28, 0, '2026-08-02T10:00:00Z')!.toISOString() ===
        '2026-08-28T00:00:00.000Z'
    );

    // Day 28 is the schema ceiling precisely so this roll needs no clamping.
    await effectivelyAssertMonthlyRoll();
    async function effectivelyAssertMonthlyRoll(): Promise<void> {
        await assert('monthly rolls into the next month once the day has passed', () =>
            due('monthly', null, 28, 0, '2026-08-28T10:00:00Z')!.toISOString() ===
            '2026-09-28T00:00:00.000Z'
        );
    }

    await assert('overdue is false at exactly the deadline, true one ms later', () => {
        const args = ['per_delivery', null, null, 6, at('2026-08-02T10:00:00Z')] as const;
        return (
            !isRemittanceOverdue(...args, at('2026-08-02T16:00:00.000Z')) &&
            isRemittanceOverdue(...args, at('2026-08-02T16:00:00.001Z'))
        );
    });

    await assert('on_demand is never overdue, however long the cash is held', () =>
        !isRemittanceOverdue('on_demand', null, null, 0, at('2020-01-01T00:00:00Z'), at('2026-08-02T00:00:00Z'))
    );

    // ─── Coverage & value ceiling (B1 + B3) ───────────────────────────────────
    console.log('\n── Coverage & value ceiling ───────────────────────────────────────────');

    // THE fail-open rule. `regions: []` is the schema default on every contract
    // ever created, so treating it as "covers nowhere" would make the entire
    // roster undispatchable the moment this shipped.
    await assert('an empty coverage list means NO restriction', () =>
        contractCoversRegion({ regions: [], area: null }, 'littoral')
    );

    await assert('a missing coverage sub-document means no restriction', () =>
        contractCoversRegion(null, 'littoral')
    );

    // The other fail-open rule: orders predating the delivery-address snapshot
    // carry no region and must stay deliverable.
    await assert('an order with no region is not gated', () =>
        contractCoversRegion({ regions: ['centre'], area: null }, null)
    );

    await assert('a covered region passes', () =>
        contractCoversRegion({ regions: ['littoral', 'centre'], area: null }, 'Littoral')
    );

    await assert('an uncovered region is refused', () =>
        !contractCoversRegion({ regions: ['centre'], area: null }, 'Littoral')
    );

    // Three vocabularies meet here — free text, region keys, and whatever the
    // geocoder returned — so matching has to survive case and diacritics.
    await assert('matching survives accents and separators', () =>
        contractCoversRegion({ regions: ['Extrême-Nord'], area: null }, 'extreme nord', 'cm') &&
        contractCoversRegion({ regions: ['extreme_nord'], area: null }, 'Extrême-Nord', 'cm')
    );

    await assert('a null ceiling caps nothing', () =>
        contractAllowsShipmentValue(null, 5_000_000)
    );

    // An unknown value fails OPEN: a bookkeeping inconsistency must not block a
    // delivery through a cap that was never about it.
    await assert('an unknown shipment value is not blocked', () =>
        contractAllowsShipmentValue(50_000, null)
    );

    await assert('a shipment worth exactly the ceiling passes', () =>
        contractAllowsShipmentValue(50_000, 50_000)
    );

    await assert('a shipment one unit over the ceiling is refused', () =>
        !contractAllowsShipmentValue(50_000, 50_001)
    );

    // ─── Coverage is PICKED, not typed (write path) ───────────────────────────
    console.log('\n── Contract coverage regions: write-path canonicalisation ─────────────');

    /** The error code `normalizeContractRegions` threw, or null if it returned. */
    function normalizeCode(regions: string[], country: string | null): string | null {
        try {
            normalizeContractRegions(regions, country);
            return null;
        } catch (err) {
            return (err as AppError).code ?? null;
        }
    }

    // The asymmetry with the read path above: reading an unknown region fails
    // open, writing one is refused. A contract that says "Douala" reads as
    // covering nowhere real, and the only symptom is an agent who is never
    // offered work.
    await assert('a city name is not a region and is refused', () =>
        normalizeCode(['Douala'], 'CM') === 'CONTRACT_COVERAGE_REGION_INVALID'
    );

    await assert('a misspelt region is refused', () =>
        normalizeCode(['Litoral'], 'CM') === 'CONTRACT_COVERAGE_REGION_INVALID'
    );

    await assert('the error names every bad entry and the whole allowed list', () => {
        try {
            normalizeContractRegions(['littoral', 'Douala', 'Atlantis'], 'CM');
            return false;
        } catch (err) {
            const details = (err as AppError).details as {
                invalid: string[];
                requiredCountry: string;
                allowedRegions: string[];
            };
            return (
                details.invalid.length === 2 &&
                details.invalid.includes('Douala') &&
                details.invalid.includes('Atlantis') &&
                details.requiredCountry === 'CM' &&
                details.allowedRegions.includes('littoral') &&
                details.allowedRegions.includes('far_north')
            );
        }
    });

    // Lenient in, canonical out — a client sending the label it rendered, or the
    // French name, still lands on the key the read path compares against.
    await assert('a region key passes through unchanged', () =>
        normalizeContractRegions(['littoral', 'centre'], 'CM').join(',') === 'littoral,centre'
    );

    await assert('a localized name is canonicalised to its key', () =>
        normalizeContractRegions(['Extrême-Nord'], 'CM')[0] === 'far_north' &&
        normalizeContractRegions(['Far North'], 'CM')[0] === 'far_north'
    );

    await assert('entries collapsing onto one key are deduped', () =>
        normalizeContractRegions(['Littoral', 'littoral', ' LITTORAL '], 'CM').length === 1
    );

    // Clearing coverage is legitimate — an empty list is "no restriction", the
    // schema default on every contract ever written.
    await assert('an empty list is accepted, not treated as a bad value', () =>
        normalizeContractRegions([], 'CM').length === 0
    );

    // Legacy agencies predate the country field. There is no catalogue to check
    // against, so the check is skipped rather than refusing everything.
    await assert('an agency with no country skips the check', () =>
        normalizeContractRegions(['Douala'], null)[0] === 'Douala'
    );

    await assert('an unknown country code skips the check', () =>
        normalizeContractRegions(['Somewhere'], 'ZZ')[0] === 'Somewhere'
    );

    // The two halves must agree: what the write path stores has to be what the
    // read path matches an order's delivery region against.
    await assert('what normalize stores is what contractCoversRegion matches', () => {
        const stored = normalizeContractRegions(['Extrême-Nord'], 'CM');
        return (
            contractCoversRegion({ regions: stored, area: null }, 'Far North', 'CM') &&
            !contractCoversRegion({ regions: stored, area: null }, 'Littoral', 'CM')
        );
    });

    // ─── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(72));

    if (failed > 0) process.exit(1);
}

run().catch((err) => {
    console.error('Test run crashed:', err);
    process.exit(1);
});
