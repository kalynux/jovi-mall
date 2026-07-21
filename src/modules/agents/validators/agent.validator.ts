import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import { AGENT_CONFIG } from '../config/agent.config';

// ─── Re-usable sub-schemas ────────────────────────────────────────────────────

const VehicleInfoSchema = z.object({
    vehicle_type: z.enum(['bike', 'car', 'van', 'truck']),
    plate_number: z.string().trim().nullable().optional(),
    color: z.string().min(1).max(50).trim(),
});

const LegalIdentitySchema = z.object({
    drivers_license_number: z.string().trim().nullable().optional(),
    national_id_number: z.string().trim().nullable().optional(),
});

const EmergencyContactSchema = z.object({
    name: z.string().min(1).max(100).trim(),
    phone: z.string().min(6).max(20).trim(),
});

const ObjectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

// ─── Onboarding (unchanged contract — the mobile app already ships this) ─────

export const AgentOnboardingStep1Schema = z.object({
    vehicle_info: VehicleInfoSchema,
});
export type AgentOnboardingStep1Input = z.infer<typeof AgentOnboardingStep1Schema>;

export const AgentOnboardingStep2Schema = z.object({
    /** Set to true to skip this step without providing identity data. */
    skip: z.boolean().optional().default(false),
    avatar_url: z.string().url('avatar_url must be a valid URL').nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
});
export type AgentOnboardingStep2Input = z.infer<typeof AgentOnboardingStep2Schema>;

// ─── Profile ──────────────────────────────────────────────────────────────────

export const UpdateAgentProfileSchema = z.object({
    name: z.string().min(1).max(100).trim().optional(),
    avatar_url: z.string().url().nullable().optional(),
    timezone: z.string().min(1).trim().optional(),
    preferred_language: z.enum(SUPPORTED_LANGUAGES).optional(),
    vehicle_info: VehicleInfoSchema.optional(),
    legal_identity: LegalIdentitySchema.optional(),
    emergency_contact: EmergencyContactSchema.nullable().optional(),
});
export type UpdateAgentProfileInput = z.infer<typeof UpdateAgentProfileSchema>;

// ─── Preferences & settings ───────────────────────────────────────────────────

export const UpdateAgentPreferencesSchema = z
    .object({
        notify_on_assignment: z.boolean().optional(),
        notify_on_shipment_update: z.boolean().optional(),
        navigation_app: z.enum(['google_maps', 'waze', 'apple_maps', 'none']).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one preference is required' });
export type UpdateAgentPreferencesInput = z.infer<typeof UpdateAgentPreferencesSchema>;

export const UpdateAgentSettingsSchema = z
    .object({
        /**
         * Bounded at the platform ceiling here as well as in the service: a
         * validation error explains the limit to the caller, whereas silent
         * clamping in the service would look like the write was ignored.
         */
        max_concurrent_shipments: z
            .number()
            .int()
            .min(1)
            .max(AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX)
            .optional(),
        auto_accept_assignments: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one setting is required' });
export type UpdateAgentSettingsInput = z.infer<typeof UpdateAgentSettingsSchema>;

// ─── Availability ─────────────────────────────────────────────────────────────

export const SetAvailabilitySchema = z.object({
    state: z.enum(['online', 'offline', 'on_break']),
    reason: z.string().max(200).trim().nullable().optional().default(null),
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
        app_version: z.string().max(50).trim().nullable().optional(),
        location_permission: z.enum(['always', 'while_in_use', 'denied', 'unknown']).optional(),
        location_services_enabled: z.boolean().nullable().optional(),
        background_location_enabled: z.boolean().nullable().optional(),
        battery_optimization_exempt: z.boolean().nullable().optional(),
        push_enabled: z.boolean().nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one capability is required' });
export type ReportDeviceCapabilitiesInput = z.infer<typeof ReportDeviceCapabilitiesSchema>;

// ─── Invites (agency side) ────────────────────────────────────────────────────

export const InviteAgentSchema = z.object({
    email: z.string().trim().email().toLowerCase(),
});
export type InviteAgentInput = z.infer<typeof InviteAgentSchema>;

export const ListInvitesQuerySchema = z.object({
    status: z.enum(['pending', 'accepted', 'declined', 'revoked']).optional(),
});

// ─── Membership (agency side) ─────────────────────────────────────────────────

export const MembershipIdParamSchema = z.object({ membershipId: ObjectIdSchema });

export const SuspendMembershipSchema = z.object({
    reason: z.string().min(1).max(300).trim(),
});
export type SuspendMembershipInput = z.infer<typeof SuspendMembershipSchema>;

export const RemoveMembershipSchema = z.object({
    reason: z.string().max(300).trim().nullable().optional().default(null),
});
export type RemoveMembershipInput = z.infer<typeof RemoveMembershipSchema>;

export const DeclineRequestSchema = RemoveMembershipSchema;

export const UpdateEmploymentSchema = z
    .object({
        employment_type: z.enum(['employee', 'contractor', 'freelancer']).optional(),
        employee_ref: z.string().max(60).trim().nullable().optional(),
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

export const ListMembershipsQuerySchema = z.object({
    status: z.enum(['pending', 'rejected', 'active', 'paused', 'suspended', 'deactivated']).optional(),
});

// ─── Membership (agent side) ──────────────────────────────────────────────────

export const RequestToJoinSchema = z.object({
    agencyId: ObjectIdSchema,
});
export type RequestToJoinInput = z.infer<typeof RequestToJoinSchema>;

// ─── Membership (admin side) ──────────────────────────────────────────────────

export const TransferAgentSchema = z.object({
    agentId: ObjectIdSchema,
    fromAgencyId: ObjectIdSchema,
    toAgencyId: ObjectIdSchema,
    reason: z.string().max(300).trim().nullable().optional().default(null),
});
export type TransferAgentInput = z.infer<typeof TransferAgentSchema>;

// ─── Tracking allow (admin / agency) ──────────────────────────────────────────

export const SetTrackingAllowedSchema = z.object({
    allowed: z.boolean(),
    /** Required when disabling — a silent revocation is unauditable. */
    reason: z.string().max(300).trim().nullable().optional().default(null),
}).refine((v) => v.allowed || (v.reason !== null && v.reason !== undefined && v.reason.length > 0), {
    message: 'A reason is required when disabling tracking',
    path: ['reason'],
});
export type SetTrackingAllowedInput = z.infer<typeof SetTrackingAllowedSchema>;

// ─── Agent account status (admin) ─────────────────────────────────────────────

export const SetAgentStatusSchema = z.object({
    status: z.enum(['pending_verification', 'active', 'inactive', 'suspended']),
    reason: z.string().max(300).trim().nullable().optional().default(null),
}).refine((v) => v.status !== 'suspended' || (v.reason !== null && v.reason !== undefined && v.reason.length > 0), {
    message: 'A reason is required when suspending an agent',
    path: ['reason'],
});
export type SetAgentStatusInput = z.infer<typeof SetAgentStatusSchema>;

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
