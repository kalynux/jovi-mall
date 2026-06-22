import { ICustomer, ICustomerSavedAddress, ICustomerPreferences } from '../customer.model';

// ─── Response DTOs ────────────────────────────────────────────────────────────

/** Payment method display DTO — gateway instrument IDs are never returned. */
export interface CustomerPaymentMethodDto {
    id: string;
    provider: string;
    display_label: string;
    method_type: 'card' | 'mobile_money' | 'bank_transfer';
    is_default: boolean;
}

export interface GetCustomerProfileResponseDto {
    id: string;
    name: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    avatarUrl: string | null;
    bio: string | null;
    savedAddresses: ICustomerSavedAddress[];
    dateOfBirth: Date | null;
    preferences: ICustomerPreferences;
    recentProductCode: string | null;
    savedPaymentMethods: CustomerPaymentMethodDto[];
    wa: {
        verified: boolean;
        name?: string;
    } | null;
    timezone: string;
    status: string;
    onboardingStep: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface CustomerCompletionStatusDto {
    onboardingStep: number;
    isComplete: true; // Always true for customers
    missingFields: never[];
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

export class CustomerProfileMapper {
    /**
     * Map Customer domain model to sanitized response DTO.
     *
     * Saved payment methods are sourced from the unified payment-method store
     * (passed in by the service), not the deprecated embedded array.
     *
     * SECURITY:
     * - gateway_customer_id and gateway_instrument_id are NEVER included
     * - Only display_label, provider, method_type, is_default exposed
     */
    static toResponseDto(
        customer: ICustomer,
        savedPaymentMethods: CustomerPaymentMethodDto[]
    ): GetCustomerProfileResponseDto {
        return {
            id: customer._id.toString(),
            name: customer.name,
            email: customer.email ?? null,
            emailVerified: customer.email_verified,
            phone: customer.phone ?? null,
            phoneVerified: customer.phone_verified,
            avatarUrl: customer.avatar_url,
            bio: customer.bio,
            savedAddresses: customer.saved_addresses,
            dateOfBirth: customer.date_of_birth,
            preferences: customer.preferences,
            recentProductCode: customer.recent_product_code,
            savedPaymentMethods,
            wa: customer.wa
                ? { verified: customer.wa.verified, name: customer.wa.name }
                : null,
            timezone: customer.timezone,
            status: customer.status,
            onboardingStep: customer.onboarding_step,
            createdAt: customer.created_at,
            updatedAt: customer.updated_at,
        };
    }
}
