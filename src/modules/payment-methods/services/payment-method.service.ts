import { UserPaymentMethodRepository } from '../repositories/user-payment-method.repository';
import { PaymentMethodMapper, PaymentMethodDto } from '../dto/payment-method.dto';
import { AddPaymentMethodInput } from '../validators/payment-method.validators';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { UserRole } from '../../users/user.model';

/** Maximum saved payment methods per user. */
const MAX_METHODS_PER_OWNER = 10;

/**
 * PaymentMethodService — role-agnostic business logic for saved payment methods.
 * Callers pass the owning role and role-profile id (from `req.auth`).
 */
export class PaymentMethodService {
    constructor(
        private readonly repo: UserPaymentMethodRepository = new UserPaymentMethodRepository()
    ) {}

    async list(ownerRole: UserRole, ownerId: string): Promise<PaymentMethodDto[]> {
        const methods = await this.repo.list(ownerRole, ownerId);
        return PaymentMethodMapper.toDtoList(methods);
    }

    async getDefault(ownerRole: UserRole, ownerId: string): Promise<PaymentMethodDto | null> {
        const method = await this.repo.findDefault(ownerRole, ownerId);
        return method ? PaymentMethodMapper.toDto(method) : null;
    }

    async add(
        ownerRole: UserRole,
        ownerId: string,
        input: AddPaymentMethodInput
    ): Promise<PaymentMethodDto> {
        const count = await this.repo.countByOwner(ownerRole, ownerId);
        if (count >= MAX_METHODS_PER_OWNER) {
            throw createAppError(ERROR_CODES.PAYMENT_METHOD_LIMIT_REACHED, 409);
        }

        const created = await this.repo.create(ownerRole, ownerId, {
            provider: input.provider,
            gateway_customer_id: input.gateway_customer_id,
            gateway_instrument_id: input.gateway_instrument_id,
            method_type: input.method_type,
            display_label: input.display_label,
            brand: input.brand ?? null,
            last4: input.last4 ?? null,
            exp_month: input.exp_month ?? null,
            exp_year: input.exp_year ?? null,
            holder_name: input.holder_name ?? null,
            is_default: input.is_default,
        });
        return PaymentMethodMapper.toDto(created);
    }

    async setDefault(
        ownerRole: UserRole,
        ownerId: string,
        id: string
    ): Promise<PaymentMethodDto> {
        const updated = await this.repo.setDefault(ownerRole, ownerId, id);
        if (!updated) {
            throw createAppError(ERROR_CODES.PAYMENT_METHOD_NOT_FOUND, 404);
        }
        return PaymentMethodMapper.toDto(updated);
    }

    async remove(ownerRole: UserRole, ownerId: string, id: string): Promise<void> {
        const removed = await this.repo.remove(ownerRole, ownerId, id);
        if (!removed) {
            throw createAppError(ERROR_CODES.PAYMENT_METHOD_NOT_FOUND, 404);
        }
    }
}

export const paymentMethodService = new PaymentMethodService();
