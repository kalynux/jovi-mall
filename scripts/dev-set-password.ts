/**
 * Dev helper: set a known password on a local account.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `AuthService.login` had its credential check commented out for a period, which meant any
 * password signed into any account. That was convenient for local work — you never needed to
 * know a fixture's password — and it was restored on 2026-08-21 because it is an authentication
 * bypass and this codebase is heading for production.
 *
 * Restoring it stranded the handful of local accounts whose passwords nobody recorded. The
 * seeded ones are fine (`seed-cod-shipments.ts` uses `CodShip123!`, `seed-tickets.ts` uses
 * `Password123!`); this is for the rest.
 *
 * ── It refuses to run outside development, and that is the point ─────────────
 *
 * A script that rewrites a password hash by identifier is an account-takeover tool with a
 * friendly name. It checks `NODE_ENV` and the connection string, and refuses both a production
 * environment and a non-local host — the same fail-closed reasoning `config/env.ts` applies,
 * and the reason the login bypass was NOT re-introduced as an environment flag: a switch whose
 * failure direction is "open" is the wrong shape, so this one fails closed twice.
 *
 * It is NOT registered in `scripts/migrate.ts` and must never be: it is a developer
 * convenience, not a migration, and the ledger is for changes that belong in every environment.
 *
 * Run:
 *   npx ts-node scripts/dev-set-password.ts --identifier +237677000001 --password 'Local123!'
 *   npx ts-node scripts/dev-set-password.ts --all-unknown --password 'Local123!'   (dry-run first)
 *   …add --dry-run to see what would change.
 */
import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

/** Local only. Both checks, because either one alone is a check somebody can be one typo from. */
function assertDevelopment(): void {
    const environment = process.env.NODE_ENV ?? 'development';
    if (environment === 'production') {
        throw new Error('refusing to run with NODE_ENV=production — this rewrites a credential');
    }
    if (!/(localhost|127\.0\.0\.1)/.test(MONGO_URI)) {
        throw new Error(`refusing to run against a non-local database: ${MONGO_URI.replace(/\/\/.*@/, '//<redacted>@')}`);
    }
}

async function main(): Promise<void> {
    assertDevelopment();

    const password = arg('password');
    const identifier = arg('identifier');
    const allUnknown = process.argv.includes('--all-unknown');

    if (!password) throw new Error('--password is required');
    if (!identifier && !allUnknown) throw new Error('pass --identifier <email|phone> or --all-unknown');

    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    if (!db) throw new Error('no database handle after connect');
    const users = db.collection('users');

    /**
     * `--all-unknown` targets the accounts NOT created by a seed that documented its password.
     * Matched on the seed's e-mail domain rather than on a list of ids, so it keeps working as
     * seeds are re-run and rows get new ids.
     */
    const filter = allUnknown
        ? { login_email: { $not: /jovitest\.cm$/ } }
        : { $or: [{ login_email: identifier?.toLowerCase() }, { login_phone: identifier }] };

    const rows = await users.find(filter, { projection: { login_email: 1, login_phone: 1, roles: 1 } }).toArray();

    if (rows.length === 0) {
        console.log('\nNo account matched. Nothing to do.');
        await mongoose.disconnect();
        return;
    }

    console.log(`\n${rows.length} account(s) matched:\n`);
    for (const row of rows) {
        console.log(`  ${row.login_email ?? row.login_phone ?? '(no identifier)'}  roles=[${(row.roles ?? []).join(', ')}]`);
    }

    if (DRY_RUN) {
        console.log('\nDRY RUN — nothing written. Re-run without --dry-run to apply.');
        await mongoose.disconnect();
        return;
    }

    /**
     * `password_changed_at` is stamped with the hash, never after it.
     *
     * `rotateRefreshToken` refuses a refresh token minted before this instant
     * (`isTokenPredatingPasswordChange`), which is what makes a password change a revocation
     * rather than a gesture. A hash that lands without its stamp is the whole defect: the new
     * password is live and every session issued under the old one still works.
     */
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await users.updateMany(
        { _id: { $in: rows.map((r) => r._id) } },
        { $set: { password_hash: passwordHash, password_changed_at: new Date() } },
    );

    console.log(`\nSet the password on ${result.modifiedCount} account(s).`);
    console.log('Existing sessions on those accounts are now refused at their next refresh.');

    await mongoose.disconnect();
}

main().catch((error) => {
    console.error('\nFailed:', error instanceof Error ? error.message : error);
    process.exit(1);
});
