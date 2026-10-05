/**
 * Migration: give every collected COD cash collection its `delivered_at`, and re-key the
 * coverage FIFO's index from `collected_at` to `delivered_at` (REFUND-FLOW-PLAN R-6, § 5).
 *
 * Owner decision, 2026-10-05: deposits cover COD shipments OLDEST DELIVERY FIRST. The FIFO
 * (`CodSettlementService.applyFifoInSession`) used to sort on `collected_at`, the moment the
 * collection was CLAIMED — a whole dispute window after the delivery for an auto-collected
 * shipment — so cash that arrived first covered younger shipments. It now sorts
 * `{delivered_at: 1, _id: 1}`, and both collect paths stamp `delivered_at` in the claiming
 * transaction. This script brings the rows written before that up to the same shape.
 *
 * ── The three steps, in this order ──────────────────────────────────────────
 *
 *   1. Backfill. Every `status: 'collected'` row with no `delivered_at` gets one from its
 *      shipment's `status_history`, through the SAME pure rule the live paths use
 *      (`deliveredAtOf` in `src/modules/cod/domain/cod-fifo.ts`): the `agent_delivered`
 *      mark immediately before the `delivered` entry, else the row's own `collected_at`
 *      (a code submitted from `picked_up`/`in_transit` was itself the delivery). A row
 *      whose shipment is gone also falls back to `collected_at`, and is counted.
 *      `pending` / `cancelled` rows are left alone — nothing was delivered.
 *   2. Build `{agency_id: 1, status: 1, delivered_at: 1}` — the index the schema now
 *      declares — under Mongoose's default name, so `migrate:declared-indexes` later finds
 *      it present and builds nothing for it.
 *   3. Drop `{agency_id: 1, status: 1, collected_at: 1}`, matched by KEY SHAPE (the name is
 *      generated). Build-then-drop so the FIFO query never runs index-less in between.
 *      Nothing else needs the old index: cod-limits' and cod-summary's unsettled reads use
 *      the `{agency_id, status}` prefix the new index shares; the deposit-deadline worker
 *      filters on `{agent_id, agency_id, status}` (served by `{agent_id, status}`); the
 *      earnings release sweep filters `{status, collected_at}` with no agency, which the
 *      old index never served. The one reader that loses something is
 *      `delivery-analytics.forAgency` (`{agency_id, collected_at: window}`), which keeps the
 *      `agency_id` prefix and filters the window per agency — a small per-agency set.
 *
 * Nothing already covered is recalculated (§ 5.1): `settled_amount` / `settled_at` are not
 * read or written here. Only deposits confirmed from now on use the new order.
 *
 * Raw-driver reads and writes: a migration should not depend on the model's defaults to
 * describe rows written before the field existed.
 *
 * Idempotent: a second run finds no collected row without `delivered_at`, the new index
 * present and the old one gone, and writes nothing. `--dry-run` prints what it would do and
 * writes NOTHING.
 *
 * Run:  npx ts-node scripts/migrate-cod-collection-delivered-at.ts [--dry-run]
 *       (npm run migrate:cod-collection-delivered-at)
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose, { Types } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import { deliveredAtOf, StatusHistoryLike } from '../src/modules/cod/domain/cod-fifo';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 500;

const NEW_INDEX_KEY = { agency_id: 1, status: 1, delivered_at: 1 } as const;
const OLD_INDEX_KEY = { agency_id: 1, status: 1, collected_at: 1 } as const;

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

interface CollectionRow {
    _id: Types.ObjectId;
    shipment_id: Types.ObjectId;
    collected_at?: Date | null;
    created_at?: Date | null;
}

interface ShipmentRow {
    _id: Types.ObjectId;
    status_history?: StatusHistoryLike[];
}

async function backfill(): Promise<void> {
    const collections = mongoose.connection.collection(COLLECTIONS.CASH_COLLECTION);
    const shipments = mongoose.connection.collection(COLLECTIONS.SHIPMENT);

    const filter = { status: 'collected', $or: [{ delivered_at: null }, { delivered_at: { $exists: false } }] };
    const total = await collections.countDocuments(filter);
    console.log(`\n1. Backfill — ${total} collected row(s) without delivered_at`);
    if (total === 0) return;

    let fromHistory = 0;
    let fromCollectedAt = 0;
    let shipmentMissing = 0;
    let fromCreatedAt = 0;
    let written = 0;

    const cursor = collections
        .find(filter, { projection: { _id: 1, shipment_id: 1, collected_at: 1, created_at: 1 } })
        .batchSize(BATCH);

    let batch: CollectionRow[] = [];
    const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const shipmentDocs = (await shipments
            .find(
                { _id: { $in: batch.map((r) => r.shipment_id) } },
                { projection: { _id: 1, status_history: 1 } }
            )
            .toArray()) as unknown as ShipmentRow[];
        const historyById = new Map(shipmentDocs.map((s) => [s._id.toString(), s.status_history ?? []]));

        const ops = batch.map((row) => {
            const history = historyById.get(row.shipment_id.toString());
            if (!history) shipmentMissing++;
            const fallback = row.collected_at ?? null;
            let deliveredAt = deliveredAtOf(history, fallback);
            if (deliveredAt && fallback && deliveredAt === fallback) fromCollectedAt++;
            else if (deliveredAt) fromHistory++;
            if (!deliveredAt) {
                // A collected row with no collected_at should not exist; created_at is the
                // earliest honest bound, and it is counted so a non-zero figure is visible.
                deliveredAt = row.created_at ?? new Date(0);
                fromCreatedAt++;
            }
            return {
                updateOne: {
                    filter: { _id: row._id, status: 'collected', $or: [{ delivered_at: null }, { delivered_at: { $exists: false } }] },
                    update: { $set: { delivered_at: deliveredAt } },
                },
            };
        });

        if (!DRY_RUN) {
            const result = await collections.bulkWrite(ops, { ordered: false });
            written += result.modifiedCount;
        }
        batch = [];
    };

    for await (const doc of cursor) {
        batch.push(doc as unknown as CollectionRow);
        if (batch.length >= BATCH) await flush();
    }
    await flush();

    console.log(`   from the agent_delivered mark : ${fromHistory}`);
    console.log(`   from collected_at (coded handoff before agent_delivered, or no mark) : ${fromCollectedAt}`);
    console.log(`   of which the shipment is missing : ${shipmentMissing}`);
    console.log(`   from created_at (no collected_at at all — investigate if non-zero) : ${fromCreatedAt}`);
    console.log(DRY_RUN ? `   DRY RUN — would write ${total}` : `   written: ${written}`);
}

async function swapIndex(): Promise<void> {
    const collection = mongoose.connection.collection(COLLECTIONS.CASH_COLLECTION);
    const indexes = await collection.indexes();

    const hasNew = indexes.some((idx) => sameKey(idx.key as Record<string, unknown>, NEW_INDEX_KEY));
    const stale = indexes.filter((idx) => sameKey(idx.key as Record<string, unknown>, OLD_INDEX_KEY));

    console.log(`\n2. Build ${JSON.stringify(NEW_INDEX_KEY)} — ${hasNew ? 'already present' : DRY_RUN ? 'DRY RUN — would build' : 'building'}`);
    if (!hasNew && !DRY_RUN) {
        const name = await collection.createIndex({ ...NEW_INDEX_KEY });
        console.log(`   built ${name}`);
    }

    console.log(`\n3. Drop ${JSON.stringify(OLD_INDEX_KEY)} — ${stale.length === 0 ? 'already gone' : `${stale.length} found: ${stale.map((i) => i.name).join(', ')}`}`);
    if (stale.length > 0) {
        if (DRY_RUN) {
            console.log('   DRY RUN — would drop');
        } else {
            for (const idx of stale) {
                await collection.dropIndex(idx.name!);
                console.log(`   dropped ${idx.name}`);
            }
        }
    }
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI.replace(/\/\/[^@]*@/, '//***@')}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

    await backfill();
    await swapIndex();

    console.log('\nDone.');
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error('Migration failed:', err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
