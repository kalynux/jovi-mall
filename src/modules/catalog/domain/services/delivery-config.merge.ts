import { Product } from '../../repositories/mappers/product.mapper';
import { PickupLocationSource } from '../../models/product.model';

/**
 * Camel-cased delivery patch as it arrives from a request body.
 * Every sub-field is independently optional — omitted means "leave alone",
 * and an explicit `null` on `pickupLocation` means "clear it".
 */
export interface DeliveryConfigPatch {
    agencyId?: string | null;
    freeDelivery?: boolean;
    pickupLocation?: {
        source: PickupLocationSource;
        vendorAddressId?: string | null;
        agencyAddressId?: string | null;
    } | null;
}

/** Snake-cased shape actually stored on the product (see product.model.ts). */
export interface DeliveryConfigPersistence {
    agency_id: string | null;
    free_delivery: boolean;
    pickup_location: {
        source: PickupLocationSource;
        vendor_address_id: string | null;
        agency_address_id: string | null;
    } | null;
}

/**
 * Merge a partial delivery patch onto a product's existing delivery config and
 * return the full snake_case sub-document to persist.
 *
 * This exists because `ProductRepositoryMongo.update` `$set`s the whole
 * `delivery` object — so writing a patch that only carries `freeDelivery` would
 * silently wipe `pickup_location`. Every write path must merge first.
 *
 * Pure: no repository access and no validation. Whether the chosen agency is
 * connected, and whether the pickup location is compatible with it, are checked
 * by the callers (ProductUpdateService at write time, and
 * ProductStatusValidationService at activation time).
 */
export function mergeDeliveryConfig(
    existing: Product['delivery'],
    patch: DeliveryConfigPatch,
): DeliveryConfigPersistence {
    const agency_id = patch.agencyId !== undefined
        ? patch.agencyId
        : (existing?.agencyId ?? null);

    const free_delivery = patch.freeDelivery !== undefined
        ? patch.freeDelivery
        : (existing?.freeDelivery ?? false);

    let pickup_location: DeliveryConfigPersistence['pickup_location'];
    if (patch.pickupLocation === undefined) {
        // Untouched — carry the persisted value across, re-snake-casing it. EVERY
        // sub-field must be listed here: one omitted is one silently wiped by an
        // unrelated `freeDelivery`-only patch, which is the whole reason this
        // function exists.
        pickup_location = existing?.pickupLocation
            ? {
                source: existing.pickupLocation.source,
                vendor_address_id: existing.pickupLocation.vendorAddressId,
                agency_address_id: existing.pickupLocation.agencyAddressId,
            }
            : null;
    } else if (patch.pickupLocation === null) {
        pickup_location = null;
    } else {
        const { source, vendorAddressId, agencyAddressId } = patch.pickupLocation;
        pickup_location = {
            source,
            // Exactly one id is meaningful per source; normalise the other away
            // rather than trusting the caller to omit it. A stale id left on the
            // document would resurface if the source were ever flipped back.
            vendor_address_id: source === 'agency_storage' ? null : (vendorAddressId ?? null),
            // Null is legal here and means "the agency's primary depot".
            agency_address_id: source === 'vendor_address' ? null : (agencyAddressId ?? null),
        };
    }

    return { agency_id, free_delivery, pickup_location };
}
