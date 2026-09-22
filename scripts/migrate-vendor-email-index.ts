/**
 * Migration: make vendor email uniqueness apply only to vendors that HAVE an email.
 *
 *   vendors  BUILD  vendor_email_unique_when_set    ← unique where email is a string
 *   vendors  DROP   email_1                         ← unique on every document, missing = null
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * `Vendor.email` was `required: true, unique: true`, and it is the only role model that
 * required one. `register` and `addRole` both copy it from the account, whose email is
 * optional, so an email-less agent, agency or customer adding the vendor role failed with a
 * Mongoose ValidationError — a 500, because the error handler has no other way to report it.
 *
 * Dropping `required` alone is only half the fix, which is why this migration exists. The
 * field-level `unique: true` built a plain unique index, and a plain unique index counts a
 * MISSING field as `null`. So the first email-less vendor would succeed and the second would
 * fail on E11000 (`409 DATABASE_UNIQUE_CONSTRAINT_VIOLATION`) — the same defect, moved one
 * account along.
 *
 * ── Why the old index must be DROPPED, not merely out-built ──────────────────
 * MongoDB 7 accepts the partial index beside `email_1` — same key, different filter, different
 * name (probed 2026-09-21). Building it alone would therefore succeed, report success, and
 * change nothing: `email_1` would go on refusing the second email-less vendor. The drop IS
 * the fix.
 *
 * ── BUILD, then DROP — in that order ─────────────────────────────────────────
 * Because the two coexist, building first means there is no instant at which two vendors may
 * claim one address: `email_1` holds until its replacement exists. The reverse order opens that
 * window, and leaves it open indefinitely if the build then fails. So the drop is skipped
 * whenever the build did not succeed.
 *
 * It must run BEFORE `migrate:declared-indexes`, which builds whatever the schemas declare
 * and never drops. That one would build the partial index and leave `email_1` in place.
 *
 * ⚠ **This script must not import the model, and that is not a style choice.** `autoIndex`
 * is on in development: importing a model registers its schema, and merely connecting then
 * builds every index it declares — which would make `--dry-run` WRITE. So everything here is
 * a literal, and `test:role-provisioning` asserts the literals against the model.
 *
 * Idempotent: a re-run finds `email_1` gone and the partial index present, and does nothing.
 * It drops exactly one index, by exact name, and only when that index is the plain unique
 * `{ email: 1 }` it replaces; an index of that name with any other shape is reported and left
 * alone. Reads and writes no document — an index migration only (D-5).
 *
 * Run:  npx ts-node scripts/migrate-vendor-email-index.ts [--dry-run]
 *       (npm run migrate:vendor-email-index)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const COLLECTION = COLLECTIONS.VENDOR;

/** The auto-named index the old field-level `unique: true` built. */
const LEGACY_NAME = 'email_1';

/** Mirrors the `VendorSchema.index({ email: 1 }, …)` declaration. Not imported — see the header. */
const TARGET = {
    name: 'vendor_email_unique_when_set',
    key: { email: 1 } as Record<string, IndexDirection>,
    options: {
        unique: true,
        partialFilterExpression: { email: { $type: 'string' } },
    },
};

interface ExistingIndex {
    name: string;
    key: Record<string, unknown>;
    unique?: boolean;
    sparse?: boolean;
    partialFilterExpression?: Record<string, unknown>;
}

function isEmailKey(key: Record<string, unknown>): boolean {
    const fields = Object.keys(key);
    return fields.length === 1 && fields[0] === 'email' && key.email === 1;
}

/** Is this the plain unique index the old field-level declaration built, precisely? */
function isLegacyEmailIndex(existing: ExistingIndex): boolean {
    return existing.name === LEGACY_NAME
        && isEmailKey(existing.key)
        && existing.unique === true
        && existing.sparse !== true
        && existing.partialFilterExpression === undefined;
}

/**
 * Compared on the partial filter as well as the key: a unique `{ email: 1 }` WITHOUT the
 * filter is exactly what this migration exists to remove, and reporting it as the target
 * would claim success while leaving the second email-less vendor refused.
 */
function isTarget(existing: ExistingIndex): boolean {
    return isEmailKey(existing.key)
        && existing.unique === true
        && JSON.stringify(existing.partialFilterExpression ?? null)
            === JSON.stringify(TARGET.options.partialFilterExpression);
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

    const present = await mongoose.connection
        .db!.listCollections({ name: COLLECTION }, { nameOnly: true })
        .toArray();

    if (present.length === 0) {
        console.log(
            `\n${COLLECTION}: does not exist yet — nothing to do (\`migrate:declared-indexes\` ` +
                'builds the declared index on a fresh database)'
        );
        await mongoose.disconnect();
        return;
    }

    const collection = mongoose.connection.collection(COLLECTION);
    const existing = (await collection.indexes()) as ExistingIndex[];

    console.log(`\n${COLLECTION}: ${existing.length} index(es) present`);
    for (const idx of existing.filter((i) => 'email' in i.key)) {
        const flags = [
            idx.unique ? 'unique' : null,
            idx.sparse ? 'sparse' : null,
            idx.partialFilterExpression ? `partial=${JSON.stringify(idx.partialFilterExpression)}` : null,
        ].filter(Boolean).join(' ');
        console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}  ${flags}`);
    }

    let built = 0;
    let dropped = 0;
    let failed = 0;

    // ── 1. Build the partial replacement, beside the old index ─────────────────
    let targetInPlace = existing.some(isTarget);
    if (targetInPlace) {
        console.log(`\n  ✔ ${TARGET.name}: already present`);
    } else if (DRY_RUN) {
        console.log(`\n  → ${TARGET.name}: WOULD build ${JSON.stringify(TARGET.key)} unique, partial on a string email`);
    } else {
        process.stdout.write(`\n  building ${TARGET.name} ${JSON.stringify(TARGET.key)} … `);
        try {
            await collection.createIndex(TARGET.key as never, { name: TARGET.name, ...TARGET.options });
            console.log('done');
            built += 1;
            targetInPlace = true;
        } catch (error) {
            console.log('FAILED');
            /**
             * E11000 here means two vendors already share an email. Unreachable while
             * `email_1` enforced uniqueness on every row — so it would mean the data changed
             * under the old index, and which vendor keeps the address is a person's call.
             */
            console.error(`    ${error instanceof Error ? error.message : String(error)}`);
            failed += 1;
        }
    }

    // ── 2. Drop the constraint that counts a missing email as null ─────────────
    const legacy = existing.find((idx) => idx.name === LEGACY_NAME);
    if (!legacy) {
        console.log(`  ✔ ${LEGACY_NAME}: already gone`);
    } else if (!isLegacyEmailIndex(legacy)) {
        console.error(
            `  ✋ ${LEGACY_NAME}: exists but is not the plain unique { email: 1 } this replaces ` +
                `(unique=${legacy.unique === true} sparse=${legacy.sparse === true} ` +
                `partial=${JSON.stringify(legacy.partialFilterExpression ?? null)}). ` +
                'Left alone — somebody built it on purpose, and that is a decision for a person.'
        );
        failed += 1;
    } else if (DRY_RUN) {
        console.log(`  → ${LEGACY_NAME}: WOULD drop (superseded by ${TARGET.name})`);
    } else if (!targetInPlace) {
        // See the header: dropping without the replacement in place leaves vendor email
        // uniqueness enforced by nothing. Keep the old constraint and fail the run instead.
        console.error(`  ✋ ${LEGACY_NAME}: NOT dropped — ${TARGET.name} is not in place, so it is still the only guard`);
    } else {
        process.stdout.write(`  dropping ${LEGACY_NAME} … `);
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
