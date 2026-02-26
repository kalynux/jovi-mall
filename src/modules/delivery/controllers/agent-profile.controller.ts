import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AgentProfileService } from '../services/agent-profile.service';
import {
    UpdateAgentProfileSchema,
    AgentOnboardingStep1Schema,
    AgentOnboardingStep2Schema,
} from '../validators/agent-onboarding.validator';
import { AppError } from '../../../core/errors';

const agentProfileService = new AgentProfileService();

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
    console.error('[AgentProfileController] Unexpected error:', error);
    res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
}

export class AgentProfileController {
    static async getProfile(req: Request, res: Response): Promise<void> {
        try {
            const agentId = req.auth!.role_entity._id.toString();
            const profile = await agentProfileService.getProfile(agentId);
            res.json({ success: true, data: profile });
        } catch (error) { handleError(error, res); }
    }

    static async updateProfile(req: Request, res: Response): Promise<void> {
        try {
            const agentId = req.auth!.role_entity._id.toString();
            const input = UpdateAgentProfileSchema.parse(req.body);
            const profile = await agentProfileService.updateProfile(agentId, input);
            res.json({ success: true, data: profile, message: 'Profile updated successfully' });
        } catch (error) { handleError(error, res); }
    }

    static async getCompletionStatus(req: Request, res: Response): Promise<void> {
        try {
            const agentId = req.auth!.role_entity._id.toString();
            const status = await agentProfileService.getCompletionStatus(agentId);
            res.json({ success: true, data: status });
        } catch (error) { handleError(error, res); }
    }

    static async completeOnboardingStep(req: Request, res: Response): Promise<void> {
        try {
            const agentId = req.auth!.role_entity._id.toString();
            const step = Number(req.body.step);

            let result: Awaited<ReturnType<typeof agentProfileService.completeStep1>>;

            switch (step) {
                case 1:
                    result = await agentProfileService.completeStep1(agentId, AgentOnboardingStep1Schema.parse(req.body));
                    break;
                case 2:
                    result = await agentProfileService.completeStep2(agentId, AgentOnboardingStep2Schema.parse(req.body));
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
