import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IDeliveryAgency } from '../../../delivery/delivery-agency.model';
import { IVendor } from '../../../vendors/vendor.model';

export interface PickupLocationInput {
    source: 'vendor_address' | 'agency_storage';
    vendorAddressId: string | null;
    agencyAddressId?: string | null;
}

/**
 * The effective agency's depot ids (`magazin.headquarters_addresses[]._id`), in
 * stored order. `null` means the magazin could not be resolved — distinct from
 * `[]`, which means it has none on file; both are treated the same here.
 */
export type AgencyDepotIds = string[] | null;

/**
 * Validates a product's chosen pickup location against the resolved delivery
 * agency's fulfillment policy and the vendor's own business addresses.
 *
 * `vendor_address` requires the agency to offer address pickup
 * (`policies.pricing.pickup_based.enabled`) and the referenced address to
 * still exist on the vendor's profile. `agency_storage` requires the agency
 * to warehouse vendor stock (`policies.pricing.storage_based.enabled`) — an
 * agency offering only one of the two must not be handed the other.
 *
 * Depot ids arrive as a plain `string[]` rather than the magazin document on
 * purpose: this service reads loaded documents and touches no repository, and
 * `IAgencyMagazin` is a third document neither caller already has in hand. The
 * parameter is REQUIRED so that a new call site has to decide what to pass
 * rather than silently skipping the depot check.
 */
export class PickupLocationValidationService {
    assertValid(
        pickupLocation: PickupLocationInput,
        agency: IDeliveryAgency,
        vendor: IVendor,
        agencyDepotIds: AgencyDepotIds,
    ): void {
        if (pickupLocation.source === 'agency_storage') {
            if (!agency.policies?.pricing?.storage_based?.enabled) {
                throw createAppError(
                    ERROR_CODES.CATALOG_PRODUCT_INVALID_PICKUP_LOCATION,
                    422,
                    'This delivery agency does not offer storage-based fulfillment — it cannot warehouse your stock.',
                );
            }

            // A named depot must exist on THIS agency. Two deliberate non-errors:
            // a null id (means "the primary", the default for every product that
            // predates the picker), and an agency with no depots on file at all —
            // an agency-side gap that must not block the vendor's product.
            if (pickupLocation.agencyAddressId && agencyDepotIds && agencyDepotIds.length > 0) {
                if (!agencyDepotIds.includes(pickupLocation.agencyAddressId)) {
                    throw createAppError(
                        ERROR_CODES.CATALOG_PRODUCT_INVALID_PICKUP_LOCATION,
                        422,
                        'The selected pickup location was not found among this delivery agency\'s locations.',
                    );
                }
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
