import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import { AGENT_CONFIG } from '../config/agent.config';
import { clearable } from '../../../core/validation/zod.helpers';
import { PhoneNumberSchema } from '../../../core/validation/phone';
import { PayoutDetailsZodSchema } from '../../../core/types/payout.types';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const ObjectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

const VehicleInfoSchema = z.object({
    vehicle_type: z.enum(['bike', 'car', 'van', 'truck']),
    plate_number: clearable(z.string().trim()),
    /**
     * Deliberately NOT a `z.enum` of the colour palette. The app writes a token
     * from `VEHICLE_COLORS`, but a hard enum would fail validation for every
     * agent onboarded before the palette and for the app's own "another colour"
     * escape hatch. `mergeVehicleInfo` normalizes on write instead; see
     * `domain/vehicle-info.ts`.
     */
    color: z.string().min(1).max(50).trim(),
    /** Photo of the vehicle: id of a file uploaded via POST /api/files/upload ('' / null clears it). */
    photo_file_id: clearable(ObjectIdSchema),
});

const LegalIdentitySchema = z.object({
    drivers_license_number: clearable(z.string().trim()),
    national_id_number: clearable(z.string().trim()),
});

const EmergencyContactSchema = z.object({
    name: z.string().min(1).max(100).trim(),
    // The one number that gets dialled in the situation where nobody has time
    // to work out a missing country code.
    phone: PhoneNumberSchema,
});

// ─── Onboarding (unchanged contract — the mobile app already ships this) ─────

export const AgentOnboardingStep1Schema = z.object({
    vehicle_info: VehicleInfoSchema,
});
export type AgentOnboardingStep1Input = z.infer<typeof AgentOnboardingStep1Schema>;

export const AgentOnboardingStep2Schema = z.object({
    /** Set to true to skip this step without providing identity data. */
    skip: z.boolean().optional().default(false),
    avatar_url: clearable(z.string().url('avatar_url must be a valid URL')),
    timezone: z.string().min(1).trim().optional(),
});
export type AgentOnboardingStep2Input = z.infer<typeof AgentOnboardingStep2Schema>;

// ─── Payout destination ──────────────────────────────────────────────────────

/**
 * Where the platform pays this agent's earnings.
 *
 * Deliberately NOT part of onboarding: an agent can work, and accrue a balance,
 * before they have told us where to send it — the payout request is what needs a
 * destination, not the delivery. The same shared schema vendor and agency use, so
 * "at least one, at most three, first is preferred" means the same thing for
 * every role.
 */
export const SetAgentPayoutMethodsSchema = z.object({
    payout_details: PayoutDetailsZodSchema,
});
export type SetAgentPayoutMethodsInput = z.infer<typeof SetAgentPayoutMethodsSchema>;

// ─── Profile ──────────────────────────────────────────────────────────────────

export const UpdateAgentProfileSchema = z.object({
    name: z.string().min(1).max(100).trim().optional(),
    // Canonical avatar: id of a file uploaded via POST /api/files/upload ('' / null clears it).
    avatar_file_id: clearable(ObjectIdSchema),
    /** @deprecated Prefer avatar_file_id. Accepted for backward compatibility. */
    avatar_url: clearable(z.string().url()),
    timezone: z.string().min(1).trim().optional(),
    preferred_language: z.enum(SUPPORTED_LANGUAGES).optional(),
    vehicle_info: VehicleInfoSchema.optional(),
    legal_identity: LegalIdentitySchema.optional(),
    emergency_contact: EmergencyContactSchema.nullable().optional(),
});
export type UpdateAgentProfileInput = z.infer<typeof UpdateAgentProfileSchema>;

// ─── Preferences & settings ───────────────────────────────────────────────────

/**
 * Client-side choices only. Notification delivery is NOT configured here — that
 * is `PATCH /api/agent/notification-preferences`, over `AgentNotificationPreference`.
 * Two `notify_*` flags used to live here and gated nothing, which made turning
 * them off look like it worked.
 */
export const UpdateAgentPreferencesSchema = z
    .object({
        navigation_app: z.enum(['google_maps', 'waze', 'apple_maps', 'none']).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one preference is required' });
export type UpdateAgentPreferencesInput = z.infer<typeof UpdateAgentPreferencesSchema>;

/**
 * Dispatch behaviour the agent controls.
 *
 * The concurrency cap is deliberately NOT here: it is `capacity.max_active_shipments`,
 * written from the agent's billing plan (`AgentPlanCapacityConsumer`) and readable
 * on the profile. A `max_concurrent_shipments` key used to be accepted here and was
 * silently dropped by the strict Mongoose cast, because no such field exists.
 */
export const UpdateAgentDispatchSettingsSchema = z
    .object({
        auto_accept_assignments: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one setting is required' });
export type UpdateAgentDispatchSettingsInput = z.infer<typeof UpdateAgentDispatchSettingsSchema>;

// ─── Availability ─────────────────────────────────────────────────────────────

export const SetAvailabilitySchema = z.object({
    state: z.enum(['online', 'offline', 'on_break']),
    reason: clearable(z.string().max(200).trim()).default(null),
});
export type SetAvailabilityInput = z.infer<typeof SetAvailabilitySchema>;

// ─── Device capabilities ──────────────────────────────────────────────────────

/**
 * Every capability is nullable: `null` means "reported as unknown", which is
 * distinct from omitting the key (leave as-is) and from `false` (reported off).
 * The eligibility rules depend on that three-way distinction.
 */
export const ReportDeviceCapabilitiesSchema = z
    .object({
        platform: z.enum(['android', 'ios', 'web', 'unknown']).optional(),
        app_version: clearable(z.string().max(50).trim()),
        location_permission: z.enum(['always', 'while_in_use', 'denied', 'unknown']).optional(),
        location_services_enabled: z.boolean().nullable().optional(),
        background_location_enabled: z.boolean().nullable().optional(),
        battery_optimization_exempt: z.boolean().nullable().optional(),
        push_enabled: z.boolean().nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one capability is required' });
export type ReportDeviceCapabilitiesInput = z.infer<typeof ReportDeviceCapabilitiesSchema>;

// ─── Directory & contract requests ────────────────────────────────────────────

/**
 * The agency browsing the agent directory.
 *
 * `lng`/`lat`/`radius_km` are a unit — a radius with no centre, or a centre
 * with no radius, is a mistake rather than a partial filter, so the refine
 * rejects it instead of silently ignoring the half that was supplied.
 */
export const BrowseAgentsQuerySchema = z
    .object({
        search: z.string().trim().optional(),
        vehicle_type: z.enum(['bike', 'car', 'van', 'truck']).optional(),
        availability: z.enum(['online', 'offline', 'on_break']).optional(),
        min_trust_score: z.coerce.number().int().min(0).max(100).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        lat: z.coerce.number().min(-90).max(90).optional(),
        radius_km: z.coerce.number().positive().max(500).optional(),
        sort: z.enum(['trust', 'name']).default('trust'),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .refine(
        (v) =>
            [v.lng, v.lat, v.radius_km].every((x) => x === undefined) ||
            [v.lng, v.lat, v.radius_km].every((x) => x !== undefined),
        { message: 'lng, lat and radius_km must be supplied together', path: ['radius_km'] }
    );
export type BrowseAgentsQuery = z.infer<typeof BrowseAgentsQuerySchema>;

/**
 * The agent browsing the agency directory — the agent-relevant subset of the
 * vendor's BrowseAgenciesQuerySchema (modules/agency-connections). The pricing
 * and returns-policy filters are vendor concerns and are deliberately absent.
 */
export const BrowseAgenciesForAgentQuerySchema = z.object({
    search: z.string().trim().optional(),
    region: z.string().trim().optional(),
    hq_city: z.string().trim().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type BrowseAgenciesForAgentQuery = z.infer<typeof BrowseAgenciesForAgentQuerySchema>;

// ─── Negotiated term groups ───────────────────────────────────────────────────

/**
 * The four groups, defined once and composed per party below.
 *
 * They were inline in UpdateContractTermsSchema until the terms became
 * negotiable; now the same shapes are validated on a request body, a counter, a
 * proposal and a patch, and four copies would drift the moment one gains a
 * bound.
 */
const EmploymentTermsSchema = z.object({
    employment_type: z.enum(['employee', 'contractor', 'freelancer']).optional(),
    employee_ref: clearable(z.string().max(60).trim()),
    started_at: z.coerce.date().nullable().optional(),
    ends_at: z.coerce.date().nullable().optional(),
});

const RemittanceTermsSchema = z.object({
    cadence: z
        .enum(['per_delivery', 'daily', 'weekly', 'biweekly', 'monthly', 'on_demand'])
        .optional(),
    /** 0=Sunday … 6=Saturday, for weekly/biweekly. */
    day_of_week: z.number().int().min(0).max(6).nullable().optional(),
    /** 1–28 — 28 rather than 31 so no month is ambiguous. */
    day_of_month: z.number().int().min(1).max(28).nullable().optional(),
    grace_hours: z.number().int().min(0).max(720).optional(),
});

/**
 * `regions` is SHAPE-checked here and VALUE-checked in the service
 * (`normalizeContractRegions`, via `AgentContractService.normalizeCoverageTerms`
 * on every write path): each entry must resolve to a region of the agency's
 * registered country, and is stored as that country's canonical region key.
 *
 * The country is not in the request body — it comes off the agency document —
 * so the check cannot live in Zod. Send keys from the same catalogue the
 * agency's location tab picks from (`locations.json`); an accented or localized
 * name is accepted and canonicalised, a city or a typo is `400
 * CONTRACT_COVERAGE_REGION_INVALID`. `[]` clears the restriction and is valid.
 */
const CoverageTermsSchema = z.object({
    regions: z.array(z.string().min(1).max(100).trim()).max(100).optional(),
    area: z
        .object({
            type: z.literal('Polygon'),
            coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
        })
        .nullable()
        .optional(),
});

const FeeSplitTermsSchema = z.object({
    model: z.enum(['percentage', 'flat']).optional(),
    agent_share_percent: z.number().min(0).max(100).nullable().optional(),
    agent_flat_fee: z.number().int().min(0).nullable().optional(),
    currency: z.string().length(3).trim().toUpperCase().optional(),
});

/**
 * Everything an AGENCY may propose or counter.
 *
 * `employment` is absent: it is the agency's internal HR record, not a
 * negotiated term, and keeps its own unilateral endpoint. See
 * NEGOTIABLE_TERM_GROUPS in the contract model for the full reasoning.
 */
export const AgencyNegotiableTermsSchema = z
    .object({
        remittance_terms: RemittanceTermsSchema.optional(),
        coverage: CoverageTermsSchema.optional(),
        fee_split: FeeSplitTermsSchema.optional(),
        shipment_value_ceiling: z.number().int().min(0).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one term is required' });
export type AgencyNegotiableTermsInput = z.infer<typeof AgencyNegotiableTermsSchema>;

/**
 * The subset an AGENT may propose or counter — what they are paid, and where
 * they will work. The service enforces the same list (assertNegotiableBy), so a
 * missed field here is caught rather than silently accepted.
 */
export const AgentNegotiableTermsSchema = z
    .object({
        coverage: CoverageTermsSchema.optional(),
        fee_split: FeeSplitTermsSchema.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one term is required' });
export type AgentNegotiableTermsInput = z.infer<typeof AgentNegotiableTermsSchema>;

// ─── Contract requests ────────────────────────────────────────────────────────

/**
 * The agency asking a specific agent to contract.
 *
 * `terms` is REQUIRED and must carry a fee split. An invitation with no numbers
 * would land the agent on the schema default, whose null share pays them zero —
 * the agent may counter what they are shown, but must be shown something.
 */
export const RequestAgentContractSchema = z.object({
    agentId: ObjectIdSchema,
    terms: AgencyNegotiableTermsSchema.refine((v) => v.fee_split !== undefined, {
        message: 'terms.fee_split is required when inviting an agent',
        path: ['fee_split'],
    }),
});
export type RequestAgentContractInput = z.infer<typeof RequestAgentContractSchema>;

/**
 * The agent applying to an agency.
 *
 * `terms` is OPTIONAL — the asymmetry with the agency's request is deliberate.
 * An agent may state an asking rate, or apply bare and let the agency propose.
 * If they do state terms, a fee split is required: coverage alone would leave
 * their own proposal carrying a null share, which the agency could not approve.
 */
export const RequestToJoinSchema = z.object({
    agencyId: ObjectIdSchema,
    terms: AgentNegotiableTermsSchema.refine((v) => v.fee_split !== undefined, {
        message: 'terms.fee_split is required when stating terms; omit terms entirely otherwise',
        path: ['fee_split'],
    }).optional(),
});
export type RequestToJoinInput = z.infer<typeof RequestToJoinSchema>;

// ─── Counters & proposals ─────────────────────────────────────────────────────

/** An agency countering the terms standing on a pending contract. */
export const CounterTermsAsAgencySchema = AgencyNegotiableTermsSchema;
/** An agent countering them. */
export const CounterTermsAsAgentSchema = AgentNegotiableTermsSchema;

export const ProposalIdParamSchema = z.object({ proposalId: ObjectIdSchema });

/** A proposed change to a LIVE contract's terms, from either side. */
export const ProposeTermsChangeAsAgencySchema = z.object({
    terms: AgencyNegotiableTermsSchema,
    note: clearable(z.string().max(300).trim()).default(null),
});
export type ProposeTermsChangeInput = z.infer<typeof ProposeTermsChangeAsAgencySchema>;

export const ProposeTermsChangeAsAgentSchema = z.object({
    terms: AgentNegotiableTermsSchema,
    note: clearable(z.string().max(300).trim()).default(null),
});

export const ResolveTermsProposalSchema = z.object({
    decision: z.enum(['approve', 'reject']),
    note: clearable(z.string().max(300).trim()).default(null),
});
export type ResolveTermsProposalInput = z.infer<typeof ResolveTermsProposalSchema>;

/** No `decision` — cancelling is the only outcome an author can produce. */
export const CancelTermsProposalSchema = z.object({
    note: clearable(z.string().max(300).trim()).default(null),
});
export type CancelTermsProposalInput = z.infer<typeof CancelTermsProposalSchema>;

/**
 * Pulling back a request you raised, or refusing one you received. Free text
 * rather than an enum: unlike an operational rejection this is a business
 * decision, and the same reasoning as RejectConnectionSchema applies.
 */
export const WithdrawContractSchema = z.object({
    reason: clearable(z.string().max(300).trim()).default(null),
});
export type WithdrawContractInput = z.infer<typeof WithdrawContractSchema>;

// ─── Membership (agency side) ─────────────────────────────────────────────────

export const MembershipIdParamSchema = z.object({ membershipId: ObjectIdSchema });

export const SuspendMembershipSchema = z.object({
    reason: z.string().min(1).max(300).trim(),
});
export type SuspendMembershipInput = z.infer<typeof SuspendMembershipSchema>;

export const RemoveMembershipSchema = z.object({
    reason: clearable(z.string().max(300).trim()).default(null),
});
export type RemoveMembershipInput = z.infer<typeof RemoveMembershipSchema>;

export const DeclineRequestSchema = RemoveMembershipSchema;

export const UpdateEmploymentSchema = z
    .object({
        employment_type: z.enum(['employee', 'contractor', 'freelancer']).optional(),
        employee_ref: clearable(z.string().max(60).trim()),
        started_at: z.coerce.date().nullable().optional(),
        ends_at: z.coerce.date().nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one employment field is required' })
    .refine((v) => !(v.started_at && v.ends_at) || v.ends_at >= v.started_at, {
        message: 'ends_at must not precede started_at',
        path: ['ends_at'],
    });
export type UpdateEmploymentInput = z.infer<typeof UpdateEmploymentSchema>;

/**
 * The agency's terms patch. Every negotiated term except the COD threshold,
 * which is bounded by the agent's shared pool and so has its own endpoint.
 *
 * `employment` is present HERE but absent from AgencyNegotiableTermsSchema, and
 * that is the difference between the two: this schema also backs the agency's
 * unilateral employment route, which writes the agency's own HR record at any
 * status. On a pending contract the service routes the rest of this body
 * through `counterTerms`; on a live one it refuses.
 *
 * The fee-split *shape* is checked here; its *coherence* (a 'percentage' model
 * carrying a share, a 'flat' one carrying a fee) is checked in the service,
 * where the stored split can be merged under the patch — a partial update that
 * changes only `model` is legitimate and must not be rejected for a field it
 * is not touching.
 */
export const UpdateContractTermsSchema = z
    .object({
        employment: EmploymentTermsSchema.optional(),
        remittance_terms: RemittanceTermsSchema.optional(),
        coverage: CoverageTermsSchema.optional(),
        fee_split: FeeSplitTermsSchema.optional(),
        shipment_value_ceiling: z.number().int().min(0).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one term is required' });
export type UpdateContractTermsInput = z.infer<typeof UpdateContractTermsSchema>;

/**
 * This contract's slice of the agent's COD pool (minor units).
 *
 * Not nullable, unlike the `max_exposure_override` it replaces: null used to
 * mean "fall back to the platform default", which is exactly the implicit
 * capacity the shared-pool model exists to remove. Granting nothing is `0`, and
 * it is the default — an agency allocates cash risk explicitly or not at all.
 *
 * Bounded here as well as in the service so the caller is told the limit rather
 * than watching a write appear to be ignored. The agent's remaining headroom is
 * the other bound and can only be checked transactionally, so it stays in
 * AgentCodThresholdService.
 */
export const SetCodLimitSchema = z.object({
    threshold: z
        .number()
        .int()
        .min(AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MIN)
        .max(AGENT_CONFIG.CONTRACT_COD_THRESHOLD_MAX),
});
export type SetCodLimitInput = z.infer<typeof SetCodLimitSchema>;

// ─── Contract status requests (both parties) ──────────────────────────────────

export const RequestIdParamSchema = z.object({ requestId: ObjectIdSchema });

export const ResolveStatusRequestSchema = z.object({
    decision: z.enum(['approve', 'reject']),
    note: clearable(z.string().max(300).trim()).default(null),
});
export type ResolveStatusRequestInput = z.infer<typeof ResolveStatusRequestSchema>;

/**
 * Pulling back a request you raised yourself. No `decision` — cancelling is the
 * only outcome the author can produce, so offering one would be a field with a
 * single legal value.
 */
export const CancelStatusRequestSchema = z.object({
    note: clearable(z.string().max(300).trim()).default(null),
});
export type CancelStatusRequestInput = z.infer<typeof CancelStatusRequestSchema>;

/**
 * A LIFECYCLE transition the agent raises on an established contract.
 *
 * Only the two that have no named endpoint. `approve`, `reject`, `withdraw` and
 * `deactivate` are absent by design: each has its own route
 * (`/memberships/:id/{approve,reject,withdraw,terminate}`) because a client
 * rendering a contract wants named buttons, not one dropdown — and leaving
 * `deactivate` here as well would be a second way to do the same thing.
 * Whether the agent may drive these at all — and whether they complete
 * immediately or wait for the agency — is the authority matrix's call, not this
 * schema's.
 */
export const RequestTransitionSchema = z.object({
    transition: z.enum(['pause', 'reactivate']),
    reason: clearable(z.string().max(300).trim()).default(null),
});
export type RequestTransitionInput = z.infer<typeof RequestTransitionSchema>;

/**
 * The "Connections" list on either side. Mirrors ListConnectionsQuerySchema
 * (modules/agency-connections/connection.validator.ts) — same pagination
 * defaults, and an omitted `status` means **every** status, terminal rows
 * included, so one call can render a relationship history.
 */
export const ListMembershipsQuerySchema = z.object({
    status: z
        .enum(['pending', 'rejected', 'withdrawn', 'active', 'paused', 'suspended', 'deactivated'])
        .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ─── Membership (admin side) ──────────────────────────────────────────────────

export const TransferAgentSchema = z.object({
    agentId: ObjectIdSchema,
    fromAgencyId: ObjectIdSchema,
    toAgencyId: ObjectIdSchema,
    reason: clearable(z.string().max(300).trim()).default(null),
});
export type TransferAgentInput = z.infer<typeof TransferAgentSchema>;

// ─── Tracking allow (admin / agency) ──────────────────────────────────────────

export const SetTrackingAllowedSchema = z.object({
    allowed: z.boolean(),
    /** Required when disabling — a silent revocation is unauditable. */
    reason: clearable(z.string().max(300).trim()).default(null),
}).refine((v) => v.allowed || (v.reason !== null && v.reason !== undefined && v.reason.length > 0), {
    message: 'A reason is required when disabling tracking',
    path: ['reason'],
});
export type SetTrackingAllowedInput = z.infer<typeof SetTrackingAllowedSchema>;

// ─── Agent account status (admin) ─────────────────────────────────────────────

export const SetAgentStatusSchema = z.object({
    status: z.enum(['pending_verification', 'active', 'inactive', 'suspended']),
    reason: clearable(z.string().max(300).trim()).default(null),
}).refine((v) => v.status !== 'suspended' || (v.reason !== null && v.reason !== undefined && v.reason.length > 0), {
    message: 'A reason is required when suspending an agent',
    path: ['reason'],
});
export type SetAgentStatusInput = z.infer<typeof SetAgentStatusSchema>;

// ─── Platform gates: KYC & ban (admin) ────────────────────────────────────────

/**
 * KYC verdict.
 *
 * `AgentGateService.setKycStatus` does not validate its own `status` argument —
 * this schema is the only thing standing between a typo and an agent stuck
 * ineligible, since `agent-eligibility.service.ts` passes only on `'verified'`.
 */
export const SetKycStatusSchema = z
    .object({
        status: z.enum(['unverified', 'pending', 'verified', 'rejected']),
        /**
         * External KYC provider reference, for audit. Deliberately NOT
         * `.default(null)`: the service only writes it when the key is present,
         * so defaulting would silently wipe a stored reference every time an
         * admin changed status without re-sending it.
         */
        reference: clearable(z.string().max(200).trim()),
        rejectionReason: clearable(z.string().max(300).trim()).default(null),
    })
    .refine(
        (v) =>
            v.status !== 'rejected' ||
            (v.rejectionReason !== null && v.rejectionReason !== undefined && v.rejectionReason.length > 0),
        { message: 'A rejection reason is required when rejecting KYC', path: ['rejectionReason'] }
    );
export type SetKycStatusInput = z.infer<typeof SetKycStatusSchema>;

/**
 * Platform ban. An override, not a cascade — contracts are left as they are and
 * every gate consults the flag instead, so un-banning restores exactly the
 * prior state.
 */
export const SetPlatformBanSchema = z
    .object({
        banned: z.boolean(),
        /** Required when banning — an unexplained ban is unappealable. */
        reason: clearable(z.string().max(300).trim()).default(null),
    })
    .refine((v) => !v.banned || (v.reason !== null && v.reason !== undefined && v.reason.length > 0), {
        message: 'A reason is required when banning an agent',
        path: ['reason'],
    });
export type SetPlatformBanInput = z.infer<typeof SetPlatformBanSchema>;

// ─── Agent COD threshold (admin) ──────────────────────────────────────────────

/**
 * The agent's own COD pool — NOT a contract's slice of it.
 *
 * Bounded by AGENT_CONFIG.COD_THRESHOLD_{MIN,MAX}, deliberately different
 * constants from SetCodLimitSchema's CONTRACT_COD_THRESHOLD_{MIN,MAX}: the pool
 * is the sum every contract sub-allocates from, so its ceiling is higher.
 * Lowering below what contracts already hold is rejected in the service, where
 * the allocation can be read transactionally.
 */
export const SetAgentThresholdSchema = z.object({
    maxThreshold: z
        .number()
        .int()
        .min(AGENT_CONFIG.COD_THRESHOLD_MIN)
        .max(AGENT_CONFIG.COD_THRESHOLD_MAX),
});
export type SetAgentThresholdInput = z.infer<typeof SetAgentThresholdSchema>;

// ─── Internal API (geo-tracker → jovi-mall) ───────────────────────────────────

export const AgentIdParamSchema = z.object({ agentId: ObjectIdSchema });

export const ResolveTrackingPoliciesSchema = z.object({
    agentIds: z.array(ObjectIdSchema).min(1).max(200),
});
export type ResolveTrackingPoliciesInput = z.infer<typeof ResolveTrackingPoliciesSchema>;

export const ReportTrackingStateSchema = z.object({
    status: z.enum(['unknown', 'streaming', 'stale', 'disconnected']),
    position: z
        .object({
            type: z.literal('Point').optional().default('Point'),
            coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
        })
        .nullable()
        .optional(),
    reportedAt: z.coerce.date().optional(),
    /** Tri-state; omit to leave untouched, null to report unknown. */
    locationServicesEnabled: z.boolean().nullable().optional(),
    backgroundLocationEnabled: z.boolean().nullable().optional(),
});
export type ReportTrackingStateInput = z.infer<typeof ReportTrackingStateSchema>;

export const EligibilityQuerySchema = z.object({
    agencyId: ObjectIdSchema,
});
