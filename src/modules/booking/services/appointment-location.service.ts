import { Types } from 'mongoose';
import { VendorModel } from '../../vendors/vendor.model';
import { CustomerModel } from '../../customers/customer.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IGeoAddress } from '../../../core/types/geo-address.types';
import {
    AppointmentAccessSetting,
    BookingLocationSnapshot,
    ServiceLocationSetting,
    defaultAccessSetting,
} from '../domain/appointment';

/** The address fields shared by `vendor.business_addresses[]` and `customer.saved_addresses[]`. */
interface AddressLike {
    _id: Types.ObjectId | string;
    label?: string | null;
    address_line1?: string | null;
    address_line2?: string | null;
    city?: string | null;
    state?: string | null;
    country?: string | null;
    geo?: IGeoAddress | null;
}

/**
 * The I/O half of the appointment place: resolving an address id to the address itself, and
 * freezing it onto a booking. The rules live in `../domain/appointment.ts`.
 */
export class AppointmentLocationService {
    /**
     * Whether `addressId` is one of the vendor's business addresses. Used by the service config
     * writes (refuse at once) and by the activation gate (a later deletion demotes the service).
     */
    async vendorHasAddress(vendorId: string, addressId: string): Promise<boolean> {
        if (!Types.ObjectId.isValid(addressId)) return false;
        const found = await VendorModel.exists({
            _id: vendorId,
            'business_addresses._id': new Types.ObjectId(addressId),
        });
        return !!found;
    }

    /** Refuse a service config naming an address the vendor does not hold. */
    async assertVendorAddress(vendorId: string, location: ServiceLocationSetting | undefined): Promise<void> {
        if (!location || location.kind !== 'vendor_address') return;
        if (!location.vendorAddressId || !(await this.vendorHasAddress(vendorId, location.vendorAddressId))) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_LOCATION_ADDRESS_MISSING, 422, undefined, {
                vendorAddressId: location.vendorAddressId,
            });
        }
    }

    /**
     * The place a NEW booking is frozen at.
     *
     * - no setting (a service from before 2026-10-26) → `null`, and nothing is asked;
     * - `online` → a snapshot with no address;
     * - `vendor_address` → the vendor's address as it reads now. Gone since activation →
     *   `BOOKING_LOCATION_UNAVAILABLE`, because booking a customer at an address the vendor has
     *   deleted is worse than refusing the booking;
     * - `customer_address` → `addressId` is required and must be one of the customer's own.
     *
     * ⚠ `addressId` given for a service that is NOT at the customer's address is ignored rather
     * than refused: a client that always sends the customer's default must not break every other
     * service.
     */
    async snapshotForBooking(input: {
        location: ServiceLocationSetting | undefined;
        vendorId: string;
        userId: string;
        addressId?: string | null;
    }): Promise<BookingLocationSnapshot | null> {
        const { location } = input;
        if (!location) return null;

        if (location.kind === 'online') {
            return {
                kind: 'online', label: null, addressLine1: null, addressLine2: null, city: null,
                state: null, country: null, formattedAddress: null, coordinates: null, sourceAddressId: null,
            };
        }

        if (location.kind === 'vendor_address') {
            const vendor = await VendorModel.findById(input.vendorId).select('business_addresses').lean();
            const address = (vendor?.business_addresses as AddressLike[] | undefined)
                ?.find((a) => String(a._id) === location.vendorAddressId);
            if (!address) {
                throw createAppError(ERROR_CODES.BOOKING_LOCATION_UNAVAILABLE, 422, undefined, {
                    vendorAddressId: location.vendorAddressId,
                });
            }
            return toSnapshot('vendor_address', address);
        }

        // customer_address
        if (!input.addressId) {
            throw createAppError(ERROR_CODES.BOOKING_ADDRESS_REQUIRED, 422);
        }
        const address = Types.ObjectId.isValid(input.addressId)
            ? await this.findCustomerAddress(input.userId, input.addressId)
            : null;
        if (!address) {
            // 404, not 403: whether an address id belongs to somebody else is not this caller's business.
            throw createAppError(ERROR_CODES.BOOKING_ADDRESS_NOT_FOUND, 404, undefined, { addressId: input.addressId });
        }
        return toSnapshot('customer_address', address);
    }

    /** A customer's saved addresses, for a booking door to offer. Default first. */
    async customerAddresses(userId: string): Promise<AddressLike[]> {
        const customer = await CustomerModel.findOne({ user_id: new Types.ObjectId(userId) })
            .select('saved_addresses')
            .lean();
        const list = ((customer?.saved_addresses ?? []) as unknown as Array<AddressLike & { is_default?: boolean }>);
        return [...list].sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default));
    }

    private async findCustomerAddress(userId: string, addressId: string): Promise<AddressLike | null> {
        const list = await this.customerAddresses(userId);
        return list.find((a) => String(a._id) === addressId) ?? null;
    }
}

/** The service's access defaults, copied onto a new booking. */
export function accessSnapshotFor(access: AppointmentAccessSetting | undefined): AppointmentAccessSetting | null {
    if (!access) return null;
    const base = defaultAccessSetting();
    return {
        instructions: access.instructions ?? base.instructions,
        meetingUrl: access.meetingUrl ?? base.meetingUrl,
        revealMinutesBefore: access.revealMinutesBefore ?? base.revealMinutesBefore,
    };
}

function toSnapshot(kind: 'vendor_address' | 'customer_address', a: AddressLike): BookingLocationSnapshot {
    const coords = a.geo?.coordinates?.coordinates;
    return {
        kind,
        label: a.label ?? null,
        addressLine1: a.address_line1 ?? null,
        addressLine2: a.address_line2 ?? null,
        city: a.city ?? a.geo?.components?.city ?? null,
        state: a.state ?? a.geo?.components?.region ?? null,
        country: a.country ?? a.geo?.components?.country ?? null,
        formattedAddress: a.geo?.formatted_address ?? null,
        coordinates: Array.isArray(coords) && coords.length === 2 ? [coords[0], coords[1]] : null,
        sourceAddressId: String(a._id),
    };
}

export const appointmentLocationService = new AppointmentLocationService();
