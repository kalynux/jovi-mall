/**
 * repair:cod-pending-fulfilment — heal COD orders whose fulfillment_status never left 'pending'.
 *
 * DRY-RUN BY DEFAULT. Prints what it would change and writes nothing. Pass `--apply` to write.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A cash-on-delivery order is created at fulfillment_status 'pending', and — unlike a prepaid
 * order, which moves to 'processing' at payment — nothing moved it on dispatch. The aggregation
 * service refused to recompute out of 'pending', so every COD order the vendor never hand-marked
 * 'processing' stayed 'pending' through pickup, transit and a code-verified delivery. Because
 * `CashCollectionService.collect` only completes an order that reached 'delivered', those orders
 * were also never COMPLETED — the escrow hold window never started, so nobody's COD earnings
 * could mature.
 *
 * `OrderFulfillmentAggregationService` now recomputes from 'pending'. That heals every order on
 * its NEXT shipment event — which a delivered order never has. This script is that missing event.
 *
 * ── WHAT IT DOES, PER ORDER ──────────────────────────────────────────────────
 *  1. Recompute fulfillment_status through the real aggregation service (the fixed one).
 *  2. If the order is now settled (every item delivered/returned) and not completed, complete it
 *     through the real `OrderCompletionService` — stamping `completion`, appending the timeline
 *     event and starting the hold window, exactly as `collect()` would have. Attributed to the
 *     customer when every collected cash row was code-verified (the code IS their confirmation),
 *     otherwise to the system as an auto-completion.
 *
 * Idempotent: a second run finds nothing.
 *
 * Run: npm run repair:cod-pending-fulfilment            (dry run)
 *      npm run repair:cod-pending-fulfilment -- --apply
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Never let a repair script create collections or build indexes on the target (see
// migrate:declared-indexes — autoIndex once turned a --dry-run into a write).
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

import { OrderModel } from '../src/modules/orders/order.model';
import { orderFulfillmentAggregationService } from '../src/modules/orders/domain/services/OrderFulfillmentAggregationService';
import { orderCompletionService } from '../src/modules/orders/order-completion.service';
import { CashCollectionModel } from '../src/modules/cod/models/cash-collection.model';

const SHIPPED_OR_BEYOND = ['handing_over', 'picked_up', 'in_transit', 'agent_delivered', 'delivered', 'returned'];

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const candidates = await OrderModel.find({
    payment_method: 'cash_on_delivery',
    order_type: 'physical',
    fulfillment_status: 'pending',
    'items.delivery.status': { $in: SHIPPED_OR_BEYOND },
  }).select('_id order_number');

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — ${candidates.length} COD order(s) stuck at fulfillment 'pending'.\n`);

  let recomputed = 0;
  let completed = 0;

  for (const { _id, order_number } of candidates) {
    const orderId = _id.toString();
    const before = await OrderModel.findById(orderId);
    if (!before) continue;
    const itemStatuses = before.items.map((i) => i.delivery?.status ?? '-').join(',');

    if (!apply) {
      const settled = orderCompletionService.isSettled(before);
      console.log(
        `  ${order_number} (${orderId}) payment=${before.payment_status} items=[${itemStatuses}]` +
          ` → would recompute${settled && !before.completion?.confirmed_at ? ' + complete' : ''}`
      );
      continue;
    }

    const next = await orderFulfillmentAggregationService.recomputeFulfillmentStatus(orderId);
    if (next) recomputed++;

    const order = await OrderModel.findById(orderId);
    let didComplete = false;
    if (order && !order.completion?.confirmed_at && orderCompletionService.isSettled(order)) {
      const collected = await CashCollectionModel.find({ order_id: orderId, status: 'collected' }).lean();
      const allCoded = collected.length > 0 && collected.every((c: any) => c.verification?.method === 'code');
      await orderCompletionService.complete(order, allCoded ? 'customer' : 'system', !allCoded, null);
      completed++;
      didComplete = true;
    }

    console.log(
      `  ${order_number} (${orderId}) items=[${itemStatuses}] fulfillment pending → ${next ?? 'unchanged'}` +
        `${didComplete ? ', completed' : ''}`
    );
  }

  console.log(`\n${apply ? `Recomputed ${recomputed}, completed ${completed}.` : 'Nothing written. Re-run with --apply to repair.'}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
