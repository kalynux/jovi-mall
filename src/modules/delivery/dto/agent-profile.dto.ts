import { IDeliveryAgent, IAgentVehicleInfo, IAgentEmergencyContact, IAgentLiveState } from '../delivery-agent.model';
import { UpdateAgentProfileInput } from '../validators/agent-onboarding.validator';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface GetAgentProfileResponseDto {
    id: string;
    agencyId: string | null;
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
    liveState: IAgentLiveState;
    wa: { verified: boolean; name?: string } | null;
    timezone: string;
    status: string;
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

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class AgentProfileMapper {
    /**
     * SECURITY:
     * - legal_identity fields are NEVER included
     * - Only vehicle display info and live state are exposed
     */
    static toResponseDto(agent: IDeliveryAgent): GetAgentProfileResponseDto {
        return {
            id: agent._id.toString(),
            agencyId: agent.agency_id?.toString() ?? null,
            name: agent.name,
            email: agent.email ?? null,
            emailVerified: agent.email_verified,
            phone: agent.phone ?? null,
            phoneVerified: agent.phone_verified,
            avatarUrl: agent.avatar_url,
            vehicleInfo: agent.vehicle_info,
            emergencyContact: agent.emergency_contact,
            liveState: agent.live_state,
            wa: agent.wa ? { verified: agent.wa.verified, name: agent.wa.name } : null,
            timezone: agent.timezone,
            status: agent.status,
            onboardingStep: agent.onboarding_step,
            createdAt: agent.created_at,
            updatedAt: agent.updated_at,
        };
    }

    static toUpdatePayload(input: UpdateAgentProfileInput): Partial<IDeliveryAgent> {
        const payload: Partial<IDeliveryAgent> = {};

        if (input.name !== undefined) payload.name = input.name;
        if (input.avatar_url !== undefined) payload.avatar_url = input.avatar_url as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.vehicle_info !== undefined) payload.vehicle_info = input.vehicle_info as IAgentVehicleInfo;
        if (input.legal_identity !== undefined) {
            payload.legal_identity = {
                drivers_license_number: input.legal_identity.drivers_license_number ?? null,
                national_id_number: input.legal_identity.national_id_number ?? null,
            };
        }
        if (input.emergency_contact !== undefined) payload.emergency_contact = input.emergency_contact as IAgentEmergencyContact | null;

        return payload;
    }
}
