#!/usr/bin/env ts-node

/**
 * Backfill Product/Variant `lastOrderedAt`
 *
 * One-time migration that seeds the file-cleanup inactivity clock from existing
 * order history. For every product and variant that appears in a paid order, sets
 * `lastOrderedAt` to the most recent such order's timestamp. Products that never
 * sold are left null (the cleanup sweep falls back to createdAt).
 *
 * Idempotent: safe to re-run. After this, OrderService.handlePaymentSuccess keeps
 * the field current.
 *
 * Usage:
 *   npm run backfill:last-ordered [-- --dry-run]
 *   npm run backfill:last-ordered -- --statuses=paid,refunded
 *
 * `--dry-run` was added in plan step 2.C.3, with the other two that lacked one. It runs the
 * same aggregation and then reads back the CURRENT `lastOrderedAt` for the ids it produced,
 * so what it reports is the number of rows that would actually change — not the number the
 * aggregation matched. The two differ by everything already correct from a previous run,
 * which on a re-run is nearly all of them; reporting the larger number would make an
 * idempotent no-op look like a mass update.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../src/modules/catalog/models/product-variant.model';
import { loadFileCleanupConfig } from '../src/config/file-cleanup.config';

dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');

function parseStatuses(): string[] {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--statuses='));
  if (arg) {
    const parsed = arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return loadFileCleanupConfig().activeOrderStatuses;
}

async function backfill(
  model: mongoose.Model<any>,
  itemField: 'product_id' | 'variant_id',
  statuses: string[],
): Promise<number> {
  const rows = await OrderModel.aggregate<{ _id: mongoose.Types.ObjectId; last: Date }>([
    { $match: { payment_status: { $in: statuses } } },
    { $unwind: '$items' },
    { $group: { _id: `$items.${itemField}`, last: { $max: '$created_at' } } },
  ]);

  if (rows.length === 0) return 0;

  const targets = rows.filter((r) => r._id);
  if (targets.length === 0) return 0;

  if (DRY_RUN) {
    // Count what would CHANGE, not what the aggregation matched. One read of the current
    // values for exactly these ids; comparison in memory, because `lastOrderedAt` is a
    // Date and `$ne` against a per-row value has no single-query form.
    const current = await model
      .find({ _id: { $in: targets.map((r) => r._id) } }, { lastOrderedAt: 1 })
      .lean()
      .exec();
    const existing = new Map<string, Date | null>(
      (current as Array<{ _id: mongoose.Types.ObjectId; lastOrderedAt?: Date | null }>)
        .map((doc) => [doc._id.toString(), doc.lastOrderedAt ?? null]),
    );
    return targets.filter((r) => {
      const now = existing.get(r._id.toString());
      // Absent from the map = the id is on an order item but the product/variant is gone.
      // bulkWrite would match nothing for it, so it is not a change.
      if (now === undefined) return false;
      return now === null || now.getTime() !== r.last.getTime();
    }).length;
  }

  const ops = targets.map((r) => ({
    updateOne: {
      filter: { _id: r._id },
      update: { $set: { lastOrderedAt: r.last } },
    },
  }));

  const result = await model.bulkWrite(ops, { ordered: false });
  return result.modifiedCount ?? 0;
}

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
  const statuses = parseStatuses();

  console.log(`[Backfill] Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);
  console.log(
    `[Backfill] Connected${DRY_RUN ? ' (DRY RUN — nothing will be written)' : ''}. ` +
    `Counting orders with payment_status in [${statuses.join(', ')}]`,
  );

  try {
    const verb = DRY_RUN ? 'WOULD update' : 'Updated';

    const products = await backfill(ProductModel, 'product_id', statuses);
    console.log(`[Backfill] ${verb} lastOrderedAt on ${products} products`);

    const variants = await backfill(ProductVariantModel, 'variant_id', statuses);
    console.log(`[Backfill] ${verb} lastOrderedAt on ${variants} variants`);

    if (DRY_RUN) {
      console.log('[Backfill] DRY RUN — nothing was written. Re-run without --dry-run to apply.');
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
