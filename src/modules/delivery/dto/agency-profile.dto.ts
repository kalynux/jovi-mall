import mongoose from 'mongoose';
import { IDeliveryAgency, IAgencyKycDetails, IAgencyPolicies } from '../delivery-agency.model';
import {
    CardBrand,
    formatMaskedCardNumber,
    IPayoutMethod,
    PayoutMethodKind,
} from '../../../core/types/payout.types';
import { UpdateAgencyProfileInput } from '../validators/agency-onboarding.validator';
import { AgencyOnboardingStep, AgencyOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetail } from '../../catalog/read-models/file-detail.resolver';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface AgencyPayoutMethodSanitized {
    method: PayoutMethodKind;
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
    /**
     * Nothing is redacted here — only `last4` was ever stored (no PAN, no CVV).
     * `number_masked` is rendered from it so a client can print all three method
     * kinds through one code path.
     */
    card: {
        brand: CardBrand;
        last4: string;
        number_masked: string;
        card_holder_name: string;
        expiry_month: number;
        expiry_year: number;
        issuing_bank: string | null;
        country: string;
    } | null;
}

/** @deprecated Use AgencyPayoutMethodSanitized */
export type AgencyPayoutDetailsSanitized = AgencyPayoutMethodSanitized;

export interface GetAgencyProfileResponseDto {
    id: string;
    /**
     * Personal/contact display name. The public BUSINESS name lives on the
     * Magazin (GET /api/agency/magazin), not here — mirroring the vendor Store.
     */
    displayName?: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    /**
     * Personal profile avatar as a resolved file object, or null. Distinct from
     * the business logo, which lives on the Magazin.
     */
    avatar: FileDetail | null;
    /**
     * ISO-2 operating country. Set once (onboarding Step 1) and immutable
     * afterwards; null only on legacy profiles that predate the field.
     */
    country: string | null;
    // NOTE: coverageAreas + headquartersAddresses live on the Magazin
    // (GET /api/agency/magazin), not on the profile.
    payoutDetails: AgencyPayoutMethodSanitized[];
    kycVerified: boolean;
    policies: IAgencyPolicies | null;
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
    /** Business name — resolved from the agency's Magazin (source of truth). */
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
        card: payout.card
            ? {
                brand: payout.card.brand,
                last4: payout.card.last4,
                number_masked: formatMaskedCardNumber(payout.card.last4),
                card_holder_name: payout.card.card_holder_name,
                expiry_month: payout.card.expiry_month,
                expiry_year: payout.card.expiry_year,
                issuing_bank: payout.card.issuing_bank ?? null,
                country: payout.card.country,
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
    static async toResponseDto(
        agency: IDeliveryAgency,
        fileRepo: FileRepositoryMongo,
        storage: IStorageProvider,
    ): Promise<GetAgencyProfileResponseDto> {
        return {
            id: agency._id.toString(),
            displayName: agency.display_name,
            email: agency.email ?? null,
            emailVerified: agency.email_verified,
            phone: agency.phone ?? null,
            phoneVerified: agency.phone_verified,
            avatar: await resolveFileDetail(agency.avatar_file_id?.toString(), fileRepo, storage),
            country: agency.country ?? null,
            payoutDetails: sanitizePayoutList(agency.payout_details),
            kycVerified: agency.kyc_details?.legit_verified ?? false,
            policies: agency.policies ?? null,
            timezone: agency.timezone,
            preferredLanguage: agency.preferred_language,
            status: agency.status,
            onboardingStep: agency.onboarding_step,
            version: agency.version,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }

    static toCreateResponseDto(agency: IDeliveryAgency, agencyName: string): CreateAgencyResponseDto {
        return {
            id: agency._id.toString(),
            agencyName,
            onboardingStep: agency.onboarding_step,
            version: agency.version,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }

    /**
     * @param coverageCount number of coverage areas on the agency's Magazin
     * @param hqCount number of headquarters addresses on the agency's Magazin
     * (both moved off the profile onto the Magazin).
     */
    static toOnboardingStatusDto(
        agency: IDeliveryAgency,
        coverageCount: number,
        hqCount: number,
    ): AgencyOnboardingStatusDto {
        const currentStep = agency.onboarding_step as AgencyOnboardingStepValue;

        const completedFields: string[] = [];
        const missingFields: string[] = [];

        // Step 1 fields (coverage + HQ live on the Magazin)
        if (coverageCount > 0) completedFields.push('coverage_areas');
        else missingFields.push('coverage_areas');

        if (hqCount > 0) completedFields.push('headquarters_addresses');
        else missingFields.push('headquarters_addresses (min 1)');

        // Step 2 fields
        if ((agency.payout_details?.length ?? 0) > 0) completedFields.push('payout_details');
        else missingFields.push('payout_details');

        // Step 3 fields (optional). The business logo now lives on the Magazin, not
        // the agency, so it is not reflected in this agency-only completion mapper.
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

        if (input.displayName !== undefined) payload.display_name = input.displayName;
        if (input.avatarFileId !== undefined) {
            payload.avatar_file_id = input.avatarFileId ? new mongoose.Types.ObjectId(input.avatarFileId) : null;
        }
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.preferred_language !== undefined) payload.preferred_language = input.preferred_language;
        // Set-once: the service rejects a change before this mapping runs.
        if (input.country !== undefined) payload.country = input.country;
        // coverage_areas + headquarters_addresses now live on the Magazin.
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
