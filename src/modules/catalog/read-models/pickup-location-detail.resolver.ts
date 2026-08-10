import {
  AddressDetail,
  fromHqAddress,
  fromVendorBusinessAddress,
} from '../../../core/read-models/address-detail.resolver';
import { VendorRepository } from '../../vendors/vendor.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { resolveHqAddress } from '../../magazin/domain/hq-address.resolver';
import { Product } from '../repositories/mappers/product.mapper';

/**
 * A product's pickup location with its address resolved, so the product editor
 * can label the current choice without a second round trip — the same reason
 * `FileDetail` exists for media.
 *
 * Both sources are populated, not just the new one. The stored value is a bare
 * id either way, and an endpoint that resolves the depot but leaves the vendor
 * address as a raw ObjectId is exactly the ad-hoc, per-call-site address shaping
 * `AddressDetail` was introduced to end.
 */
export interface PickupLocationDetail {
  source: 'vendor_address' | 'agency_storage';
  vendorAddressId: string | null;
  agencyAddressId: string | null;
  /** The resolved address. Null when the referenced address no longer exists. */
  address: AddressDetail | null;
  /**
   * True when `address` is the agency's primary depot standing in for a choice
   * that was never made (`agencyAddressId` null) or can no longer be honoured
   * (it names a depot the agency has deleted). Always false for
   * `vendor_address`, which has no fallback — a deleted vendor address resolves
   * to `address: null` and is reported by the activation gate.
   */
  isPrimaryFallback: boolean;
}

/**
 * Resolves `product.delivery.pickupLocation` into something displayable.
 *
 * Deliberately its own class rather than logic inside `enrichProduct`: it needs
 * two repositories that media enrichment does not, and only physical products
 * with a configured pickup location cost a query at all.
 */
export class PickupLocationDetailResolver {
  constructor(
    private readonly vendorRepository: VendorRepository = new VendorRepository(),
    private readonly magazinRepository: MagazinRepository = new MagazinRepository(),
  ) { }

  /**
   * Null when the product has no pickup location to describe (a digital or
   * service product, or a physical one not configured yet) — no queries run.
   *
   * Never throws: this decorates a read, and failing a product fetch because a
   * depot could not be looked up would be a worse answer than an unresolved
   * address. A missing address surfaces as `address: null`.
   */
  async resolve(product: Product): Promise<PickupLocationDetail | null> {
    const pickup = product.delivery?.pickupLocation;
    if (!pickup) return null;

    if (pickup.source === 'vendor_address') {
      const vendor = pickup.vendorAddressId
        ? await this.vendorRepository.findById(product.vendorId)
        : null;
      const address = vendor?.business_addresses?.find(
        (a) => a._id?.toString() === pickup.vendorAddressId,
      );
      return {
        source: 'vendor_address',
        vendorAddressId: pickup.vendorAddressId,
        agencyAddressId: null,
        address: fromVendorBusinessAddress(address),
        isPrimaryFallback: false,
      };
    }

    // agency_storage — the depot belongs to whichever agency actually handles
    // delivery: the product's own override if set, else the vendor's default.
    // Same resolution order as the activation gate and order creation.
    const effectiveAgencyId =
      product.delivery?.agencyId
      ?? (await this.vendorRepository.findById(product.vendorId))?.default_delivery_agency_id?.toString()
      ?? null;

    const magazin = effectiveAgencyId
      ? await this.magazinRepository.findByAgencyIdOrNull(effectiveAgencyId)
      : null;
    const depots = magazin?.headquarters_addresses ?? null;
    const depot = resolveHqAddress(depots, pickup.agencyAddressId);

    return {
      source: 'agency_storage',
      vendorAddressId: null,
      agencyAddressId: pickup.agencyAddressId,
      address: fromHqAddress(depot),
      // Either no depot was named, or the one named is gone and `resolveHqAddress`
      // fell back. Both are cases the editor should surface rather than silently
      // render as a deliberate choice.
      isPrimaryFallback:
        !!depot && (!pickup.agencyAddressId || depot._id?.toString() !== pickup.agencyAddressId),
    };
  }
}

export const pickupLocationDetailResolver = new PickupLocationDetailResolver();
