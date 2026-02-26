import { DeliveryAgencyRepository } from '../delivery-agency.repository';
import { AgencyProfileMapper, GetAgencyProfileResponseDto, AgencyCompletionStatusDto } from '../dto/agency-profile.dto';
import { NotFoundError } from '../../../core/errors';
import { IDeliveryAgency } from '../delivery-agency.model';
import { IPolygon } from '../../../core/types/geo.types';
import { IPayoutDetails } from '../../../core/types/payout.types';
import { AgencyOnboardingStep, AgencyOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import {
    UpdateAgencyProfileInput,
    AgencyOnboardingStep1Input,
    AgencyOnboardingStep2Input,
    AgencyOnboardingStep3Input,
} from '../validators/agency-onboarding.validator';

export class AgencyProfileService {
    private agencyRepo: DeliveryAgencyRepository;

    constructor() {
        this.agencyRepo = new DeliveryAgencyRepository();
    }

    async getProfile(agencyId: string): Promise<GetAgencyProfileResponseDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw new NotFoundError('Agency profile not found');
        return AgencyProfileMapper.toResponseDto(agency);
    }

    async getCompletionStatus(agencyId: string): Promise<AgencyCompletionStatusDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw new NotFoundError('Agency profile not found');
        return this.buildCompletionStatus(agency);
    }

    async updateProfile(
        agencyId: string,
        input: UpdateAgencyProfileInput
    ): Promise<GetAgencyProfileResponseDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw new NotFoundError('Agency profile not found');

        const payload = AgencyProfileMapper.toUpdatePayload(input);
        const updated = await this.agencyRepo.updateProfile(agencyId, payload);
        if (!updated) throw new NotFoundError('Agency not found after update');

        const newStep = this.recalculateOnboardingStep(updated);
        if (newStep !== updated.onboarding_step) {
            await this.agencyRepo.updateOnboardingStep(agencyId, newStep);
            updated.onboarding_step = newStep;
        }

        return AgencyProfileMapper.toResponseDto(updated);
    }

    async completeStep1(
        agencyId: string,
        input: AgencyOnboardingStep1Input
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw new NotFoundError('Agency profile not found');

        const updated = await this.agencyRepo.updateProfile(agencyId, {
            coverage_areas: input.coverage_areas as IPolygon[],
            headquarters_addresses: input.headquarters_addresses as IDeliveryAgency['headquarters_addresses'],
        });
        if (!updated) throw new NotFoundError('Agency not found after update');

        const newStep = this.recalculateOnboardingStep(updated);
        await this.agencyRepo.updateOnboardingStep(agencyId, newStep);
        updated.onboarding_step = newStep;

        return {
            profile: AgencyProfileMapper.toResponseDto(updated),
            completionStatus: this.buildCompletionStatus(updated),
        };
    }

    async completeStep2(
        agencyId: string,
        input: AgencyOnboardingStep2Input
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw new NotFoundError('Agency profile not found');

        const updated = await this.agencyRepo.updateProfile(agencyId, {
            payout_details: input.payout_details as IPayoutDetails,
        });
        if (!updated) throw new NotFoundError('Agency not found after update');

        const newStep = this.recalculateOnboardingStep(updated);
        await this.agencyRepo.updateOnboardingStep(agencyId, newStep);
        updated.onboarding_step = newStep;

        return {
            profile: AgencyProfileMapper.toResponseDto(updated),
            completionStatus: this.buildCompletionStatus(updated),
        };
    }

    async completeStep3(
        agencyId: string,
        input: AgencyOnboardingStep3Input
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw new NotFoundError('Agency profile not found');

        if (!input.skip) {
            const updates: Partial<IDeliveryAgency> = {};
            if (input.logo_url !== undefined) updates.logo_url = input.logo_url as string | null;
            if (input.timezone !== undefined) updates.timezone = input.timezone;
            if (Object.keys(updates).length > 0) {
                await this.agencyRepo.updateProfile(agencyId, updates);
            }
        }

        await this.agencyRepo.updateOnboardingStep(agencyId, AgencyOnboardingStep.COMPLETED);
        const finalAgency = await this.agencyRepo.findById(agencyId);
        if (!finalAgency) throw new NotFoundError('Agency not found');

        return {
            profile: AgencyProfileMapper.toResponseDto(finalAgency),
            completionStatus: this.buildCompletionStatus(finalAgency),
        };
    }

    private recalculateOnboardingStep(agency: IDeliveryAgency): AgencyOnboardingStepValue {
        const step1Complete =
            agency.coverage_areas.length > 0 &&
            agency.headquarters_addresses.length > 0;

        if (!step1Complete) return AgencyOnboardingStep.LOGISTICS_SETUP;

        const step2Complete = !!agency.payout_details;
        if (!step2Complete) return AgencyOnboardingStep.PAYOUT_SETUP;

        if (agency.onboarding_step === AgencyOnboardingStep.BRANDING) {
            return AgencyOnboardingStep.BRANDING;
        }

        return AgencyOnboardingStep.COMPLETED;
    }

    private buildCompletionStatus(agency: IDeliveryAgency): AgencyCompletionStatusDto {
        const missing: string[] = [];

        if (agency.coverage_areas.length === 0) missing.push('coverage_areas');
        if (agency.headquarters_addresses.length === 0) missing.push('headquarters_addresses (min 1)');
        if (!agency.payout_details) missing.push('payout_details');

        const step = agency.onboarding_step;
        const stepLabels: Record<number, string> = {
            0: 'Onboarding Complete',
            1: 'Logistics Setup',
            2: 'Payout Setup',
            3: 'Branding (Optional)',
        };

        return {
            onboardingStep: step,
            isComplete: step === AgencyOnboardingStep.COMPLETED,
            missingFields: missing,
            stepLabel: stepLabels[step] ?? `Step ${step}`,
        };
    }
}
