import mongoose from 'mongoose';
import { CustomerRepository } from '../customer.repository';
import { CustomerProfileMapper, CustomerPaymentMethodDto, GetCustomerProfileResponseDto, CustomerCompletionStatusDto } from '../dto/customer-profile.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ICustomer } from '../customer.model';
import { UpdateCustomerProfileInput, AddCustomerAddressInput, UpdateCustomerAddressInput, AddCustomerPaymentMethodInput } from '../validators/customer-onboarding.validator';
import { paymentMethodService } from '../../payment-methods/services/payment-method.service';
import { toGeoAddress } from '../../../core/types/geo-address.types';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';

export class CustomerProfileService {
    private customerRepo: CustomerRepository;
    private fileRepository: FileRepositoryMongo;
    private fileReferenceService: FileReferenceService;
    private storageProvider: IStorageProvider;

    constructor() {
        this.customerRepo = new CustomerRepository();
        this.fileRepository = new FileRepositoryMongo();
        this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
        this.storageProvider = getStorageProvider();
    }

    /**
     * Keep `file_references` in sync with the customer's avatar slot. Same
     * reconcile primitive branding uses: authorizes the newly-attached file
     * (must be owned by this customer or be a system file) and detaches the
     * previous one, under `entityType: 'customer', field: 'avatar'`.
     */
    private async reconcileAvatarFileReference(
        customerId: string,
        previous: ICustomer['avatar_file_id'] | undefined,
        next: string | null | undefined,
    ): Promise<void> {
        await this.fileReferenceService.reconcile({
            previousFileIds: previous ? [previous.toString()] : [],
            nextFileIds: next ? [next] : [],
            actor: { type: 'customer', id: customerId },
            entityType: 'customer',
            entityId: customerId,
            field: 'avatar',
        });
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
        return CustomerProfileMapper.toResponseDto(customer, paymentMethods, this.fileRepository, this.storageProvider);
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
        if (input.avatarFileId !== undefined) {
            await this.reconcileAvatarFileReference(customerId, customer.avatar_file_id, input.avatarFileId);
            updates.avatar_file_id = input.avatarFileId
                ? new mongoose.Types.ObjectId(input.avatarFileId)
                : null;
        }
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

    /**
     * Edit a saved address in place — the `_id` survives, so past orders that reference it
     * through `deliveryAddressId` keep pointing at a real address.
     *
     * `geo` is normalised exactly as `addAddress` normalises it (server-assigned
     * `resolved_at`, null-filled absent components), so an address edited through here is
     * indistinguishable from one added through there. Passing `geo: null` explicitly clears
     * it — which is a real intention (a customer replacing a picked address with a typed
     * one) and one checkout will then refuse for physical orders, honestly and loudly.
     */
    async updateAddress(
        customerId: string,
        addressId: string,
        input: UpdateCustomerAddressInput,
    ): Promise<GetCustomerProfileResponseDto> {
        const customer = await this.customerRepo.findById(customerId);
        if (!customer) throw createAppError(ERROR_CODES.CUSTOMER_NOT_FOUND, 404);

        const hasAddress = customer.saved_addresses.some((a) => a._id.toString() === addressId);
        if (!hasAddress) throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404);

        const { geo, ...rest } = input;
        const updates = {
            ...rest,
            // `undefined` (key omitted) leaves the stored value alone; `null` clears it.
            ...(geo === undefined ? {} : { geo: geo ? toGeoAddress(geo) : null }),
        } as Partial<ICustomer['saved_addresses'][number]>;

        const updated = await this.customerRepo.updateAddress(customerId, addressId, updates);
        if (!updated) throw createAppError(ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND, 404);
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
