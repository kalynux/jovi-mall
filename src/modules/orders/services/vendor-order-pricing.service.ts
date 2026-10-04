/**
 * The ONE pricing path for a vendor's part of a basket — shared by the cart quote and checkout
 * (ADR-A11, customer-paid delivery, 2026-10-03).
 *
 * Two halves, and both callers use both:
 *
 *   `resolveDeliveryLines`  per line: the carrying agency (product override → the vendor's
 *                           default), the pickup snapshot checkout persists, the pickup's region
 *                           (the vendor address's geocoded region, or the depot's for agency
 *                           storage), and the per-unit weight (D-4).
 *   `price`                 loads the agencies' pricing, the shop's delivery terms and the
 *                           vendor's commission, then defers to the pure `priceVendorOrder`.
 *
 * Checkout calls it `strict` (an unresolvable product/vendor/agency throws the checkout's own
 * codes, an unresolvable commission throws); the quote calls it `lenient` (an unresolvable line
 * carries no shipment, an unresolvable commission leaves the payer to the shop's terms and the
 * delivery minimum unevaluated) — a misconfiguration the shopper cannot act on must not fail
 * the cart page. The ARITHMETIC is identical in both modes.
 */
import mongoose from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { VendorRepository } from '../../vendors/vendor.repository';
import { IVendor } from '../../vendors/vendor.model';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { resolveHqAddress } from '../../magazin/domain/hq-address.resolver';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { IAgencyPolicies } from '../../delivery/delivery-agency.model';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';
import { vendorDeliveryTermsOf } from '../../vendors/domain/delivery-terms';
import { EntitlementService, entitlementService } from '../../billing/services/entitlement.service';
import { EARNINGS_CONFIG } from '../../earnings/config/earnings.config';
import { ResolvedItemWeight } from '../../earnings/domain/delivery-pricing';
import { itemWeightsForVariants } from '../../catalog/read-models/item-weight.lookup';
import { PricingLine, priceVendorOrder, VendorOrderPricing } from '../domain/vendor-order-pricing';

/** The order-item `delivery.pickup_location` snapshot, exactly as checkout persists it. */
export interface PickupLocationSnapshot {
  source: 'vendor_address' | 'agency_storage';
  vendor_address_id: mongoose.Types.ObjectId | null;
  agency_address_id: mongoose.Types.ObjectId | null;
  address_snapshot: {
    label: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string | null;
    geo: any;
  } | null;
}

export interface DeliveryLineFacts {
  agencyId: string | null;
  /** `null` for a pre-feature product with no usable pickup (contributes no fee component). */
  pickupLocation: PickupLocationSnapshot | null;
  pickupRegion: string | null;
  weight: ResolvedItemWeight;
}

export interface DeliveryLineInput {
  productId: string;
  variantId: string;
  vendorId: string;
  title?: string;
}

/** The region a GeoAddress-like value names, or null. */
export function regionOfGeo(geo: { components?: { region?: string | null } | null } | null | undefined): string | null {
  const region = geo?.components?.region;
  return typeof region === 'string' && region.trim() ? region : null;
}

export class VendorOrderPricingService {
  constructor(
    private readonly productRepo = new ProductRepositoryMongo(),
    private readonly vendorRepo = new VendorRepository(),
    private readonly magazinRepo = new MagazinRepository(),
    private readonly agencyRepo = new DeliveryAgencyRepository(),
    private readonly settingsRepo = new VendorSettingsRepository(),
    private readonly entitlements: EntitlementService = entitlementService,
  ) { }

  /**
   * Resolve every line's delivery facts. Returns one entry per input line, in order; a `null`
   * entry (lenient mode only) is a line that rides no shipment — not a physical product, or no
   * resolvable product / vendor / agency.
   */
  async resolveDeliveryLines(
    items: DeliveryLineInput[],
    mode: 'strict' | 'lenient',
  ): Promise<Array<DeliveryLineFacts | null>> {
    const vendorCache = new Map<string, IVendor | null>();
    const weights = await itemWeightsForVariants(items);

    const partial: Array<{ agencyId: string; pickupLocation: PickupLocationSnapshot | null; weight: ResolvedItemWeight; vendorRegion: string | null } | null> = [];
    for (const item of items) {
      const product: any = await this.productRepo.findByIdUnscoped(item.productId);
      if (!product) {
        if (mode === 'strict') {
          throw createAppError(ERROR_CODES.ORDER_PRODUCT_NOT_FOUND, 404, undefined, { productId: item.productId });
        }
        partial.push(null);
        continue;
      }
      if (mode === 'lenient' && product.type !== 'physical') {
        partial.push(null);
        continue;
      }

      let vendor = vendorCache.get(item.vendorId);
      if (vendor === undefined) {
        vendor = await this.vendorRepo.findById(item.vendorId);
        vendorCache.set(item.vendorId, vendor);
      }
      if (!vendor) {
        if (mode === 'strict') {
          throw createAppError(ERROR_CODES.ORDER_VENDOR_NOT_FOUND, 404, undefined, { vendorId: item.vendorId });
        }
        partial.push(null);
        continue;
      }

      const agencyId: string | undefined =
        product.delivery?.agencyId?.toString() ?? vendor.default_delivery_agency_id?.toString();
      if (!agencyId || !mongoose.Types.ObjectId.isValid(agencyId)) {
        if (mode === 'strict') {
          throw createAppError(ERROR_CODES.ORDER_NO_DELIVERY_AGENCY, 422, undefined, { product: item.title ?? item.productId });
        }
        partial.push(null);
        continue;
      }

      // Snapshot the product's configured pickup location so a later edit to the vendor's
      // business addresses doesn't retroactively change history. Left null only for
      // pre-feature products that reached 'active' without one.
      const pickupLocation = product.delivery?.pickupLocation;
      let snapshot: PickupLocationSnapshot | null = null;
      let vendorRegion: string | null = null;
      if (pickupLocation?.source === 'agency_storage') {
        // Only the CHOICE is snapshotted (which depot), never the address: the depot's address
        // is the agency's live record. Null carries through as "the primary depot".
        snapshot = {
          source: 'agency_storage',
          vendor_address_id: null,
          agency_address_id: pickupLocation.agencyAddressId
            ? new mongoose.Types.ObjectId(pickupLocation.agencyAddressId)
            : null,
          address_snapshot: null,
        };
      } else if (pickupLocation?.source === 'vendor_address' && pickupLocation.vendorAddressId) {
        const address = vendor.business_addresses?.find(
          (a: any) => a._id.toString() === pickupLocation.vendorAddressId,
        );
        if (address) {
          snapshot = {
            source: 'vendor_address',
            vendor_address_id: new mongoose.Types.ObjectId(pickupLocation.vendorAddressId),
            agency_address_id: null,
            address_snapshot: {
              label: address.label,
              address_line1: address.address_line1,
              address_line2: address.address_line2 ?? null,
              city: address.city,
              state: address.state ?? null,
              geo: address.geo ?? null,
            },
          };
          vendorRegion = regionOfGeo(address.geo);
        }
      }

      partial.push({
        agencyId,
        pickupLocation: snapshot,
        weight: weights.get(item.variantId) ?? { grams: EARNINGS_CONFIG.DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS, source: 'default' },
        vendorRegion,
      });
    }

    // The depot's region, for agency-storage lines — one batched read.
    const storageAgencies = partial
      .filter((p): p is NonNullable<typeof p> => !!p && p.pickupLocation?.source === 'agency_storage')
      .map((p) => p.agencyId);
    const hqByAgency = storageAgencies.length
      ? await this.magazinRepo.findHqAddressListsByAgencyIds(storageAgencies)
      : new Map();

    return partial.map((p) => {
      if (!p) return null;
      let pickupRegion = p.vendorRegion;
      if (p.pickupLocation?.source === 'agency_storage') {
        const depot = resolveHqAddress(hqByAgency.get(p.agencyId), p.pickupLocation.agency_address_id);
        pickupRegion = depot ? (depot.region ?? regionOfGeo(depot.geo)) : null;
      }
      return { agencyId: p.agencyId, pickupLocation: p.pickupLocation, pickupRegion, weight: p.weight };
    });
  }

  /** Load the facts once, then price for each payment method asked (the quote asks two). */
  async priceMethods(
    input: { vendorId: string; deliveryRegion: string | null; lines: PricingLine[] },
    methods: Array<'online' | 'cash_on_delivery'>,
    mode: 'strict' | 'lenient',
  ): Promise<Map<'online' | 'cash_on_delivery', VendorOrderPricing>> {
    const agencyIds = [...new Set(input.lines.map((l) => l.agencyId).filter((id): id is string => !!id))];
    const [agencies, storedTerms, commissionPercent] = await Promise.all([
      agencyIds.length ? this.agencyRepo.findByIds(agencyIds) : Promise.resolve([]),
      this.settingsRepo.findDeliveryTerms(input.vendorId),
      this.entitlements
        .getEntitlements(input.vendorId)
        .then((e) => e.commissionPercent)
        .catch((error: unknown) => {
          if (mode === 'strict') throw error;
          console.error(`[VendorOrderPricingService] Commission not resolvable for vendor ${input.vendorId}:`, error);
          return null;
        }),
    ]);
    const policiesByAgency = new Map<string, IAgencyPolicies | null>(
      agencies.map((a: any) => [String(a._id), a.policies ?? null]),
    );
    const terms = vendorDeliveryTermsOf(storedTerms);

    const out = new Map<'online' | 'cash_on_delivery', VendorOrderPricing>();
    for (const paymentMethod of methods) {
      out.set(
        paymentMethod,
        priceVendorOrder(input.lines, {
          paymentMethod,
          deliveryRegion: input.deliveryRegion,
          terms,
          commissionPercent,
          policiesByAgency,
          flatFeeFallback: EARNINGS_CONFIG.DELIVERY_FLAT_FEE,
        }),
      );
    }
    return out;
  }

  async price(
    input: { vendorId: string; paymentMethod: 'online' | 'cash_on_delivery'; deliveryRegion: string | null; lines: PricingLine[] },
    mode: 'strict' | 'lenient',
  ): Promise<VendorOrderPricing> {
    const priced = await this.priceMethods(input, [input.paymentMethod], mode);
    return priced.get(input.paymentMethod)!;
  }
}

export const vendorOrderPricingService = new VendorOrderPricingService();
