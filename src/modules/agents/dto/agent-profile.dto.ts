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
import mongoose from 'mongoose';
import { IGeoPoint } from '../../../core/types/geo.types';
import { UpdateAgentProfileInput } from '../validators/agent.validator';
import { AGENT_CONFIG } from '../config/agent.config';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { mergeVehicleInfo } from '../domain/vehicle-info';

// ─── Response DTOs ────────────────────────────────────────────────────────────

/**
 * Vehicle facts as they go on the wire. Keys stay snake_case (the stored shape
 * the app already reads), and `photo_file_id` is NEVER emitted — it is resolved
 * into `photo`, the same `FileDetail` object the avatar and product media use.
 */
export interface AgentVehicleInfoDto {
    vehicle_type: IAgentVehicleInfo['vehicle_type'];
    plate_number: string | null;
    /** Lowercase token from `VEHICLE_COLORS`, or free text. Localize on the client. */
    color: string;
    photo: FileDetail | null;
}

/**
 * The vehicle without its photo — what compact list surfaces (the agency
 * roster) return. Separate from {@link AgentVehicleInfoDto} rather than
 * `photo: null` on the same shape: a list that never resolves the file would
 * otherwise report "this agent has no vehicle photo", which is a different
 * claim from "this view does not carry it".
 */
export type AgentVehicleSummaryDto = Omit<AgentVehicleInfoDto, 'photo'>;

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

export interface AgentCapacityDto {
    maxActiveShipments: number;
    activeShipmentCount: number;
    /** How many more shipments this agent can accept right now. Never negative. */
    remaining: number;
}

export interface GetAgentProfileResponseDto {
    id: string;
    name: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    /** Profile avatar as a resolved file object (same shape as product media), or null. */
    avatar: FileDetail | null;
    vehicleInfo: AgentVehicleInfoDto | null;
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
    /**
     * Read-only. `maxActiveShipments` is written from the agent's billing plan
     * (see api-doc/agent/billing.md), never from a profile write — so the app
     * can show "3 of 20" but must not offer a control for it.
     */
    capacity: AgentCapacityDto;
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
    avatar: FileDetail | null;
    status: string;
    vehicleInfo: AgentVehicleSummaryDto | null;
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
    static toResponseDto(
        agent: IDeliveryAgent,
        now: Date = new Date(),
        avatar: FileDetail | null = null,
        vehiclePhoto: FileDetail | null = null,
    ): GetAgentProfileResponseDto {
        return {
            id: agent._id.toString(),
            name: agent.name,
            email: agent.email ?? null,
            emailVerified: agent.email_verified,
            phone: agent.phone ?? null,
            phoneVerified: agent.phone_verified,
            // Resolved by the caller (the agent has an id-only reference on the doc).
            avatar,
            vehicleInfo: AgentProfileMapper.toVehicleInfoDto(agent.vehicle_info, vehiclePhoto),
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
            capacity: AgentProfileMapper.toCapacityDto(agent),
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
     * The vehicle with its photo resolved. Built field-by-field rather than
     * spread, so `photo_file_id` cannot leak onto the wire when the stored
     * sub-document grows a field.
     */
    static toVehicleInfoDto(
        vehicle: IAgentVehicleInfo | null,
        photo: FileDetail | null = null,
    ): AgentVehicleInfoDto | null {
        if (!vehicle) return null;
        return { ...AgentProfileMapper.toVehicleSummaryDto(vehicle)!, photo };
    }

    static toVehicleSummaryDto(vehicle: IAgentVehicleInfo | null): AgentVehicleSummaryDto | null {
        if (!vehicle) return null;
        return {
            vehicle_type: vehicle.vehicle_type,
            plate_number: vehicle.plate_number ?? null,
            color: vehicle.color,
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

    /**
     * `capacity.active_shipment_count` is the authoritative in-flight count — it
     * is the value `tryReserveCapacity` compare-and-sets on accept. The parallel
     * `working_state.active_shipment_count` is a recomputed label input and can
     * lag it, so it must not be reported as the count anywhere.
     */
    static toCapacityDto(agent: IDeliveryAgent): AgentCapacityDto {
        const maxActiveShipments =
            agent.capacity?.max_active_shipments ?? AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_DEFAULT;
        const activeShipmentCount = agent.capacity?.active_shipment_count ?? 0;

        return {
            maxActiveShipments,
            activeShipmentCount,
            remaining: Math.max(0, maxActiveShipments - activeShipmentCount),
        };
    }

    static toRosterEntryDto(agent: IDeliveryAgent, avatar: FileDetail | null = null): AgentRosterEntryDto {
        return {
            id: agent._id.toString(),
            name: agent.name,
            email: agent.email ?? null,
            phone: agent.phone ?? null,
            avatar,
            status: agent.status,
            vehicleInfo: AgentProfileMapper.toVehicleSummaryDto(agent.vehicle_info),
            availability: agent.availability?.state ?? 'offline',
            workingState: agent.working_state?.state ?? 'idle',
            activeShipmentCount: agent.capacity?.active_shipment_count ?? 0,
            trackingAllowed: agent.tracking?.allowed ?? false,
            trustScore: agent.cod?.trust_score ?? 100,
        };
    }

    /**
     * `currentVehicleInfo` is required for the merge, not the replace, that
     * `vehicle_info` needs: `plate_number` and `photo_file_id` are `clearable()`,
     * which promises *omit = unchanged*. Replacing the sub-document wholesale —
     * as this used to — breaks that promise, and a client fixing a plate number
     * silently drops the photo with a 200 back.
     */
    static toUpdatePayload(
        input: UpdateAgentProfileInput,
        currentVehicleInfo: IAgentVehicleInfo | null = null,
    ): Partial<IDeliveryAgent> {
        const payload: Partial<IDeliveryAgent> = {};

        if (input.name !== undefined) payload.name = input.name;
        if (input.avatar_file_id !== undefined) {
            payload.avatar_file_id = input.avatar_file_id ? new mongoose.Types.ObjectId(input.avatar_file_id) : null;
        }
        if (input.avatar_url !== undefined) payload.avatar_url = input.avatar_url as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.preferred_language !== undefined) payload.preferred_language = input.preferred_language;
        if (input.vehicle_info !== undefined) {
            payload.vehicle_info = mergeVehicleInfo(currentVehicleInfo, input.vehicle_info);
        }
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
