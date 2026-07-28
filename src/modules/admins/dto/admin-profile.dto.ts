import mongoose from 'mongoose';
import { IAdmin } from '../admin.model';
import { UpdateAdminProfileInput } from '../validators/admin-profile.validator';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetail } from '../../catalog/read-models/file-detail.resolver';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface GetAdminProfileResponseDto {
    id: string;
    name: string;
    email: string | null;
    /** Profile avatar as a resolved file object (same shape as product media), or null. */
    avatar: FileDetail | null;
    jobTitle: string | null;
    department: string | null;
    twoFactorEnabled: boolean;
    timezone: string;
    /** Preferred language for notifications/messaging (ISO 639-1). */
    preferredLanguage: string;
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
    static async toResponseDto(
        admin: IAdmin,
        fileRepo: FileRepositoryMongo,
        storage: IStorageProvider,
    ): Promise<GetAdminProfileResponseDto> {
        return {
            id: admin._id.toString(),
            name: admin.name,
            email: admin.email ?? null,
            avatar: await resolveFileDetail(admin.avatar_file_id?.toString(), fileRepo, storage),
            jobTitle: admin.job_title,
            department: admin.department,
            twoFactorEnabled: admin.two_factor_enabled,
            timezone: admin.timezone,
            preferredLanguage: admin.preferred_language,
            onboardingStep: admin.onboarding_step,
            createdAt: admin.created_at,
            updatedAt: admin.updated_at,
        };
    }

    /**
     * Map admin to self-profile response DTO.
     * SECURITY: Includes last_login_ip — only safe to send to the same admin.
     */
    static async toSelfResponseDto(
        admin: IAdmin,
        fileRepo: FileRepositoryMongo,
        storage: IStorageProvider,
    ): Promise<GetAdminSelfProfileResponseDto> {
        return {
            ...(await AdminProfileMapper.toResponseDto(admin, fileRepo, storage)),
            lastLoginIp: admin.last_login_ip,
        };
    }

    static toUpdatePayload(input: UpdateAdminProfileInput): Partial<IAdmin> {
        const payload: Partial<IAdmin> = {};

        if (input.name !== undefined) payload.name = input.name;
        if (input.avatar_file_id !== undefined) {
            payload.avatar_file_id = input.avatar_file_id ? new mongoose.Types.ObjectId(input.avatar_file_id) : null;
        }
        if (input.avatar_url !== undefined) payload.avatar_url = input.avatar_url as string | null;
        if (input.job_title !== undefined) payload.job_title = input.job_title as string | null;
        if (input.department !== undefined) payload.department = input.department as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.preferred_language !== undefined) payload.preferred_language = input.preferred_language;

        return payload;
    }
}
