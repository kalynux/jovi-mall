import { CustomerRepository } from '../customer.repository';
import { CustomerProfileMapper, CustomerPaymentMethodDto, GetCustomerProfileResponseDto, CustomerCompletionStatusDto } from '../dto/customer-profile.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ICustomer } from '../customer.model';
import { UpdateCustomerProfileInput, AddCustomerAddressInput, AddCustomerPaymentMethodInput } from '../validators/customer-onboarding.validator';
import { paymentMethodService } from '../../payment-methods/services/payment-method.service';
import { toGeoAddress } from '../../../core/types/geo-address.types';

export class CustomerProfileService {
    private customerRepo: CustomerRepository;

    constructor() {
        this.customerRepo = new CustomerRepository();
    }

    /**
     * Assemble the profile response, sourcing saved payment methods from the
     * unified payment-method store (not the deprecated embedded array).
     */
    private async toProfileDto(customer: ICustomer): Promise<GetCustomerProfileResponseDto> {
        const methods = await paymentMethodService.list('customer', customer._id.toString());
        const paymentMethods: CustomerPaymentMethodDto[] = methods.map((m) => ({
            id: m.id,
            provider: m.provider,
            display_label: m.display_label,
            method_type: m.method_type,
            is_default: m.is_default,
        }));
        return CustomerProfileMapper.toResponseDto(customer, paymentMethods);
    }

    async getProfile(customerId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return this.toProfileDto(customer);
    }

    async getCompletionStatus(customerId: string): Promise<CustomerCompletionStatusDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return { onboardingStep: 0, isComplete: true, missingFields: [] };
    }

    async updateProfile(customerId: string, input: UpdateCustomerProfileInput): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const updates: Partial<ICustomer> = {};
        if (input.name !== undefined) updates.name = input.name;
        if (input.avatarUrl !== undefined) updates.avatar_url = input.avatarUrl as string | null;
        if (input.bio !== undefined) updates.bio = input.bio as string | null;
        if (input.dateOfBirth !== undefined) updates.date_of_birth = input.dateOfBirth as Date | null;
        if (input.recentProductCode !== undefined) updates.recent_product_code = input.recentProductCode as string | null;
        if (input.preferences !== undefined) {
            updates.preferences = { ...customer.preferences, ...input.preferences };
        }

        const updated = await this.customerRepo.updateProfile(customerId, updates);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return this.toProfileDto(updated);
    }

    async addAddress(customerId: string, input: AddCustomerAddressInput): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        // Normalise the selected geocoding result into a persistable GeoAddress
        // (server-assigns resolved_at, null-fills absent components).
        const { geo, ...rest } = input;
        const address = {
            ...rest,
            geo: geo ? toGeoAddress(geo) : null,
        } as ICustomer['saved_addresses'][number];

        const updated = await this.customerRepo.addAddress(customerId, address);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return this.toProfileDto(updated);
    }

    async removeAddress(customerId: string, addressId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const hasAddress = customer.saved_addresses.some((a) => a._id.toString() === addressId);
        if (!hasAddress) throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404);

        const updated = await this.customerRepo.removeAddress(customerId, addressId);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return this.toProfileDto(updated);
    }

    async setDefaultAddress(customerId: string, addressId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const hasAddress = customer.saved_addresses.some((a) => a._id.toString() === addressId);
        if (!hasAddress) throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404);

        const updated = await this.customerRepo.setDefaultAddress(customerId, addressId);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return this.toProfileDto(updated);
    }

    /**
     * Payment methods are persisted in the unified `user_payment_methods` store
     * (owner_role='customer'); these endpoints are kept for backward compatibility.
     */
    async addPaymentMethod(customerId: string, input: AddCustomerPaymentMethodInput): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        await paymentMethodService.add('customer', customerId, input);
        return this.toProfileDto(customer);
    }

    async removePaymentMethod(customerId: string, methodId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        // Surfaces PAYMENT_METHOD_NOT_FOUND (404) if absent / not owned.
        await paymentMethodService.remove('customer', customerId, methodId);
        return this.toProfileDto(customer);
    }
}
