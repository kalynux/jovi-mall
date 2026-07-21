import {
    IDeliveryAgent,
    IAgentVehicleInfo,
    IAgentEmergencyContact,
    IAgentAvailability,
    IAgentWorkingState,
    IAgentDeviceCapabilities,
    IAgentPreferences,
    IAgentSettings,
    AgentTrackingStateStatus,
} from '../models/agent.model';
import { IGeoPoint } from '../../../core/types/geo.types';
import { UpdateAgentProfileInput } from '../validators/agent.validator';
import { AGENT_CONFIG } from '../config/agent.config';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface AgentTrackingDto {
    /** The business flag. geo-tracker enforces this; it does not decide it. */
    allowed: boolean;
    reason: string | null;
    changedAt: Date;
    changedByRole: string | null;
}

export interface AgentTrackingStateDto {
    /** Already staleness-corrected — never reports `streaming` for a dead feed. */
    status: AgentTrackingStateStatus;
    lastPosition: IGeoPoint | null;
    lastReportedAt: Date | null;
    source: string | null;
    /** True when the mirror is too old to be believed. */
    isStale: boolean;
}

export interface GetAgentProfileResponseDto {
    id: string;
    name: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    avatarUrl: string | null;
    vehicleInfo: IAgentVehicleInfo | null;
    /**
     * SECURITY: legal_identity (drivers_license_number, national_id_number)
     * is NEVER included in this response. Admin-only access via admin endpoints.
     */
    emergencyContact: IAgentEmergencyContact | null;
    availability: IAgentAvailability;
    workingState: IAgentWorkingState;
    tracking: AgentTrackingDto;
    device: IAgentDeviceCapabilities;
    lastKnownTrackingState: AgentTrackingStateDto;
    preferences: IAgentPreferences;
    settings: IAgentSettings;
    wa: { verified: boolean; name?: string } | null;
    timezone: string;
    preferredLanguage: string;
    status: string;
    statusReason: string | null;
    onboardingStep: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgentCompletionStatusDto {
    onboardingStep: number;
    isComplete: boolean;
    missingFields: string[];
    stepLabel: string;
}

/** Compact shape for agency roster lists. */
export interface AgentRosterEntryDto {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    avatarUrl: string | null;
    status: string;
    vehicleInfo: IAgentVehicleInfo | null;
    availability: IAgentAvailability['state'];
    workingState: IAgentWorkingState['state'];
    activeShipmentCount: number;
    trackingAllowed: boolean;
    trustScore: number;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class AgentProfileMapper {
    /**
     * SECURITY:
     * - legal_identity fields are NEVER included
     * - agency membership is NOT embedded here: an agent may serve several
     *   agencies, and which of them the caller may see is the membership
     *   endpoints' business, not this mapper's
     */
    static toResponseDto(agent: IDeliveryAgent, now: Date = new Date()): GetAgentProfileResponseDto {
        return {
            id: agent._id.toString(),
            name: agent.name,
            email: agent.email ?? null,
            emailVerified: agent.email_verified,
            phone: agent.phone ?? null,
            phoneVerified: agent.phone_verified,
            avatarUrl: agent.avatar_url,
            vehicleInfo: agent.vehicle_info,
            emergencyContact: agent.emergency_contact,
            availability: agent.availability,
            workingState: agent.working_state,
            tracking: {
                allowed: agent.tracking?.allowed ?? false,
                reason: agent.tracking?.reason ?? null,
                changedAt: agent.tracking?.changed_at,
                changedByRole: agent.tracking?.changed_by_role ?? null,
            },
            device: agent.device,
            lastKnownTrackingState: AgentProfileMapper.toTrackingStateDto(agent, now),
            preferences: agent.preferences,
            settings: agent.settings,
            wa: agent.wa ? { verified: agent.wa.verified, name: agent.wa.name } : null,
            timezone: agent.timezone,
            preferredLanguage: agent.preferred_language,
            status: agent.status,
            statusReason: agent.status_reason ?? null,
            onboardingStep: agent.onboarding_step,
            createdAt: agent.created_at,
            updatedAt: agent.updated_at,
        };
    }

    /**
     * Staleness is applied here rather than trusted from storage: a stored
     * `streaming` becomes a lie the moment geo-tracker stops writing, and
     * nothing would ever correct it. Computing on read means the mirror
     * degrades honestly on its own.
     */
    static toTrackingStateDto(agent: IDeliveryAgent, now: Date = new Date()): AgentTrackingStateDto {
        const state = agent.last_known_tracking_state;
        const reportedAt = state?.last_reported_at ?? null;
        const isStale = AgentProfileMapper.isStale(reportedAt, now);
        const stored = state?.status ?? 'unknown';

        return {
            status: stored === 'streaming' && isStale ? 'stale' : stored,
            lastPosition: state?.last_position ?? null,
            lastReportedAt: reportedAt,
            source: state?.source ?? null,
            isStale,
        };
    }

    static toRosterEntryDto(agent: IDeliveryAgent): AgentRosterEntryDto {
        return {
            id: agent._id.toString(),
            name: agent.name,
            email: agent.email ?? null,
            phone: agent.phone ?? null,
            avatarUrl: agent.avatar_url,
            status: agent.status,
            vehicleInfo: agent.vehicle_info,
            availability: agent.availability?.state ?? 'offline',
            workingState: agent.working_state?.state ?? 'idle',
            activeShipmentCount: agent.working_state?.active_shipment_count ?? 0,
            trackingAllowed: agent.tracking?.allowed ?? false,
            trustScore: agent.cod?.trust_score ?? 100,
        };
    }

    static toUpdatePayload(input: UpdateAgentProfileInput): Partial<IDeliveryAgent> {
        const payload: Partial<IDeliveryAgent> = {};

        if (input.name !== undefined) payload.name = input.name;
        if (input.avatar_url !== undefined) payload.avatar_url = input.avatar_url as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.preferred_language !== undefined) payload.preferred_language = input.preferred_language;
        if (input.vehicle_info !== undefined) payload.vehicle_info = input.vehicle_info as IAgentVehicleInfo;
        if (input.legal_identity !== undefined) {
            payload.legal_identity = {
                drivers_license_number: input.legal_identity.drivers_license_number ?? null,
                national_id_number: input.legal_identity.national_id_number ?? null,
            };
        }
        if (input.emergency_contact !== undefined) {
            payload.emergency_contact = input.emergency_contact as IAgentEmergencyContact | null;
        }

        return payload;
    }

    private static isStale(reportedAt: Date | null, now: Date): boolean {
        if (!reportedAt) return true;
        const ageSeconds = (now.getTime() - new Date(reportedAt).getTime()) / 1000;
        return ageSeconds > AGENT_CONFIG.TRACKING_STATE_STALE_AFTER_SECONDS;
    }
}
