/**
 * Migration: build the indexes on `admin_action_log`, including its TTL.
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 *
 * `autoIndex` is on, so Mongoose creates these at boot on its own — for a collection whose
 * MODEL has been loaded. `AdminActionLogModel` is imported by the `/admin/*` middleware and
 * therefore is loaded, so in practice the boot path covers it.
 *
 * The script exists anyway because ONE of these indexes is not an optimisation:
 *
 *   { occurred_at: 1 } with expireAfterSeconds
 *
 * That TTL is the only thing bounding this collection. It has no export path, no purge job
 * and no retention owner — unlike wi-admin's `admin_audit_log`, whose partial TTL is
 * conditional on an export having happened. If the TTL is silently absent, nothing fails,
 * nothing warns, and the collection grows in the platform database forever.
 *
 * `autoIndex` failing is silent by design (Mongoose logs and continues), which is exactly
 * how a missing 2dsphere went unnoticed elsewhere in this codebase. So: run this with the
 * deploy, and read what it prints.
 *
 * Idempotent. `syncIndexes` creates what is missing and drops what the schema no longer
 * declares; running it twice is a no-op.
 *
 * Run:  npx ts-node scripts/migrate-admin-action-log-indexes.ts [--dry-run]
 *       (npm run migrate:admin-action-log)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import {
    ADMIN_ACTION_LOG_TTL_DAYS,
    AdminActionLogModel,
} from '../src/core/audit/admin-action.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    process.stdout.write(`\n[admin-action-log] connected${DRY_RUN ? ' (DRY RUN)' : ''}\n\n`);

    const existing = await AdminActionLogModel.listIndexes().catch(() => []);
    process.stdout.write(`  before: ${existing.length} index(es)\n`);

    for (const index of existing) {
        const ttl = typeof index.expireAfterSeconds === 'number'
            ? `  TTL ${Math.round(index.expireAfterSeconds / 86_400)}d`
            : '';
        process.stdout.write(`    ${index.name}${ttl}\n`);
    }

    if (DRY_RUN) {
        process.stdout.write(
            '\n  DRY RUN — syncIndexes() would create the five declared indexes,\n'
            + `             including the ${ADMIN_ACTION_LOG_TTL_DAYS}-day TTL on occurred_at.\n\n`,
        );
        return;
    }

    const dropped = await AdminActionLogModel.syncIndexes();
    const after = await AdminActionLogModel.listIndexes();

    process.stdout.write(`\n  after:  ${after.length} index(es)`);
    if (dropped.length > 0) process.stdout.write(`, dropped ${dropped.join(', ')}`);
    process.stdout.write('\n');

    /**
     * The one check worth making explicitly. Everything else here is a performance index;
     * this is the only bound on the collection's size, and its absence is silent.
     */
    const ttl = after.find((index) => typeof index.expireAfterSeconds === 'number');
    if (ttl) {
        const days = Math.round((ttl.expireAfterSeconds as number) / 86_400);
        process.stdout.write(`\n  ✅ TTL present: rows expire ${days} days after occurred_at\n\n`);
    } else {
        process.stdout.write(
            '\n  ❌ NO TTL INDEX. This collection is now unbounded — investigate before\n'
            + '     leaving it in production.\n\n',
        );
        process.exitCode = 1;
    }
}

main()
    .then(async () => {
        await mongoose.disconnect();
    })
    .catch(async (error) => {
        process.stderr.write(
            `\n[admin-action-log] failed: ${error instanceof Error ? error.message : String(error)}\n\n`,
        );
        await mongoose.disconnect().catch(() => undefined);
        process.exit(1);
    });
