import { DeliveryAgentRepository } from '../delivery-agent.repository';
import { AgentProfileMapper, GetAgentProfileResponseDto, AgentCompletionStatusDto } from '../dto/agent-profile.dto';
import { NotFoundError } from '../../../core/errors';
import { IDeliveryAgent } from '../delivery-agent.model';
import { AgentOnboardingStep, AgentOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import {
    UpdateAgentProfileInput,
    AgentOnboardingStep1Input,
    AgentOnboardingStep2Input,
} from '../validators/agent-onboarding.validator';

export class AgentProfileService {
    private agentRepo: DeliveryAgentRepository;

    constructor() {
        this.agentRepo = new DeliveryAgentRepository();
    }

    async getProfile(agentId: string): Promise<GetAgentProfileResponseDto> {
        const agent = await this.agentRepo.findById(agentId);
        if (!agent) throw new NotFoundError('Agent profile not found');
        return AgentProfileMapper.toResponseDto(agent);
    }

    async getCompletionStatus(agentId: string): Promise<AgentCompletionStatusDto> {
        const agent = await this.agentRepo.findById(agentId);
        if (!agent) throw new NotFoundError('Agent profile not found');
        return this.buildCompletionStatus(agent);
    }

    async updateProfile(
        agentId: string,
        input: UpdateAgentProfileInput
    ): Promise<GetAgentProfileResponseDto> {
        const agent = await this.agentRepo.findById(agentId);
        if (!agent) throw new NotFoundError('Agent profile not found');

        const payload = AgentProfileMapper.toUpdatePayload(input);
        const updated = await this.agentRepo.updateProfile(agentId, payload);
        if (!updated) throw new NotFoundError('Agent not found after update');

        const newStep = this.recalculateOnboardingStep(updated);
        if (newStep !== updated.onboarding_step) {
            await this.agentRepo.updateOnboardingStep(agentId, newStep);
            updated.onboarding_step = newStep;
        }

        return AgentProfileMapper.toResponseDto(updated);
    }

    async completeStep1(
        agentId: string,
        input: AgentOnboardingStep1Input
    ): Promise<{ profile: GetAgentProfileResponseDto; completionStatus: AgentCompletionStatusDto }> {
        const agent = await this.agentRepo.findById(agentId);
        if (!agent) throw new NotFoundError('Agent profile not found');

        const updated = await this.agentRepo.updateProfile(agentId, {
            vehicle_info: input.vehicle_info as IDeliveryAgent['vehicle_info'],
        });
        if (!updated) throw new NotFoundError('Agent not found after update');

        const newStep = this.recalculateOnboardingStep(updated);
        await this.agentRepo.updateOnboardingStep(agentId, newStep);
        updated.onboarding_step = newStep;

        return {
            profile: AgentProfileMapper.toResponseDto(updated),
            completionStatus: this.buildCompletionStatus(updated),
        };
    }

    async completeStep2(
        agentId: string,
        input: AgentOnboardingStep2Input
    ): Promise<{ profile: GetAgentProfileResponseDto; completionStatus: AgentCompletionStatusDto }> {
        const agent = await this.agentRepo.findById(agentId);
        if (!agent) throw new NotFoundError('Agent profile not found');

        if (!input.skip) {
            const updates: Partial<IDeliveryAgent> = {};
            if (input.avatar_url !== undefined) updates.avatar_url = input.avatar_url as string | null;
            if (input.timezone !== undefined) updates.timezone = input.timezone;
            if (Object.keys(updates).length > 0) {
                await this.agentRepo.updateProfile(agentId, updates);
            }
        }

        await this.agentRepo.updateOnboardingStep(agentId, AgentOnboardingStep.COMPLETED);
        const finalAgent = await this.agentRepo.findById(agentId);
        if (!finalAgent) throw new NotFoundError('Agent not found');

        return {
            profile: AgentProfileMapper.toResponseDto(finalAgent),
            completionStatus: this.buildCompletionStatus(finalAgent),
        };
    }

    private recalculateOnboardingStep(agent: IDeliveryAgent): AgentOnboardingStepValue {
        const step1Complete = !!agent.vehicle_info;
        if (!step1Complete) return AgentOnboardingStep.VEHICLE_SETUP;

        if (agent.onboarding_step === AgentOnboardingStep.IDENTITY_SETUP) {
            return AgentOnboardingStep.IDENTITY_SETUP;
        }

        return AgentOnboardingStep.COMPLETED;
    }

    private buildCompletionStatus(agent: IDeliveryAgent): AgentCompletionStatusDto {
        const missing: string[] = [];
        if (!agent.vehicle_info) missing.push('vehicle_info (vehicle_type, color required)');

        const step = agent.onboarding_step;
        const stepLabels: Record<number, string> = {
            0: 'Onboarding Complete',
            1: 'Vehicle Setup',
            2: 'Identity Setup (Optional)',
        };

        return {
            onboardingStep: step,
            isComplete: step === AgentOnboardingStep.COMPLETED,
            missingFields: missing,
            stepLabel: stepLabels[step] ?? `Step ${step}`,
        };
    }
}
