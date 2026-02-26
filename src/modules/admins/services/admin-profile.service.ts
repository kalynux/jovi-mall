import { AdminRepository } from '../admin.repository';
import { AdminProfileMapper, GetAdminProfileResponseDto, GetAdminSelfProfileResponseDto } from '../dto/admin-profile.dto';
import { NotFoundError } from '../../../core/errors';
import { IAdmin } from '../admin.model';
import { UpdateAdminProfileInput } from '../validators/admin-profile.validator';

export class AdminProfileService {
    private adminRepo: AdminRepository;

    constructor() {
        this.adminRepo = new AdminRepository();
    }

    /**
     * Get admin's own profile (includes last_login_ip).
     */
    async getSelfProfile(adminId: string): Promise<GetAdminSelfProfileResponseDto> {
        const admin = await this.adminRepo.findById(adminId);
        if (!admin) throw new NotFoundError('Admin profile not found');
        return AdminProfileMapper.toSelfResponseDto(admin);
    }

    /**
     * Get another admin's profile (excludes last_login_ip).
     */
    async getProfile(adminId: string): Promise<GetAdminProfileResponseDto> {
        const admin = await this.adminRepo.findById(adminId);
        if (!admin) throw new NotFoundError('Admin profile not found');
        return AdminProfileMapper.toResponseDto(admin);
    }

    async updateProfile(
        adminId: string,
        input: UpdateAdminProfileInput
    ): Promise<GetAdminSelfProfileResponseDto> {
        const admin = await this.adminRepo.findById(adminId);
        if (!admin) throw new NotFoundError('Admin profile not found');

        const payload = AdminProfileMapper.toUpdatePayload(input);
        const updated = await this.adminRepo.updateProfile(adminId, payload as Partial<IAdmin>);
        if (!updated) throw new NotFoundError('Admin not found after update');

        return AdminProfileMapper.toSelfResponseDto(updated);
    }
}
