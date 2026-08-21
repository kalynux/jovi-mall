/**
 * Migration: retire the legacy `admin` platform role from `users`.
 *
 * Phase 5 Part E cut jovi-mall's admin surface over to wi-admin. Administrator identity now
 * lives in wi-admin's own database — an administrator holds **no `users` row here at all** and
 * reaches this service through `requireAdminCaller` with a service token, never through a
 * platform session. `AUTHENTICATABLE_ROLES` (`auth.schemas.ts`) has never included `'admin'`,
 * and as of step E.1 all five token-minting paths enforce it.
 *
 * What is left is DATA: rows in `users` whose `roles` array still contains `'admin'`.
 *
 * ── Why the rows matter even though the code refuses them ───────────────────
 *
 * They are not exploitable through `login`, `register`, `authMe` or `addRole` — all four
 * refused `'admin'` before this phase. The one path that did not was `rotateRefreshToken`,
 * which copies the role out of the presented token rather than re-reading `user.roles`, so a
 * refresh token minted before the cutover kept producing `role: 'admin'` access tokens for the
 * rest of its 30-day life. **Step E.1 closed that.** This migration is the other half: the code
 * fix stops new admin tokens being minted, and this stops the rows that a future regression
 * would mint them FROM.
 *
 * That pairing is the point. A guard is one line somebody can delete; a row that no longer
 * says `admin` cannot be re-authorised by deleting anything.
 *
 * ── Two outcomes, chosen per row ────────────────────────────────────────────
 *
 * Phase 5 step 0.2 says each row is "either suspended (`status`) or has its `admin` entry
 * pulled". Which one is right depends on what else the row carries, so this script decides per
 * document rather than applying one rule to all:
 *
 *   1. **`admin` alongside a real role** (vendor / agency / agent / customer) — PULL `admin`
 *      only. That person has a legitimate account on this platform and suspending it would
 *      lock a working vendor out of their store to solve a problem they are not part of.
 *
 *   2. **`admin` as the ONLY role** — pull it AND suspend the account. Pulling alone would
 *      leave `roles: []`, a shape nothing in this codebase produces or handles: `authMe` would
 *      answer `AUTH_ROLE_REQUIRED` (400) for a condition that is not the caller's fault, and
 *      the row would read to the next person opening the database as a half-deleted account
 *      rather than a retired one. Suspension is a state the whole system already understands —
 *      `rotateRefreshToken` refuses a non-active user before it reaches the role check at all,
 *      so such a row ends up with two independent locks on it.
 *
 * `suspended_reason` is written with the same actor-less provenance
 * `AdminUserService.setStatus` would write, minus an actor: nobody performed this suspension,
 * a migration did, and inventing a `suspended_by_user_id` would put a fabricated administrator
 * into a field that is read as a real one.
 *
 * ── Read before writing ─────────────────────────────────────────────────────
 *
 * The script prints every affected row and which of the two outcomes it will get BEFORE doing
 * anything, on a dry run and on a real one, so the deploy log records what changed rather than
 * only that something did. The dev database at the time of writing held exactly one row —
 * `cod-admin@jovitest.cm`, `roles: ['admin']`, `status: 'active'`, created by no script that
 * still exists in this repository (a `grep` for it across `src/`, `scripts/` and `api-doc/`
 * finds nothing). It takes outcome 2.
 *
 * ⚠ If the count where you run this is more than a handful, or any row carries a recent
 * `last_login_at`, STOP and find out who they are first. This migration is reversible in
 * principle (the role can be added back) but it signs somebody out, and doing that to a person
 * who is still using the account is worth one minute of checking.
 *
 * ── Idempotent ──────────────────────────────────────────────────────────────
 *
 * Matching on `roles: 'admin'` means a second run finds nothing and exits 0 having done
 * nothing. `migrate:up -- --only` deliberately re-runs an applied migration, so this matters.
 *
 * ── Forward-only ────────────────────────────────────────────────────────────
 *
 * There is no down migration in this repository (see `scripts/migrate.ts`). Re-granting the
 * role would not restore the capability anyway: `'admin'` is unauthenticatable in code, so a
 * row carrying it again would be inert data plus a suspended account.
 *
 * Run:  npx ts-node scripts/migrate-retire-admin-role.ts [--dry-run]
 *       (npm run migrate:retire-admin-role)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * The roles that survive. Deliberately spelled out here rather than imported from
 * `auth.schemas.ts`: a migration must keep doing what it did on the day it ran, and importing
 * a live constant would make a historical migration change meaning when that constant does.
 * The same reasoning `scripts/migrate.ts` applies to checksumming the file it runs.
 */
const REAL_ROLES = ['vendor', 'agency', 'agent', 'customer'];

const SUSPENSION_REASON =
    'Legacy administrator account retired at the wi-admin cutover. Administrator identity '
    + 'now lives in wi-admin; this row carried no other role.';

interface AffectedRow {
    _id: unknown;
    roles?: string[];
    status?: string;
    login_email?: string | null;
    login_phone?: string | null;
    last_login_at?: Date | null;
}

export async function retireAdminRole(): Promise<void> {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle after connect');

    const users = db.collection<AffectedRow>('users');
    const rows = await users
        .find({ roles: 'admin' }, { projection: { roles: 1, status: 1, login_email: 1, login_phone: 1, last_login_at: 1 } })
        .toArray();

    if (rows.length === 0) {
        console.log(`\nNothing to do — no user in ${mongoose.connection.name} carries the 'admin' role.`);
        await mongoose.disconnect();
        return;
    }

    // Read before writing, on both paths, so the deploy log names the rows.
    console.log(`\n${rows.length} user row(s) carry the legacy 'admin' role:\n`);
    const pullOnly: unknown[] = [];
    const pullAndSuspend: unknown[] = [];

    for (const row of rows) {
        const others = (row.roles ?? []).filter((role) => REAL_ROLES.includes(role));
        const outcome = others.length > 0 ? 'PULL admin (keeps a real account)' : 'PULL admin + SUSPEND (admin-only row)';
        (others.length > 0 ? pullOnly : pullAndSuspend).push(row._id);

        const who = row.login_email ?? row.login_phone ?? '(no login identifier)';
        const lastLogin = row.last_login_at instanceof Date ? row.last_login_at.toISOString() : 'never';
        console.log(`  ${String(row._id)}  ${who}`);
        console.log(`      roles=[${(row.roles ?? []).join(', ')}]  status=${row.status}  last_login=${lastLogin}`);
        console.log(`      → ${outcome}`);
    }

    console.log(`\n  pull only:        ${pullOnly.length}`);
    console.log(`  pull + suspend:   ${pullAndSuspend.length}`);

    if (DRY_RUN) {
        console.log('\nDRY RUN — nothing written. Re-run without --dry-run to apply.');
        await mongoose.disconnect();
        return;
    }

    // Two updates, in this order. The suspension is applied to the admin-only rows FIRST,
    // while they still carry the role that identifies them — doing it after the pull would
    // mean re-finding them by an id list, which is the same thing with a window in it.
    if (pullAndSuspend.length > 0) {
        const suspended = await users.updateMany(
            { _id: { $in: pullAndSuspend } as never },
            {
                $set: {
                    status: 'suspended',
                    suspended_at: new Date(),
                    suspended_reason: SUSPENSION_REASON,
                    // No actor. A migration performed this, not an administrator, and a
                    // fabricated id here would be read as a real one.
                    suspended_by_user_id: null,
                },
            },
        );
        console.log(`\nSuspended ${suspended.modifiedCount} admin-only account(s).`);
    }

    const pulled = await users.updateMany({ roles: 'admin' }, { $pull: { roles: 'admin' } as never });
    console.log(`Pulled the 'admin' role from ${pulled.modifiedCount} row(s).`);

    const remaining = await users.countDocuments({ roles: 'admin' });
    console.log(`\nRows still carrying 'admin': ${remaining} (expected 0).`);
    console.log("Administrator identity lives in wi-admin. `'admin'` stays in the Mongoose `UserRole`");
    console.log('enum deliberately — it describes what a legacy row MAY hold, which is now nothing.');

    await mongoose.disconnect();
}

/**
 * Run only when INVOKED, never when imported.
 *
 * `scripts/migrate.ts` imports the registry that names this file, and `test-system.ts` imports
 * `MIGRATIONS`. Without this guard, a DB-free unit test would suspend accounts as a side
 * effect of an import. Same guard and same reason as `migrate-drop-agent-invites.ts`.
 */
if (require.main === module) {
    retireAdminRole().catch((error) => {
        console.error('\nMigration failed:', error);
        process.exit(1);
    });
}
