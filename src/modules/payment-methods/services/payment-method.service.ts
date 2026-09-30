import { UserPaymentMethodRepository } from '../repositories/user-payment-method.repository';
import { PaymentMethodMapper, PaymentMethodDto } from '../dto/payment-method.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { UserRole } from '../../users/user.model';
import type { MobileMoneyProvider } from '../../payments/domain/payment-provider';
import { checkProviderPhone } from '../../payments/domain/payment-routing';

/** Maximum saved payment methods per user. */
const MAX_METHODS_PER_OWNER = 10;

/**
 * The name a wallet is known by when the customer gives none.
 *
 * ⚠ The storefront's own format — `"MTN Mobile Money · ••••4417"` — so a wallet saved on the
 * website and one saved in a chat read as the same wallet.
 */
const WALLET_NAMES: Readonly<Record<MobileMoneyProvider, string>> = Object.freeze({
    MTN: 'MTN Mobile Money',
    ORANGE: 'Orange Money',
    MOOV: 'Moov Money',
});

/**
 * A wallet to save, in the canonical vocabulary. Every door converts to this: the HTTP body
 * already is it; the bot door maps its `mtn_momo` / `orange_money` / `moov_money`.
 */
export interface SaveWalletInput {
    provider: MobileMoneyProvider;
    /** Already proven E.164 by the door's `PhoneNumberSchema`. */
    phoneNumber: string;
    label?: string;
    isDefault?: boolean;
}

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

    /**
     * Save a mobile-money wallet. The ONLY write path for a saved method — the HTTP doors and the
     * bot door all come through here, so they share the network check and the stored form.
     *
     * ⚠ **The number must be on the provider's network** (`checkProviderPhone`, prefix only): an
     * MTN wallet saved with an Orange number would push every future prompt to a wallet that
     * cannot answer it. An unknown prefix (Nexttel, a ported or foreign number) is not a
     * mismatch — the declared provider wins, exactly as at checkout.
     */
    async add(
        ownerRole: UserRole,
        ownerId: string,
        input: SaveWalletInput
    ): Promise<PaymentMethodDto> {
        const network = checkProviderPhone(input.provider, input.phoneNumber);
        if (!network.ok) {
            throw createAppError(
                ERROR_CODES.PAYMENT_PROVIDER_PHONE_MISMATCH,
                422,
                `This number is on ${network.detected}, not ${input.provider}. Please check the number or choose ${network.detected}.`,
                { provider: input.provider, detected: network.detected },
            );
        }

        const count = await this.repo.countByOwner(ownerRole, ownerId);
        if (count >= MAX_METHODS_PER_OWNER) {
            throw createAppError(ERROR_CODES.PAYMENT_METHOD_LIMIT_REACHED, 409);
        }

        const last4 = input.phoneNumber.slice(-4);
        const created = await this.repo.create(ownerRole, ownerId, {
            provider: input.provider,
            phone_number: input.phoneNumber,
            method_type: 'mobile_money',
            display_label: input.label ?? `${WALLET_NAMES[input.provider]} · ${last4.padStart(8, '•')}`,
            last4,
            is_default: input.isDefault ?? false,
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
