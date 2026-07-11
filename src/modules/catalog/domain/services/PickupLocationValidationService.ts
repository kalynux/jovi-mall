import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IDeliveryAgency } from '../../../delivery/delivery-agency.model';
import { IVendor } from '../../../vendors/vendor.model';

export interface PickupLocationInput {
    source: 'vendor_address' | 'agency_storage';
    vendorAddressId: string | null;
}

/**
 * Validates a product's chosen pickup location against the resolved delivery
 * agency's fulfillment policy and the vendor's own business addresses.
 *
 * `vendor_address` requires the agency to offer address pickup
 * (`policies.pricing.pickup_based.enabled`) and the referenced address to
 * still exist on the vendor's profile. `agency_storage` requires the agency
 * to warehouse vendor stock (`policies.pricing.storage_based.enabled`) — an
 * agency offering only one of the two must not be handed the other.
 */
export class PickupLocationValidationService {
    assertValid(pickupLocation: PickupLocationInput, agency: IDeliveryAgency, vendor: IVendor): void {
        if (pickupLocation.source === 'agency_storage') {
            if (!agency.policies?.pricing?.storage_based?.enabled) {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_PICKUP_LOCATION,
                    422,
                    'This delivery agency does not offer storage-based fulfillment — it cannot warehouse your stock.',
                );
            }
            return;
        }

        if (!agency.policies?.pricing?.pickup_based?.enabled) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_PICKUP_LOCATION,
                422,
                'This delivery agency does not offer address pickup — it only accepts storage-based stock.',
            );
        }

        const addressExists = !!pickupLocation.vendorAddressId
            && vendor.business_addresses?.some(a => a._id.toString() === pickupLocation.vendorAddressId);
        if (!addressExists) {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_PICKUP_LOCATION,
                422,
                'The selected pickup address was not found on your business addresses.',
            );
        }
    }
}
