import { Product } from '../../repositories/mappers/product.mapper';

/**
 * Which agency actually fulfils a product: **its own override if set, otherwise
 * the vendor's default.**
 *
 * That order is already spelled out in the activation gate, in checkout, in
 * `ProductUpdateService`, and in the `findAgencyStoredVariants` aggregation. This
 * is the pure version for the callers that hold a `Product` in hand and need the
 * same answer — introduced with the agency-storage write paths, where getting it
 * wrong means one agency answering for another's warehouse.
 *
 * Pure, so it is testable without Mongo.
 */
export function resolveEffectiveAgencyId(
    product: Pick<Product, 'delivery'>,
    vendorDefaultAgencyId: string | null | undefined,
): string | null {
    return product.delivery?.agencyId ?? vendorDefaultAgencyId ?? null;
}

/**
 * True when `agency` is the one warehousing this product — physical, pickup set to
 * `agency_storage`, and the effective agency is them.
 *
 * The product's *status* is deliberately not part of this: the two callers ask
 * different things of it. The inventory roster wants active-or-agency-suspended
 * rows; a stock-adjustment request only cares that the storage arrangement exists,
 * because a draft product's quantity is just as much the agency's business as a
 * live one's once it has agreed to shelve it.
 */
export function isWarehousedBy(
    product: Pick<Product, 'type' | 'delivery'>,
    vendorDefaultAgencyId: string | null | undefined,
    agencyId: string,
): boolean {
    if (product.type !== 'physical') return false;
    if (product.delivery?.pickupLocation?.source !== 'agency_storage') return false;
    return resolveEffectiveAgencyId(product, vendorDefaultAgencyId) === agencyId;
}
