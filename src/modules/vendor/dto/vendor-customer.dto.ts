import { IVendorCustomerFlagSub } from '../../vendors/models/vendor-settings.model';

/**
 * Vendor Customer Management DTOs + mappers.
 *
 * Maps snake_case persistence shapes → camelCase API responses.
 */

export interface FlagDto {
    id: string;
    name: string;
    color: string;
    description: string | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface VendorCustomerListItemDto {
    customerId: string;
    displayName: string;        // override if present, else real profile name
    realName: string;           // underlying Customer.name (never modified)
    hasNameOverride: boolean;
    email: string | null;
    avatar: string | null;
    orderCount: number;         // all orders with this vendor
    totalSpent: number;         // paid orders only
    lastOrderAt: Date | null;
    flags: FlagDto[];
}

export interface VendorCustomerDetailDto extends VendorCustomerListItemDto {
    phone: string | null;
    shippingAddress: {
        street: string;
        city: string;
        state: string | null;
        country: string;
    } | null;
}

/**
 * Map an embedded customer-flag subdocument (or lean object) to its API shape.
 */
export function toFlagDto(flag: IVendorCustomerFlagSub | any): FlagDto {
    return {
        id: flag._id.toString(),
        name: flag.name,
        color: flag.color,
        description: flag.description ?? null,
        createdAt: flag.created_at,
        updatedAt: flag.updated_at
    };
}
