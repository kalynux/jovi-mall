import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AdminProfileService } from '../services/admin-profile.service';
import { UpdateAdminProfileSchema } from '../validators/admin-profile.validator';
import { AppError } from '../../../core/errors';

const adminProfileService = new AdminProfileService();

function handleError(error: unknown, res: Response): void {
    if (error instanceof ZodError) {
        res.status(400).json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
            },
        });
        return;
    }
    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            success: false,
            error: { code: error.code, message: error.message },
        });
        return;
    }
    console.error('[AdminProfileController] Unexpected error:', error);
    res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
}

export class AdminProfileController {
    /**
     * GET /api/admin/profile
     * Returns self-profile including last_login_ip.
     */
    static async getProfile(req: Request, res: Response): Promise<void> {
        try {
            const adminId = req.auth!.role_entity._id.toString();
            const profile = await adminProfileService.getSelfProfile(adminId);
            res.json({ success: true, data: profile });
        } catch (error) { handleError(error, res); }
    }

    /**
     * PATCH /api/admin/profile
     */
    static async updateProfile(req: Request, res: Response): Promise<void> {
        try {
            const adminId = req.auth!.role_entity._id.toString();
            const input = UpdateAdminProfileSchema.parse(req.body);
            const profile = await adminProfileService.updateProfile(adminId, input);
            res.json({ success: true, data: profile, message: 'Profile updated successfully' });
        } catch (error) { handleError(error, res); }
    }
}
