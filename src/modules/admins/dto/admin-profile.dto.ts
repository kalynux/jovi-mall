import { IAdmin } from '../admin.model';
import { UpdateAdminProfileInput } from '../validators/admin-profile.validator';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface GetAdminProfileResponseDto {
    id: string;
    name: string;
    email: string | null;
    avatarUrl: string | null;
    jobTitle: string | null;
    department: string | null;
    twoFactorEnabled: boolean;
    timezone: string;
    onboardingStep: number;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Admin self-profile response — includes last_login_ip.
 * Only returned when admin is reading their OWN profile.
 */
export interface GetAdminSelfProfileResponseDto extends GetAdminProfileResponseDto {
    lastLoginIp: string | null;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class AdminProfileMapper {
    /**
     * Map admin to public response DTO.
     * SECURITY: last_login_ip is EXCLUDED.
     */
    static toResponseDto(admin: IAdmin): GetAdminProfileResponseDto {
        return {
            id: admin._id.toString(),
            name: admin.name,
            email: admin.email ?? null,
            avatarUrl: admin.avatar_url,
            jobTitle: admin.job_title,
            department: admin.department,
            twoFactorEnabled: admin.two_factor_enabled,
            timezone: admin.timezone,
            onboardingStep: admin.onboarding_step,
            createdAt: admin.created_at,
            updatedAt: admin.updated_at,
        };
    }

    /**
     * Map admin to self-profile response DTO.
     * SECURITY: Includes last_login_ip — only safe to send to the same admin.
     */
    static toSelfResponseDto(admin: IAdmin): GetAdminSelfProfileResponseDto {
        return {
            ...AdminProfileMapper.toResponseDto(admin),
            lastLoginIp: admin.last_login_ip,
        };
    }

    static toUpdatePayload(input: UpdateAdminProfileInput): Partial<IAdmin> {
        const payload: Partial<IAdmin> = {};

        if (input.name !== undefined) payload.name = input.name;
        if (input.avatar_url !== undefined) payload.avatar_url = input.avatar_url as string | null;
        if (input.job_title !== undefined) payload.job_title = input.job_title as string | null;
        if (input.department !== undefined) payload.department = input.department as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;

        return payload;
    }
}
