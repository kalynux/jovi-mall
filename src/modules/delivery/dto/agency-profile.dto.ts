import { IDeliveryAgency, IAgencyHeadquartersAddress, IAgencyKycDetails } from '../delivery-agency.model';
import { IPolygon } from '../../../core/types/geo.types';
import { IPayoutDetails } from '../../../core/types/payout.types';
import { UpdateAgencyProfileInput } from '../validators/agency-onboarding.validator';

// ─── Response DTOs ────────────────────────────────────────────────────────────

export interface AgencyPayoutDetailsSanitized {
    method: 'mobile_money' | 'bank';
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

export interface GetAgencyProfileResponseDto {
    id: string;
    agencyName: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    logoUrl: string | null;
    coverageAreas: IPolygon[];
    /**
     * First entry is always the primary headquarters.
     */
    headquartersAddresses: IAgencyHeadquartersAddress[];
    payoutDetails: AgencyPayoutDetailsSanitized | null;
    kycVerified: boolean;
    wa: { verified: boolean; name?: string } | null;
    timezone: string;
    status: string;
    onboardingStep: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgencyCompletionStatusDto {
    onboardingStep: number;
    isComplete: boolean;
    missingFields: string[];
    stepLabel: string;
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

function sanitizePayout(payout: IPayoutDetails | null): AgencyPayoutDetailsSanitized | null {
    if (!payout) return null;
    return {
        method: payout.method,
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
            payoutDetails: sanitizePayout(agency.payout_details),
            kycVerified: agency.kyc_details?.legit_verified ?? false,
            wa: agency.wa ? { verified: agency.wa.verified, name: agency.wa.name } : null,
            timezone: agency.timezone,
            status: agency.status,
            onboardingStep: agency.onboarding_step,
            createdAt: agency.created_at,
            updatedAt: agency.updated_at,
        };
    }

    static toUpdatePayload(input: UpdateAgencyProfileInput): Partial<IDeliveryAgency> {
        const payload: Partial<IDeliveryAgency> = {};

        if (input.agency_name !== undefined) payload.agency_name = input.agency_name;
        if (input.logo_url !== undefined) payload.logo_url = input.logo_url as string | null;
        if (input.timezone !== undefined) payload.timezone = input.timezone;
        if (input.coverage_areas !== undefined) payload.coverage_areas = input.coverage_areas as IPolygon[];
        if (input.headquarters_addresses !== undefined) payload.headquarters_addresses = input.headquarters_addresses as IAgencyHeadquartersAddress[];
        if (input.payout_details !== undefined) payload.payout_details = input.payout_details as IPayoutDetails;
        if (input.kyc_details !== undefined) {
            payload.kyc_details = {
                registration_number: input.kyc_details.registration_number ?? null,
                transport_license_id: input.kyc_details.transport_license_id ?? null,
                legit_verified: false, // Admin-only
            } as IAgencyKycDetails;
        }

        return payload;
    }
}
