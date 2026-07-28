import { AdminRepository } from '../admin.repository';
import { AdminProfileMapper, GetAdminProfileResponseDto, GetAdminSelfProfileResponseDto } from '../dto/admin-profile.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IAdmin } from '../admin.model';
import { UpdateAdminProfileInput } from '../validators/admin-profile.validator';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';

export class AdminProfileService {
    private adminRepo: AdminRepository;
    private fileRepository: FileRepositoryMongo;
    private fileReferenceService: FileReferenceService;
    private storageProvider: IStorageProvider;

    constructor() {
        this.adminRepo = new AdminRepository();
        this.fileRepository = new FileRepositoryMongo();
        this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
        this.storageProvider = getStorageProvider();
    }

    /**
     * Keep `file_references` in sync with the admin's avatar slot. Admins may
     * attach any file (assertAttachable exempts admins), but reconciling still
     * registers the reference so the avatar is deletion-protected and shows in
     * `GET /api/files/:id` usage, under `entityType: 'admin', field: 'avatar'`.
     */
    private async reconcileAvatarFileReference(
        adminId: string,
        previous: IAdmin['avatar_file_id'] | undefined,
        next: string | null | undefined,
    ): Promise<void> {
        await this.fileReferenceService.reconcile({
            previousFileIds: previous ? [previous.toString()] : [],
            nextFileIds: next ? [next] : [],
            actor: { type: 'admin', id: adminId },
            entityType: 'admin',
            entityId: adminId,
            field: 'avatar',
        });
    }

    /**
     * Get admin's own profile (includes last_login_ip).
     */
    async getSelfProfile(adminId: string): Promise<GetAdminSelfProfileResponseDto> {
        const admin = await this.adminRepo.findById(adminId);
        if (!admin) throw createAppError(ERROR_CODES.ADMIN_NOT_FOUND, 404, 'Admin profile not found');
        return AdminProfileMapper.toSelfResponseDto(admin, this.fileRepository, this.storageProvider);
    }

    /**
     * Get another admin's profile (excludes last_login_ip).
     */
    async getProfile(adminId: string): Promise<GetAdminProfileResponseDto> {
        const admin = await this.adminRepo.findById(adminId);
        if (!admin) throw createAppError(ERROR_CODES.ADMIN_NOT_FOUND, 404, 'Admin profile not found');
        return AdminProfileMapper.toResponseDto(admin, this.fileRepository, this.storageProvider);
    }

    async updateProfile(
        adminId: string,
        input: UpdateAdminProfileInput
    ): Promise<GetAdminSelfProfileResponseDto> {
        const admin = await this.adminRepo.findById(adminId);
        if (!admin) throw createAppError(ERROR_CODES.ADMIN_NOT_FOUND, 404, 'Admin profile not found');

        if (input.avatar_file_id !== undefined) {
            await this.reconcileAvatarFileReference(adminId, admin.avatar_file_id, input.avatar_file_id);
        }

        const payload = AdminProfileMapper.toUpdatePayload(input);
        const updated = await this.adminRepo.updateProfile(adminId, payload as Partial<IAdmin>);
        if (!updated) throw createAppError(ERROR_CODES.ADMIN_NOT_FOUND, 404, 'Admin not found after update');

        return AdminProfileMapper.toSelfResponseDto(updated, this.fileRepository, this.storageProvider);
    }
}
