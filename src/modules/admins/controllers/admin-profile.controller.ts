import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { AdminProfileService } from '../services/admin-profile.service';
import { UpdateAdminProfileSchema } from '../validators/admin-profile.validator';

const adminProfileService = new AdminProfileService();

/**
 * AdminProfileController
 *
 * Service errors (createAppError) and Zod validation errors propagate to the
 * global error handler via asyncHandler — never written inline.
 */
export class AdminProfileController {
    /**
     * GET /api/admin/profile
     * Returns self-profile including last_login_ip.
     */
    static getProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const adminId = req.auth!.role_entity._id.toString();
        const profile = await adminProfileService.getSelfProfile(adminId);
        res.json({ success: true, data: profile });
    });

    /**
     * PATCH /api/admin/profile
     */
    static updateProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const adminId = req.auth!.role_entity._id.toString();
        const input = UpdateAdminProfileSchema.parse(req.body);
        const profile = await adminProfileService.updateProfile(adminId, input);
        res.json({ success: true, data: profile, message: 'Profile updated successfully' });
    });
}
