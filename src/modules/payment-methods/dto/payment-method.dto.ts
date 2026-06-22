import { IUserPaymentMethod, PaymentMethodType } from '../models/user-payment-method.model';

/**
 * Payment method display DTO.
 *
 * SECURITY: gateway_customer_id / gateway_instrument_id are NEVER returned —
 * only display metadata the frontend needs to render and autofill checkout.
 */
export interface PaymentMethodDto {
    id: string;
    provider: string;
    method_type: PaymentMethodType;
    display_label: string;
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
    holder_name: string | null;
    is_default: boolean;
}

export class PaymentMethodMapper {
    static toDto(method: IUserPaymentMethod): PaymentMethodDto {
        return {
            id: method._id.toString(),
            provider: method.provider,
            method_type: method.method_type,
            display_label: method.display_label,
            brand: method.brand,
            last4: method.last4,
            exp_month: method.exp_month,
            exp_year: method.exp_year,
            holder_name: method.holder_name,
            is_default: method.is_default,
        };
    }

    static toDtoList(methods: IUserPaymentMethod[]): PaymentMethodDto[] {
        return methods.map((m) => PaymentMethodMapper.toDto(m));
    }
}
