#!/usr/bin/env ts-node

/**
 * Backfill Shipment `tracking_number`
 *
 * Tracking numbers used to be typed in by the agency or agent through
 * `PATCH /api/{agency,agent}/shipments/:id/tracking-number`, so most existing
 * shipments have none. They are now generated at creation and read-only (see
 * `src/modules/shipments/utils/tracking-number.generator.ts`), and the whole
 * platform treats the number as the shipment's public handle — support quotes
 * it, the shipment search matches it, the ticket reference endpoint returns it.
 * A shipment without one is a shipment nobody can refer to.
 *
 * For every shipment with no tracking number, generates one from its OWN agency
 * and its OWN creation timestamp — so a backfilled number is indistinguishable
 * from a natively generated one and still says when the shipment was created.
 *
 * Shipments that already carry a number (including hand-typed carrier numbers
 * from before generation) are LEFT ALONE. Whatever the customer was told is
 * still what the shipment answers to; overwriting it would break exactly the
 * lookups this field exists for.
 *
 * Idempotent: safe to re-run — only touches null/missing/blank numbers.
 *
 * Usage:
 *   npm run backfill:shipment-tracking-numbers
 *   npm run backfill:shipment-tracking-numbers -- --dry-run
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ShipmentModel } from '../src/modules/shipments/shipment.model';
import { AgencyMagazinModel } from '../src/modules/magazin/models/magazin.model';
import {
  agencyAcronym,
  formatTrackingNumber,
  TRACKING_NUMBER_PATTERN,
} from '../src/modules/shipments/utils/tracking-number.generator';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

  console.log(`[Backfill] Connecting to MongoDB...${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);
  await mongoose.connect(MONGO_URI);
  console.log('[Backfill] Connected. Scanning shipments with no tracking number...');

  try {
    const shipments = await ShipmentModel.find({
      $or: [
        { tracking_number: { $exists: false } },
        { tracking_number: null },
        { tracking_number: '' },
      ],
    })
      .select('_id agency_id created_at')
      .lean()
      .exec();

    console.log(`[Backfill] Found ${shipments.length} shipment(s) without a tracking number.`);

    // One name lookup per agency, not per shipment.
    const agencyIds = [...new Set(shipments.map((s) => s.agency_id.toString()))];
    const magazins = await AgencyMagazinModel.find({ agency_id: { $in: agencyIds } })
      .select('agency_id name')
      .lean()
      .exec();
    const acronymByAgency = new Map<string, string>(
      magazins.map((m) => [m.agency_id.toString(), agencyAcronym(m.name)])
    );

    let updated = 0;
    let collisions = 0;
    let failed = 0;
    const withoutMagazin = new Set<string>();

    for (const shipment of shipments) {
      const agencyId = shipment.agency_id.toString();
      const acronym = acronymByAgency.get(agencyId);
      if (!acronym) withoutMagazin.add(agencyId);

      // `created_at` predates the timestamps option on a handful of very old
      // documents; today's date is the honest fallback for "unknown".
      const createdAt = shipment.created_at ?? new Date();

      let assigned: string | null = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = formatTrackingNumber(acronym ?? agencyAcronym(null), createdAt);
        if (await ShipmentModel.exists({ tracking_number: candidate })) {
          collisions++;
          continue;
        }
        assigned = candidate;
        break;
      }

      if (!assigned || !TRACKING_NUMBER_PATTERN.test(assigned)) {
        console.error(`[Backfill] Could not generate a number for shipment ${shipment._id.toString()}`);
        failed++;
        continue;
      }

      if (!DRY_RUN) {
        await ShipmentModel.updateOne({ _id: shipment._id }, { $set: { tracking_number: assigned } });
      }
      updated++;
    }

    console.log(`[Backfill] ${DRY_RUN ? 'Would update' : 'Updated'} ${updated} shipment(s).`);
    if (collisions) console.log(`[Backfill] Retried after ${collisions} suffix collision(s).`);
    if (failed) console.log(`[Backfill] FAILED on ${failed} shipment(s) — re-run to retry them.`);
    if (withoutMagazin.size) {
      console.log(
        `[Backfill] ${withoutMagazin.size} agenc(y/ies) have no magazin — their shipments got the generic prefix.`
      );
    }
  } finally {
    await mongoose.disconnect();
    console.log('[Backfill] Done. Disconnected.');
  }
}

main().catch((err) => {
  console.error('[Backfill] Failed:', err);
  process.exit(1);
});
