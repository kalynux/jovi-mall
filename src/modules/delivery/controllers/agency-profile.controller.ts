import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AgencyProfileService } from '../services/agency-profile.service';
import {
    UpdateAgencyProfileSchema,
    AgencyOnboardingStep1Schema,
    AgencyOnboardingStep2Schema,
    AgencyOnboardingStep3Schema,
} from '../validators/agency-onboarding.validator';
import { AppError } from '../../../core/errors';

const agencyProfileService = new AgencyProfileService();

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
    console.error('[AgencyProfileController] Unexpected error:', error);
    res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
}

export class AgencyProfileController {
    static async getProfile(req: Request, res: Response): Promise<void> {
        try {
            const agencyId = req.auth!.role_entity._id.toString();
            const profile = await agencyProfileService.getProfile(agencyId);
            res.json({ success: true, data: profile });
        } catch (error) { handleError(error, res); }
    }

    static async updateProfile(req: Request, res: Response): Promise<void> {
        try {
            const agencyId = req.auth!.role_entity._id.toString();
            const input = UpdateAgencyProfileSchema.parse(req.body);
            const profile = await agencyProfileService.updateProfile(agencyId, input);
            res.json({ success: true, data: profile, message: 'Profile updated successfully' });
        } catch (error) { handleError(error, res); }
    }

    static async getCompletionStatus(req: Request, res: Response): Promise<void> {
        try {
            const agencyId = req.auth!.role_entity._id.toString();
            const status = await agencyProfileService.getCompletionStatus(agencyId);
            res.json({ success: true, data: status });
        } catch (error) { handleError(error, res); }
    }

    static async completeOnboardingStep(req: Request, res: Response): Promise<void> {
        try {
            const agencyId = req.auth!.role_entity._id.toString();
            const step = Number(req.body.step);

            let result: Awaited<ReturnType<typeof agencyProfileService.completeStep1>>;

            switch (step) {
                case 1:
                    result = await agencyProfileService.completeStep1(agencyId, AgencyOnboardingStep1Schema.parse(req.body));
                    break;
                case 2:
                    result = await agencyProfileService.completeStep2(agencyId, AgencyOnboardingStep2Schema.parse(req.body));
                    break;
                case 3:
                    result = await agencyProfileService.completeStep3(agencyId, AgencyOnboardingStep3Schema.parse(req.body));
                    break;
                default:
                    res.status(400).json({
                        success: false,
                        error: { code: 'INVALID_STEP', message: `Unknown onboarding step: ${step}` },
                    });
                    return;
            }

            res.json({ success: true, data: result });
        } catch (error) { handleError(error, res); }
    }
}
