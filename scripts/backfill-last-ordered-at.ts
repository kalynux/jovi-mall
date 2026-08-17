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
 *   npm run backfill:last-ordered
 *   npm run backfill:last-ordered -- --statuses=paid,refunded
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { OrderModel } from '../src/modules/orders/order.model';
import { ProductModel } from '../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../src/modules/catalog/models/product-variant.model';
import { loadFileCleanupConfig } from '../src/config/file-cleanup.config';

dotenv.config();

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

  const ops = rows
    .filter((r) => r._id)
    .map((r) => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { lastOrderedAt: r.last } },
      },
    }));

  if (ops.length === 0) return 0;
  const result = await model.bulkWrite(ops, { ordered: false });
  return result.modifiedCount ?? 0;
}

async function main() {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
  const statuses = parseStatuses();

  console.log(`[Backfill] Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);
  console.log(`[Backfill] Connected. Counting orders with payment_status in [${statuses.join(', ')}]`);

  try {
    const products = await backfill(ProductModel, 'product_id', statuses);
    console.log(`[Backfill] Updated lastOrderedAt on ${products} products`);

    const variants = await backfill(ProductVariantModel, 'variant_id', statuses);
    console.log(`[Backfill] Updated lastOrderedAt on ${variants} variants`);
  } finally {
    await mongoose.disconnect();
    console.log('[Backfill] Done. Disconnected.');
  }
}

main().catch((err) => {
  console.error('[Backfill] Failed:', err);
  process.exit(1);
});
