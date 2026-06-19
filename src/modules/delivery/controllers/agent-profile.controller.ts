import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { AgentProfileService } from '../services/agent-profile.service';
import {
    UpdateAgentProfileSchema,
    AgentOnboardingStep1Schema,
    AgentOnboardingStep2Schema,
} from '../validators/agent-onboarding.validator';

const agentProfileService = new AgentProfileService();

/**
 * AgentProfileController
 *
 * Service errors (createAppError) and Zod validation errors propagate to the
 * global error handler via asyncHandler — never written inline.
 */
export class AgentProfileController {
    static getProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const profile = await agentProfileService.getProfile(agentId);
        res.json({ success: true, data: profile });
    });

    static updateProfile = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const input = UpdateAgentProfileSchema.parse(req.body);
        const profile = await agentProfileService.updateProfile(agentId, input);
        res.json({ success: true, data: profile, message: 'Profile updated successfully' });
    });

    static getCompletionStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const status = await agentProfileService.getCompletionStatus(agentId);
        res.json({ success: true, data: status });
    });

    static completeOnboardingStep = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
                throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID, 400, `Unknown onboarding step: ${step}`);
        }

        res.json({ success: true, data: result });
    });
}
