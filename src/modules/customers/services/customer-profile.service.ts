import { CustomerRepository } from '../customer.repository';
import { CustomerProfileMapper, GetCustomerProfileResponseDto, CustomerCompletionStatusDto } from '../dto/customer-profile.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ICustomer } from '../customer.model';
import { UpdateCustomerProfileInput, AddCustomerAddressInput, AddCustomerPaymentMethodInput } from '../validators/customer-onboarding.validator';

export class CustomerProfileService {
    private customerRepo: CustomerRepository;

    constructor() {
        this.customerRepo = new CustomerRepository();
    }

    async getProfile(customerId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return CustomerProfileMapper.toResponseDto(customer);
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
        return CustomerProfileMapper.toResponseDto(updated);
    }

    async addAddress(customerId: string, input: AddCustomerAddressInput): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const updated = await this.customerRepo.addAddress(customerId, input as ICustomer['saved_addresses'][number]);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return CustomerProfileMapper.toResponseDto(updated);
    }

    async removeAddress(customerId: string, addressId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const hasAddress = customer.saved_addresses.some((a) => a._id.toString() === addressId);
        if (!hasAddress) throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404);

        const updated = await this.customerRepo.removeAddress(customerId, addressId);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return CustomerProfileMapper.toResponseDto(updated);
    }

    async setDefaultAddress(customerId: string, addressId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const hasAddress = customer.saved_addresses.some((a) => a._id.toString() === addressId);
        if (!hasAddress) throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404);

        const updated = await this.customerRepo.setDefaultAddress(customerId, addressId);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return CustomerProfileMapper.toResponseDto(updated);
    }

    async addPaymentMethod(customerId: string, input: AddCustomerPaymentMethodInput): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const updated = await this.customerRepo.addPaymentMethod(customerId, input as ICustomer['saved_payment_methods'][number]);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return CustomerProfileMapper.toResponseDto(updated);
    }

    async removePaymentMethod(customerId: string, methodId: string): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const hasMethod = customer.saved_payment_methods.some((m) => m._id.toString() === methodId);
        if (!hasMethod) throw createAppError(ERROR_CODES.CUSTOMER_PAYMENT_METHOD_NOT_FOUND, 404);

        const updated = await this.customerRepo.removePaymentMethod(customerId, methodId);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);
        return CustomerProfileMapper.toResponseDto(updated);
    }
}
