#!/usr/bin/env ts-node

/**
 * Backfill Product `delivery.pickup_location`
 *
 * Physical-product activation now requires a pickup location (see
 * ProductStatusValidationService / PickupLocationValidationService) so the
 * delivery agency knows where to collect the item from. Existing physical
 * products predate this field and would otherwise get silently demoted to
 * 'draft' the next time they're edited or swept by the delivery-agency
 * restore cascade.
 *
 * For every physical product missing `delivery.pickup_location`, resolves its
 * effective agency (product's own override, else the vendor's default) and
 * sets:
 *   - `vendor_address` (the vendor's first business address) if the agency's
 *     `policies.pricing.pickup_based.enabled` is true, else
 *   - `agency_storage` if `policies.pricing.storage_based.enabled` is true,
 *     else leaves the product untouched (no valid default exists yet — the
 *     activation gate/backfill re-run will catch it once the vendor or
 *     agency fixes their setup).
 *
 * Idempotent: safe to re-run. Only touches products with no pickup_location.
 *
 * Usage:
 *   npm run backfill:pickup-locations
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ProductModel } from '../src/modules/catalog/models/product.model';
import { VendorModel, IVendor } from '../src/modules/vendors/vendor.model';
import { DeliveryAgencyModel, IDeliveryAgency } from '../src/modules/delivery/delivery-agency.model';

dotenv.config();

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

  console.log('[Backfill] Connecting to MongoDB...');
  await mongoose.connect(MONGO_URI);
  console.log('[Backfill] Connected. Scanning physical products missing delivery.pickup_location...');

  try {
    const products = await ProductModel.find({
      type: 'physical',
      deletedAt: null,
      $or: [
        { 'delivery.pickup_location': { $exists: false } },
        { 'delivery.pickup_location': null },
      ],
    }).exec();

    console.log(`[Backfill] Found ${products.length} candidate product(s).`);

    const vendorCache = new Map<string, IVendor | null>();
    const agencyCache = new Map<string, IDeliveryAgency | null>();

    let updated = 0;
    let skippedNoAgency = 0;
    let skippedNoPolicyMatch = 0;

    for (const product of products) {
      const vendorId = product.vendorId.toString();
      let vendor = vendorCache.get(vendorId);
      if (vendor === undefined) {
        vendor = await VendorModel.findById(vendorId).exec();
        vendorCache.set(vendorId, vendor);
      }
      if (!vendor) {
        skippedNoAgency++;
        continue;
      }

      const effectiveAgencyId = (product.delivery?.agency_id ?? vendor.default_delivery_agency_id)?.toString();
      if (!effectiveAgencyId) {
        skippedNoAgency++;
        continue;
      }

      let agency = agencyCache.get(effectiveAgencyId);
      if (agency === undefined) {
        agency = await DeliveryAgencyModel.findById(effectiveAgencyId).exec();
        agencyCache.set(effectiveAgencyId, agency);
      }
      if (!agency) {
        skippedNoAgency++;
        continue;
      }

      const pickupBasedEnabled = agency.policies?.pricing?.pickup_based?.enabled ?? false;
      const storageBasedEnabled = agency.policies?.pricing?.storage_based?.enabled ?? false;
      const firstAddress = vendor.business_addresses?.[0];

      // `agency_address_id` is written explicitly as null — meaning "the agency's
      // primary depot". This backfill deliberately never picks a depot: nobody
      // asked the vendor, and null tracks the primary if the agency reorders,
      // where a stamped id would freeze a guess. Products already carrying a
      // pickup location are skipped by the query above and need no backfill for
      // the same reason — a missing depot id already reads as the primary.
      let pickupLocation: {
        source: 'vendor_address' | 'agency_storage';
        vendor_address_id: mongoose.Types.ObjectId | null;
        agency_address_id: mongoose.Types.ObjectId | null;
      } | null = null;
      if (pickupBasedEnabled && firstAddress) {
        pickupLocation = { source: 'vendor_address', vendor_address_id: firstAddress._id, agency_address_id: null };
      } else if (storageBasedEnabled) {
        pickupLocation = { source: 'agency_storage', vendor_address_id: null, agency_address_id: null };
      }

      if (!pickupLocation) {
        skippedNoPolicyMatch++;
        continue;
      }

      await ProductModel.updateOne(
        { _id: product._id },
        { $set: { 'delivery.pickup_location': pickupLocation } },
      );
      updated++;
    }

    console.log(`[Backfill] Updated ${updated} product(s).`);
    console.log(`[Backfill] Skipped (no resolvable agency): ${skippedNoAgency}`);
    console.log(`[Backfill] Skipped (agency policy allows neither pickup nor storage): ${skippedNoPolicyMatch}`);
  } finally {
    await mongoose.disconnect();
    console.log('[Backfill] Done. Disconnected.');
  }
}

main().catch((err) => {
  console.error('[Backfill] Failed:', err);
  process.exit(1);
});
