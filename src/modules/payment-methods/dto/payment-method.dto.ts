import { IUserPaymentMethod, PaymentMethodType } from '../models/user-payment-method.model';
import { PaymentProvider, providerForSavedWallet } from '../../payments/domain/payment-provider';
import { toE164 } from '../../../core/validation/phone';

/** What kind of instrument a saved method is. `BANK_TRANSFER` occurs on legacy rows only. */
export type PaymentMethodKind = 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER';

const KIND_OF: Readonly<Record<PaymentMethodType, PaymentMethodKind>> = Object.freeze({
    mobile_money: 'MOBILE_MONEY',
    card: 'CARD',
    bank_transfer: 'BANK_TRANSFER',
});

/**
 * A saved payment method, as every client sees it.
 *
 * SECURITY: the wallet number is NEVER returned in full — only `maskedPhone` and `last4`.
 * No gateway field is returned, on any row, old or new.
 */
export interface PaymentMethodDto {
    id: string;
    /**
     * `MTN` · `ORANGE` · `MOOV` for a wallet, `CARD` for a legacy card row, and null for a legacy
     * row that names only an aggregator (`notchpay`) or a bank transfer.
     */
    provider: PaymentProvider | null;
    kind: PaymentMethodKind;
    label: string;
    /** `+2376••••4417`. Null when the row holds no usable number (a legacy card, say). */
    maskedPhone: string | null;
    last4: string | null;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * `+2376••••4417` — the shape `maskPhone` in the bot surface uses, so one wallet reads the same
 * on the website and in a chat. Kept local rather than imported: a module the bot surface
 * depends on must not import it back.
 */
function maskWalletNumber(e164: string): string {
    if (e164.length <= 8) return '••••';
    return `${e164.slice(0, 5)}••••${e164.slice(-4)}`;
}

/**
 * The wallet number a row holds: `phone_number` on rows written since 2026-09-30, the legacy
 * `gateway_customer_id` before that — but only if it is actually a phone number, because some
 * legacy rows carry an aggregator's customer id there. SERVER-SIDE ONLY: callers mask it.
 */
export function walletNumberOf(
    method: Pick<IUserPaymentMethod, 'method_type' | 'phone_number' | 'gateway_customer_id'>,
): string | null {
    if (method.method_type !== 'mobile_money') return null;
    return toE164(method.phone_number) ?? toE164(method.gateway_customer_id);
}

export class PaymentMethodMapper {
    /**
     * Legacy rows are MAPPED, not dropped: `mtn_momo` reads as `MTN`, a card row as `CARD`, and a
     * row that names only an aggregator reads with a null provider. See `providerForSavedWallet`.
     */
    static toDto(method: IUserPaymentMethod): PaymentMethodDto {
        const kind = KIND_OF[method.method_type] ?? 'MOBILE_MONEY';
        const provider: PaymentProvider | null =
            kind === 'MOBILE_MONEY' ? providerForSavedWallet(method.provider)
                : kind === 'CARD' ? 'CARD'
                    : null;
        const number = walletNumberOf(method);

        return {
            id: method._id.toString(),
            provider,
            kind,
            label: method.display_label,
            maskedPhone: number ? maskWalletNumber(number) : null,
            last4: method.last4 ?? (number ? number.slice(-4) : null),
            isDefault: method.is_default,
            createdAt: method.created_at,
            updatedAt: method.updated_at,
        };
    }

    static toDtoList(methods: IUserPaymentMethod[]): PaymentMethodDto[] {
        return methods.map((m) => PaymentMethodMapper.toDto(m));
    }
}
