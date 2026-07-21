import { IDeliveryAgency, IAgencyHeadquartersAddress, IAgencyKycDetails, IAgencyPolicies } from '../delivery-agency.model';
import { withGeoAddress } from '../../../core/types/geo-address.types';
// removed IPolygon
import { IPayoutMethod } from '../../../core/types/payout.types';
import { UpdateAgencyProfileInput } from '../validators/agency-onboarding.validator';
import { AgencyOnboardingStep, AgencyOnboardingStepValue } from '../../../core/constants/onboarding-steps';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface AgencyPayoutMethodSanitized {
    method: 'mobile_money' | 'bank';
    /** True for the first item in the array (index 0) — the preferred method. */
    is_preferred: boolean;
    mobile_money: {
        provider: string;
        phone_number_masked: string;
        account_name: string;
    } | null;
    bank: {
        bank_name: string;
        account_number_masked: string;
        account_name: string;
        country: string;
    } | null;
}

/** @deprecated Use AgencyPayoutMethodSanitized */
export type AgencyPayoutDetailsSanitized = AgencyPayoutMethodSanitized;

export interface GetAgencyProfileResponseDto {
    id: string;
    agencyName: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    logoUrl: string | null;
    coverageAreas: string[];
    /**
     * First entry is always the primary headquarters.
     */
    headquartersAddresses: IAgencyHeadquartersAddress[];
    payoutDetails: AgencyPayoutMethodSanitized[];
    kycVerified: boolean;
    policies: IAgencyPolicies | null;
    wa: { verified: boolean; name?: string } | null;
    timezone: string;
    preferredLanguage: string;
    status: string;
    onboardingStep: number;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgencyCompletionStatusDto {
    onboardingStep: number;
    isComplete: boolean;
    missingFields: string[];
    stepLabel: string;
}

// ─── Onboarding Status DTO ────────────────────────────────────────────────────

export interface AgencyOnboardingStatusDto {
    /** Current onboarding step number (0 = completed) */
    currentStep: number;
    /** Human-readable label for the current step */
    currentStepLabel: string;
    /** Whether onboarding is fully completed */
    isComplete: boolean;
    /** Progress percentage (0–100) */
    progressPercent: number;
    /** Fields completed so far */
    completedFields: string[];
    /** Fields still missing (required to advance) */
    missingFields: string[];
    /** Step-by-step breakdown */
    steps: Array<{
        step: number;
        label: string;
        status: 'completed' | 'current' | 'pending';
        required: boolean;
    }>;
    /** Optional warnings (e.g., KYC not verified) */
    warnings: string[];
}

// ─── Create Agency Response ───────────────────────────────────────────────────

export interface CreateAgencyResponseDto {
    id: string;
    agencyName: string;
    onboardingStep: number;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
    if (phone.length <= 4) return '••••';
    return phone.slice(0, -4).replace(/\d/g, '•') + phone.slice(-4);
}

function maskAccount(account: string): string {
    if (account.length <= 4) return '••••';
    return '•'.repeat(account.length - 4) + account.slice(-4);
}

function sanitizePayoutMethod(payout: IPayoutMethod, isPreferred: boolean): AgencyPayoutMethodSanitized {
    return {
        method: payout.method,
        is_preferred: isPreferred,
        mobile_money: payout.mobile_money
            ? {
                provider: payout.mobile_money.provider,
                phone_number_masked: maskPhone(payout.mobile_money.phone_number),
                account_name: payout.mobile_money.account_name,
            }
            : null,
        bank: payout.bank
            ? {
                bank_name: payout.bank.bank_name,
                account_number_masked: maskAccount(payout.bank.account_number),
                account_name: payout.bank.account_name,
                country: payout.bank.country,
            }
            : null,
    };
}

function sanitizePayoutList(payouts: IPayoutMethod[] | null | undefined): AgencyPayoutMethodSanitized[] {
    // Guard: legacy documents written before the schema change may still have null here
    if (!payouts) return [];
    return payouts.map((p, idx) => sanitizePayoutMethod(p, idx === 0));
}

/**
 * Calculate progress percentage based on onboarding step.
 * Step 1: 0%, Step 2: 25%, Step 3: 50%, Step 4: 75%, Completed: 100%
 */
function calculateProgressPercent(step: AgencyOnboardingStepValue): number {
    switch (step) {
        case AgencyOnboardingStep.LOGISTICS_SETUP:
            return 0;
        case AgencyOnboardingStep.PAYOUT_SETUP:
            return 25;
        case AgencyOnboardingStep.BRANDING:
            return 50;
        case AgencyOnboardingStep.POLICY_SETUP:
            return 75;
        case AgencyOnboardingStep.COMPLETED:
            return 100;
        default:
            return 0;
    }
}

const STEP_LABELS: Record<number, string> = {
    0: 'Onboarding Complete',
    1: 'Logistics Setup',
    2: 'Payout Setup',
    3: 'Branding (Optional)',
    4: 'Policy Setup',
};

export class AgencyProfileMapper {
    /**
     * SECURITY:
     * - kyc_details registration_number and transport_license_id are NEVER returned
     * - Payout account details are masked
     */
    static toResponseDto(agency: IDeliveryAgency): GetAgencyProfileResponseDto {
        return {
            id: agency._id.toString(),
            agencyName: agency.agency_name,
            email: agency.email ?? null,
            emailVerified: agency.email_verified,
            phone: agency.phone ?? null,
            phoneVerified: agency.phone_verified,
            logoUrl: agency.logo_url,
            coverageAreas: agency.coverage_areas,
            headquartersAddresses: agency.headquarters_addresses,
            payoutDetails: sanitizePayoutList(agency.payout_details),
            kycVerified: agency.kyc_details?.legit_verified ?? false,
            policies: agency.policies ?? null,
            wa: agency.wa ? { verified: agency.wa.verified, name: agency.wa.name } : null,
            timezone: agency.timezone,
            preferredLanguage: agency.preferred_language,
            status: agency.status,
            onboardingStep: agency.onboarding_step,
            version: agency.version,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }

    static toCreateResponseDto(agency: IDeliveryAgency): CreateAgencyResponseDto {
        return {
            id: agency._id.toString(),
            agencyName: agency.agency_name,
            onboardingStep: agency.onboarding_step,
            version: agency.version,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }

    static toOnboardingStatusDto(agency: IDeliveryAgency): AgencyOnboardingStatusDto {
        const currentStep = agency.onboarding_step as AgencyOnboardingStepValue;

        const completedFields: string[] = [];
        const missingFields: string[] = [];

        // Step 1 fields
        if (agency.coverage_areas.length > 0) completedFields.push('coverage_areas');
        else missingFields.push('coverage_areas');

        if (agency.headquarters_addresses.length > 0) completedFields.push('headquarters_addresses');
        else missingFields.push('headquarters_addresses (min 1)');

        // Step 2 fields
        if ((agency.payout_details?.length ?? 0) > 0) completedFields.push('payout_details');
        else missingFields.push('payout_details');

        // Step 3 fields (optional)
        if (agency.logo_url) completedFields.push('logo_url');
        if (agency.timezone && agency.timezone !== 'Africa/Douala') completedFields.push('timezone');

        // Step 4 fields
        if (agency.policies !== null) completedFields.push('policies');
        else missingFields.push('policies');

        // Warnings
        const warnings: string[] = [];
        if (!agency.kyc_details?.legit_verified) {
            warnings.push('KYC verification is pending. Your agency may have limited functionality until verified by admin.');
        }

        const getStepStatus = (step: number): 'completed' | 'current' | 'pending' => {
            if (currentStep === AgencyOnboardingStep.COMPLETED) return 'completed';
            if (step < currentStep) return 'completed';
            if (step === currentStep) return 'current';
            return 'pending';
        };

        return {
            currentStep,
            currentStepLabel: STEP_LABELS[currentStep] ?? `Step ${currentStep}`,
            isComplete: currentStep === AgencyOnboardingStep.COMPLETED,
            progressPercent: calculateProgressPercent(currentStep),
            completedFields,
            missingFields,
            steps: [
                { step: 1, label: STEP_LABELS[1], status: getStepStatus(1), required: true },
                { step: 2, label: STEP_LABELS[2], status: getStepStatus(2), required: true },
                { step: 3, label: STEP_LABELS[3], status: getStepStatus(3), required: false },
                { step: 4, label: STEP_LABELS[4], status: getStepStatus(4), required: true },
            ],
            warnings,
        };
    }

    static toUpdatePayload(input: UpdateAgencyProfileInput): Partial<IDeliveryAgency> {
        const payload: Partial<IDeliveryAgency> = {};

        if (input.agency_name !== undefined) payload.agency_name = input.agency_name;
        if (input.logo_url !== undefined) payload.logo_url = input.logo_url as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.preferred_language !== undefined) payload.preferred_language = input.preferred_language;
        if (input.coverage_areas !== undefined) payload.coverage_areas = input.coverage_areas as string[];
        if (input.headquarters_addresses !== undefined) payload.headquarters_addresses = input.headquarters_addresses.map(withGeoAddress) as unknown as IAgencyHeadquartersAddress[];
        if (input.payout_details !== undefined) payload.payout_details = input.payout_details as IPayoutMethod[];
        if (input.kyc_details !== undefined) {
            payload.kyc_details = {
                registration_number: input.kyc_details.registration_number ?? null,
                transport_license_id: input.kyc_details.transport_license_id ?? null,
                legit_verified: false, // Admin-only
            } as IAgencyKycDetails;
        }
        if (input.policies !== undefined) payload.policies = input.policies as IAgencyPolicies;

        return payload;
    }
}
