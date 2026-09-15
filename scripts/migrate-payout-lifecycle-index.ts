/**
 * Migration: widen the payout-request uniqueness constraint, and add the transfer index.
 *
 *   payout_requests  DROP   owner_type_1_owner_id_1     ← unique where status = 'pending'
 *   payout_requests  BUILD  payout_one_held_per_owner   ← unique where status is HELD
 *   payout_requests  BUILD  payout_transfer_reference   ← unique sparse merchant reference
 *
 * ── Why the old index is not merely left in place ───────────────────────────
 * It would still be *correct* — a `pending`-only constraint is a subset of the new one, so
 * nothing it forbids is newly allowed. What makes the drop necessary is the name: Mongoose
 * auto-names an index on `{owner_type, owner_id}` as `owner_type_1_owner_id_1`, and the
 * model now declares that key with a DIFFERENT partial filter. Same name, different options
 * is `IndexOptionsConflict`, and because `autoIndex` is on, that failure arrives as an
 * unhandled rejection at boot while the process reports itself healthy. So the old index has
 * to go before the new one can exist.
 *
 * ── What the new constraint buys ────────────────────────────────────────────
 * `processing` and `failed` are both non-terminal AND still holding the owner's money in
 * `requested_balance`. Under the old filter neither counted as an open request, so an owner
 * whose transfer had failed could open a second payout for a balance they had not got back —
 * and the platform would owe the money twice. `PAYOUT_HELD_STATUSES` on the model is the
 * single definition of that list; this script mirrors it deliberately rather than importing
 * it (see below).
 *
 * ⚠ **This script must not import the model, and that is not a style choice.** `autoIndex`
 * is on: importing a model registers its schema, and merely connecting then builds every
 * index it declares — which would make `--dry-run` WRITE. That has happened on this project
 * before. Everything here is a literal, and `test:payout-lifecycle` asserts the literals
 * against the model so the copy cannot drift silently.
 *
 * Idempotent: re-running after a successful run finds the new indexes present and the old
 * one already gone, and does nothing. It drops exactly one index, by exact name, and only
 * when that index carries the old `pending`-only filter — an index of that name with any
 * other shape is reported and left alone.
 *
 * Run:  npx ts-node scripts/migrate-payout-lifecycle-index.ts [--dry-run]
 *       (npm run migrate:payout-lifecycle-index)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const COLLECTION = COLLECTIONS.PAYOUT_REQUEST;

/** The legacy auto-named index this migration replaces. */
const LEGACY_NAME = 'owner_type_1_owner_id_1';

/**
 * Mirrors `PAYOUT_HELD_STATUSES` on the model. Not imported — see the header on why this
 * file may not touch the model. `test:payout-lifecycle` asserts the two agree.
 */
const HELD_STATUSES = ['pending', 'processing', 'failed'];

interface PlannedIndex {
    name: string;
    key: Record<string, IndexDirection>;
    options: Record<string, unknown>;
    why: string;
}

const PLANNED: PlannedIndex[] = [
    {
        name: 'payout_one_held_per_owner',
        key: { owner_type: 1, owner_id: 1 },
        options: {
            unique: true,
            partialFilterExpression: { status: { $in: HELD_STATUSES } },
        },
        why: 'at most one payout per owner while their funds are held — the double-request guard',
    },
    {
        name: 'payout_transfer_reference',
        key: { transfer_reference: 1 },
        options: {
            unique: true,
            partialFilterExpression: { transfer_reference: { $type: 'string' } },
        },
        why: 'routes a gateway transfer callback home, and refuses two payouts claiming one transfer',
    },
];

interface ExistingIndex {
    name: string;
    key: Record<string, unknown>;
    unique?: boolean;
    partialFilterExpression?: Record<string, unknown>;
}

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

/**
 * Compared on the partial filter as well as the key and uniqueness: an index on the right
 * key whose filter is narrower is precisely the thing this migration exists to replace, and
 * reporting it as present would leave the constraint unwidened while claiming success.
 */
function satisfies(existing: ExistingIndex, planned: PlannedIndex): boolean {
    if (!sameKey(existing.key, planned.key)) return false;
    if ((planned.options.unique === true) !== (existing.unique === true)) return false;
    return (
        JSON.stringify(existing.partialFilterExpression ?? null) ===
        JSON.stringify(planned.options.partialFilterExpression ?? null)
    );
}

/** Is this the old `pending`-only constraint, precisely? */
function isLegacyPendingIndex(existing: ExistingIndex): boolean {
    if (existing.name !== LEGACY_NAME) return false;
    if (!sameKey(existing.key, { owner_type: 1, owner_id: 1 })) return false;
    return JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify({ status: 'pending' });
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

    let built = 0;
    let dropped = 0;
    let failed = 0;

    const present = await mongoose.connection
        .db!.listCollections({ name: COLLECTION }, { nameOnly: true })
        .toArray();

    if (present.length === 0) {
        console.log(
            `\n${COLLECTION}: does not exist yet — nothing to do (it is created on first write, ` +
                'and Mongoose builds the current indexes at that point)'
        );
        await mongoose.disconnect();
        return;
    }

    const collection = mongoose.connection.collection(COLLECTION);
    const existing = (await collection.indexes()) as ExistingIndex[];

    console.log(`\n${COLLECTION}: ${existing.length} index(es) present`);
    for (const idx of existing) {
        const filter = idx.partialFilterExpression
            ? `  partial=${JSON.stringify(idx.partialFilterExpression)}`
            : '';
        console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}${filter}`);
    }

    // ── 1. Drop the legacy constraint, so the wider one can be built ──────────
    const legacy = existing.find((idx) => idx.name === LEGACY_NAME);
    if (!legacy) {
        console.log(`\n  ✔ ${LEGACY_NAME}: already gone`);
    } else if (!isLegacyPendingIndex(legacy)) {
        console.error(
            `\n  ✋ ${LEGACY_NAME}: exists but is not the pending-only constraint ` +
                `(partial=${JSON.stringify(legacy.partialFilterExpression ?? null)}). ` +
                'Left alone — dropping an unrecognised index on a money collection is a decision for a person.'
        );
        failed += 1;
    } else if (DRY_RUN) {
        console.log(`\n  → ${LEGACY_NAME}: WOULD drop (superseded by payout_one_held_per_owner)`);
    } else {
        process.stdout.write(`\n  dropping ${LEGACY_NAME} … `);
        try {
            await collection.dropIndex(LEGACY_NAME);
            console.log('done');
            dropped += 1;
        } catch (error) {
            console.log('FAILED');
            console.error(`    ${error instanceof Error ? error.message : String(error)}`);
            failed += 1;
        }
    }

    // ── 2. Build the replacements ────────────────────────────────────────────
    for (const target of PLANNED) {
        if (existing.some((idx) => satisfies(idx, target))) {
            console.log(`  ✔ ${target.name}: already present`);
            continue;
        }

        if (DRY_RUN) {
            console.log(`  → ${target.name}: WOULD build ${JSON.stringify(target.key)} — ${target.why}`);
            continue;
        }

        process.stdout.write(`  building ${target.name} ${JSON.stringify(target.key)} … `);
        try {
            await collection.createIndex(target.key as never, { name: target.name, ...target.options });
            console.log('done');
            built += 1;
        } catch (error) {
            console.log('FAILED');
            /**
             * The interesting failure is E11000 on `payout_one_held_per_owner`: an owner
             * already holds two rows in HELD statuses, which under the old filter was legal
             * (one `pending` plus one that had been left `processing` by hand). That is a
             * data decision — resolve one of them — not something a migration may guess at.
             */
            console.error(`    ${error instanceof Error ? error.message : String(error)}`);
            failed += 1;
        }
    }

    console.log(
        DRY_RUN
            ? '\nDRY RUN — nothing was written. Re-run without --dry-run to apply.'
            : `\nDone. ${dropped} index(es) dropped, ${built} built, ${failed} problem(s).`
    );

    await mongoose.disconnect();
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
