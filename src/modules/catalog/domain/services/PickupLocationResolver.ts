import { ClientSession } from 'mongoose';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { IVendor } from '../../../vendors/vendor.model';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { IDeliveryAgency } from '../../../delivery/delivery-agency.model';
import { PickupLocationSource } from '../../models/product.model';

/**
 * Why a pickup location was, or was not, derived. Echoed back to the caller so
 * the UI knows which control to render — `multiple_addresses` means "show an
 * address picker", `no_agency` means "send them to delivery settings".
 */
export type PickupResolutionReason =
    | 'explicit'                    // caller supplied one; no derivation attempted
    | 'derived_single_address'
    | 'derived_agency_storage'
    | 'vendor_not_found'
    | 'no_agency'
    | 'agency_inactive'
    | 'multiple_addresses'
    | 'no_business_address'
    | 'agency_offers_neither'
    | 'resolution_failed';

export interface ResolvedPickupLocation {
    /** Snake-cased, ready to embed in `product.delivery`. Null when nothing could be derived. */
    pickupLocation: { source: PickupLocationSource; vendor_address_id: string | null } | null;
    reason: PickupResolutionReason;
}

/**
 * Works out where a delivery agency should collect a product from, without
 * asking the vendor.
 *
 * This is the piece that makes one-shot product creation possible: a pickup
 * location is required to activate a physical product, but for a single-shop
 * vendor there is only ever one sensible answer, and making them state it is
 * exactly the friction the simple editor exists to remove.
 *
 * **It never throws.** A vendor who has not finished their delivery setup still
 * gets their product created — it simply stays `draft`, and the activation gate
 * names what is missing. Failing here would defeat the point.
 */
export class PickupLocationResolver {
    constructor(
        private readonly vendorRepository: VendorRepository = new VendorRepository(),
        private readonly deliveryAgencyRepository: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    ) { }

    async resolveForVendor(
        vendorId: string,
        opts?: { productAgencyId?: string | null; session?: ClientSession },
    ): Promise<ResolvedPickupLocation> {
        try {
            const session = opts?.session;

            const vendor = await this.vendorRepository.findById(vendorId, session);
            if (!vendor) return { pickupLocation: null, reason: 'vendor_not_found' };

            // Same resolution order as activation and order creation: the
            // product's own override wins, else the vendor default.
            const effectiveAgencyId = opts?.productAgencyId ?? vendor.default_delivery_agency_id?.toString();
            if (!effectiveAgencyId) return { pickupLocation: null, reason: 'no_agency' };

            const agency = await this.deliveryAgencyRepository.findById(effectiveAgencyId, session);
            if (!agency || agency.status !== 'active') {
                return { pickupLocation: null, reason: 'agency_inactive' };
            }

            return derivePickupLocation(vendor, agency);
        } catch {
            // Deliberately swallowed: a resolution failure must never abort a
            // product create. The product lands as a draft and the activation
            // blockers tell the vendor what to fix.
            return { pickupLocation: null, reason: 'resolution_failed' };
        }
    }
}

/**
 * The decision itself — pure, so it can be unit-tested without Mongo (same shape
 * as PickupLocationValidationService.assertValid, which also takes loaded docs).
 *
 * The one case that deliberately declines to guess is **more than one business
 * address**. `IVendorBusinessAddress` carries no default/primary flag, so "the
 * first one" is arbitrary, and picking wrong dispatches a courier to the wrong
 * city — a silent, physical, expensive error. Declining costs the vendor one
 * tap; guessing costs them a failed delivery.
 */
export function derivePickupLocation(vendor: IVendor, agency: IDeliveryAgency): ResolvedPickupLocation {
    const pickupEnabled = !!agency.policies?.pricing?.pickup_based?.enabled;
    const storageEnabled = !!agency.policies?.pricing?.storage_based?.enabled;
    const addresses = vendor.business_addresses ?? [];

    if (pickupEnabled && addresses.length === 1) {
        // Preferred over agency_storage when both are on offer: storage means the
        // agency already warehouses this vendor's stock, which is a standing
        // arrangement they would have configured deliberately, not a default.
        return {
            pickupLocation: { source: 'vendor_address', vendor_address_id: addresses[0]._id.toString() },
            reason: 'derived_single_address',
        };
    }

    if (pickupEnabled && addresses.length > 1) {
        return { pickupLocation: null, reason: 'multiple_addresses' };
    }

    if (storageEnabled) {
        return {
            pickupLocation: { source: 'agency_storage', vendor_address_id: null },
            reason: 'derived_agency_storage',
        };
    }

    // Agency does pickup only, and the vendor has no address to be picked up from.
    if (pickupEnabled) return { pickupLocation: null, reason: 'no_business_address' };

    return { pickupLocation: null, reason: 'agency_offers_neither' };
}
