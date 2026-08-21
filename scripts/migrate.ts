#!/usr/bin/env ts-node

/**
 * The migration runner — plan step 2.C.2.
 *
 *   npm run migrate:status                                  what has run here, and from which version
 *   npm run migrate:up                                      apply everything unapplied, in order, ledgered
 *   npm run migrate:up -- --only migrate:storefront-indexes  one of them
 *   npm run migrate:up -- --dry-run                          rehearse everything; ledger nothing
 *
 * ── It SHELLS OUT, and that is the design, not a shortcut ─────────────────────
 * Each migration is a standalone program with its own `dotenv.config()`, its own
 * `mongoose.connect` and its own `process.exit`. Importing all of those into one process
 * is a rewrite of every one of them — and they are the part of this that already works.
 * So the runner spawns `npm run <binding>`, times it, and writes what happened to the
 * ledger. The migration under test is byte-identical to the migration that runs.
 *
 * The cost is one npm + ts-node startup per migration, which is seconds on a task that
 * happens at deploy time. The benefit is that this file cannot break a migration.
 *
 * ── ORDER IS DECLARED, not discovered ─────────────────────────────────────────
 * `MIGRATIONS` below is the order. Two rules produced it:
 *
 *   1. `migrate:agent-memberships` runs FIRST among the data migrations. It moves
 *      `DeliveryAgent.agency_id` into the membership collection, and the whole agent
 *      domain — contracts, deposits, COD — reads memberships. Anything that runs before
 *      it sees an agent with no agency.
 *   2. Index builds run LAST. Three of them claim UNIQUENESS
 *      (`migrate:payment-indexes`, `migrate:cod-late-deposit-index`), and a unique build
 *      fails outright against data that still holds duplicates. Letting the data
 *      migrations reach their final shape first turns "E11000, go and investigate" into a
 *      build that simply succeeds.
 *
 * ── The registry is CLOSED, and `status` proves it ────────────────────────────
 * `assertRegistryCovers()` diffs `MIGRATIONS` against every `migrate:*` / `backfill:*`
 * binding in `package.json` and fails on any difference. A migration added without a row
 * here would otherwise be a migration the ledger silently does not track — which is the
 * exact failure this whole part exists to end.
 *
 * ── Forward-only ──────────────────────────────────────────────────────────────
 * There is no `migrate:down`. Same as geo-tracker's `migrate.go`, and for the same reason:
 * a down migration for a backfill is a fiction (it cannot know which rows it wrote), and
 * every one of them is idempotent, so the correction for a bad migration is another
 * migration.
 */

import dotenv from 'dotenv';
dotenv.config();

import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { hostname, userInfo } from 'os';
import path from 'path';
import mongoose from 'mongoose';
import {
    SchemaMigrationModel,
    MigrationStatus,
    resolveMigrationStatus,
    needsApplying,
} from '../src/core/database/schema-migration.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const REPO_ROOT = path.resolve(__dirname, '..');

export interface Migration {
    /** The npm binding. The ledger's stable identity — renaming one starts a new history. */
    name: string;
    /** Relative to the repo root, so the checksum is of the file the binding actually runs. */
    file: string;
    /** Whether the script accepts `--dry-run`. All of them do, as of plan step 2.C.3. */
    dryRun: boolean;
    /** One line, for `status`. What is broken while this has not run. */
    note: string;
}

/**
 * The seventeen, in application order. See the ORDER note in the header.
 *
 * ⚠ One of them DROPS A COLLECTION (`migrate:drop-agent-invites`, added 2026-08-19). Every
 * other row here creates, backfills or re-indexes; that one destroys. It reads and prints
 * what it is about to drop first, which is what makes `--dry-run` worth using here.
 */
export const MIGRATIONS: Migration[] = [
    // ── Data: the agent domain, memberships first ────────────────────────────
    {
        name: 'migrate:agent-memberships',
        file: 'scripts/migrate-agent-memberships.ts',
        dryRun: true,
        note: 'legacy agents keep a dead agency_id and have no membership; the agent domain reads memberships',
    },
    {
        name: 'migrate:agent-deposits',
        file: 'scripts/migrate-agent-deposits.ts',
        dryRun: true,
        note: 'legacy deposits are invisible to any query filtering on status/recipient',
    },
    {
        name: 'migrate:contract-terms',
        file: 'scripts/migrate-contract-terms-negotiation.ts',
        dryRun: true,
        note: 'contracts have no terms_proposed_by, so nobody is authorised to approve terms',
    },
    {
        name: 'migrate:agent-vehicle-colors',
        file: 'scripts/migrate-agent-vehicle-colors.ts',
        dryRun: true,
        note: 'vehicle colours stay free text, so a dispatcher filter matches nothing',
    },

    // ── Data: billing, payments, catalog, booking ────────────────────────────
    {
        name: 'migrate:billing-owner-scope',
        file: 'scripts/migrate-billing-owner-scope.ts',
        dryRun: true,
        note: 'the owner-scope engine reads plans by owner_type; vendor_id rows are unreachable',
    },
    {
        name: 'migrate:customer-payment-methods',
        file: 'scripts/migrate-customer-payment-methods.ts',
        dryRun: true,
        note: 'saved cards stay in the embedded array, which is no longer read',
    },
    {
        name: 'migrate:booking-rule-timezones',
        file: 'scripts/migrate-booking-rule-timezones.ts',
        dryRun: true,
        note: "legacy 'UTC' rules do not inherit the vendor's zone — every affected vendor's day shifts",
    },
    {
        name: 'backfill:last-ordered',
        file: 'scripts/backfill-last-ordered-at.ts',
        dryRun: true,
        note: 'the file-cleanup inactivity clock falls back to createdAt for everything',
    },
    {
        name: 'backfill:pickup-locations',
        file: 'scripts/backfill-pickup-locations.ts',
        dryRun: true,
        note: 'physical products predating pickup_location get demoted to draft on their next edit',
    },
    {
        name: 'backfill:shipment-tracking-numbers',
        file: 'scripts/backfill-shipment-tracking-numbers.ts',
        dryRun: true,
        note: "legacy shipments carry null tracking numbers — the platform's public handle for them",
    },
    {
        name: 'backfill:actor-source',
        file: 'scripts/backfill-actor-source.ts',
        dryRun: true,
        note: 'eleven actor stamps are present on new rows and absent on old ones, so wi-admin reads undefined where mongoose would show "platform" (J6)',
    },
    // The only DESTRUCTIVE row. Last among the data migrations because it depends on none of
    // them and nothing depends on it — the collection is orphaned, so its position is free and
    // the safest free position is "after everything that reads data".
    {
        name: 'migrate:drop-agent-invites',
        file: 'scripts/migrate-drop-agent-invites.ts',
        dryRun: true,
        note: 'the deleted email-invite subsystem leaves a collection of pending invitations nothing will ever answer',
    },
    // Phase 5 Part E. Runs among the data migrations rather than at the end: nothing here
    // depends on it and it depends on nothing, but it SIGNS SOMEBODY OUT, so it belongs where
    // a `--dry-run` of the whole set will show it before the index builds start taking minutes.
    {
        name: 'migrate:retire-admin-role',
        file: 'scripts/migrate-retire-admin-role.ts',
        dryRun: true,
        note: "legacy users rows still carry roles:'admin' — inert in code since the cutover, but the rows a future regression would mint admin tokens from",
    },

    // ── Indexes, last: three of these claim uniqueness ───────────────────────
    {
        name: 'migrate:storefront-indexes',
        file: 'scripts/migrate-storefront-indexes.ts',
        dryRun: true,
        note: 'every public catalog request scans products',
    },
    {
        name: 'migrate:payment-indexes',
        file: 'scripts/migrate-payment-indexes.ts',
        dryRun: true,
        note: 'WEBHOOK DEDUP STOPS WORKING ENTIRELY — every gateway redelivery is reprocessed',
    },
    {
        name: 'migrate:admin-order-indexes',
        file: 'scripts/migrate-admin-order-indexes.ts',
        dryRun: true,
        note: 'two superseded single-field order indexes stay, costing writes and buying nothing',
    },
    {
        name: 'migrate:cod-late-deposit-index',
        file: 'scripts/migrate-cod-late-deposit-index.ts',
        dryRun: true,
        note: 'late-deposit uniqueness stays scoped to the agent, so a second agency cannot record one',
    },
    {
        name: 'migrate:admin-action-log',
        file: 'scripts/migrate-admin-action-log-indexes.ts',
        dryRun: true,
        note: 'admin_action_log has no TTL, so it grows without bound',
    },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Registry integrity
// ─────────────────────────────────────────────────────────────────────────────

/** The two bindings this file is itself wired to; they are the runner, not migrations. */
const RUNNER_BINDINGS = new Set(['migrate:status', 'migrate:up']);

/**
 * Fail if `MIGRATIONS` and `package.json` disagree.
 *
 * Both directions matter. A binding with no row is an untracked migration — the original
 * finding, re-created. A row with no binding is a `--only` target that cannot be invoked
 * and a checksum of a file nobody runs.
 */
export function assertRegistryCovers(): void {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
    };

    const bindings = Object.keys(pkg.scripts)
        .filter((key) => (key.startsWith('migrate:') || key.startsWith('backfill:')) && !RUNNER_BINDINGS.has(key))
        .sort();
    const registered = MIGRATIONS.map((m) => m.name).sort();

    const untracked = bindings.filter((b) => !registered.includes(b));
    const phantom = registered.filter((r) => !bindings.includes(r));
    const missingFiles = MIGRATIONS.filter((m) => !existsSync(path.join(REPO_ROOT, m.file)));
    const duplicated = registered.filter((name, i) => registered.indexOf(name) !== i);

    const problems: string[] = [];
    if (untracked.length > 0) {
        problems.push(
            `these npm bindings are migrations the ledger does not track: ${untracked.join(', ')}\n` +
            '  Add a row to MIGRATIONS in scripts/migrate.ts, in the position the order rules give it.'
        );
    }
    if (phantom.length > 0) {
        problems.push(`these MIGRATIONS rows have no npm binding: ${phantom.join(', ')}`);
    }
    if (duplicated.length > 0) {
        problems.push(`duplicated MIGRATIONS rows: ${[...new Set(duplicated)].join(', ')}`);
    }
    if (missingFiles.length > 0) {
        problems.push(`these MIGRATIONS rows point at files that do not exist: ${missingFiles.map((m) => m.file).join(', ')}`);
    }

    if (problems.length > 0) {
        throw new Error(`Migration registry is out of step with package.json:\n\n- ${problems.join('\n\n- ')}\n`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Checksums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sha256 of the script source, with line endings normalised.
 *
 * The normalisation is not cosmetic: this repository is developed on Windows and deployed
 * on Linux, and a checkout under `core.autocrlf=true` would otherwise produce a different
 * digest for a byte-identical migration — reporting every one of them as `changed`
 * on the first run in a container.
 */
function checksumOf(file: string): string {
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf-8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(source).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Status
// ─────────────────────────────────────────────────────────────────────────────

interface Resolved {
    migration: Migration;
    checksum: string;
    status: MigrationStatus;
    lastAppliedAt: Date | null;
    lastAppliedBy: string | null;
    lastDurationMs: number | null;
    attempts: number;
}

async function resolveAll(): Promise<Resolved[]> {
    const rows = await SchemaMigrationModel.find({ environment: ENVIRONMENT })
        .select('name checksum appliedAt appliedBy durationMs outcome')
        .lean()
        .exec();

    const byName = new Map<string, typeof rows>();
    for (const row of rows) {
        const list = byName.get(row.name) ?? [];
        list.push(row);
        byName.set(row.name, list);
    }

    return MIGRATIONS.map((migration) => {
        const mine = byName.get(migration.name) ?? [];
        const checksum = checksumOf(migration.file);
        const newest = [...mine].sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime())[0];
        return {
            migration,
            checksum,
            status: resolveMigrationStatus(mine, checksum),
            lastAppliedAt: newest?.appliedAt ?? null,
            lastAppliedBy: newest?.appliedBy ?? null,
            lastDurationMs: newest?.durationMs ?? null,
            attempts: mine.length,
        };
    });
}

const LABEL: Record<MigrationStatus, string> = {
    applied: '✔ applied',
    not_applied: '· not applied',
    changed: '⚠ applied-but-changed',
    failed: '✖ failed',
};

function printStatus(resolved: Resolved[]): void {
    const width = Math.max(...resolved.map((r) => r.migration.name.length));

    console.log(`\nLedger: ${mongoose.connection.name} · schema_migrations · environment "${ENVIRONMENT}"\n`);

    for (const row of resolved) {
        const when = row.lastAppliedAt
            ? `${row.lastAppliedAt.toISOString()} by ${row.lastAppliedBy} in ${row.lastDurationMs}ms`
            : '';
        console.log(
            `  ${row.migration.name.padEnd(width)}  ${LABEL[row.status].padEnd(22)}  ` +
            `${row.checksum.slice(0, 8)}  ${when}`
        );
        if (row.status === 'changed') {
            console.log(
                `  ${' '.repeat(width)}  ↳ the file has been EDITED since it last ran. ` +
                'The current version has never been applied here.'
            );
        }
        if (row.status !== 'applied') {
            console.log(`  ${' '.repeat(width)}  ↳ while unapplied: ${row.migration.note}`);
        }
    }

    const tally = (status: MigrationStatus): number => resolved.filter((r) => r.status === status).length;
    console.log(
        `\n  ${resolved.length} migration(s): ${tally('applied')} applied, ` +
        `${tally('not_applied')} not applied, ${tally('changed')} applied-but-changed, ${tally('failed')} failed\n`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Apply
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
    exitCode: number | null;
    durationMs: number;
    tail: string;
}

/** Keep the last N lines of a child's output, for the ledger's `note` on a failure. */
const TAIL_LINES = 12;

/**
 * Run one migration through its npm binding.
 *
 * Output is TEE'd rather than buffered: an index build on a large collection can run for
 * minutes and an operator watching a silent terminal has no way to tell it apart from a
 * hang. The tail is kept in parallel, so a failure still lands something recognisable in
 * the ledger.
 *
 * `shell: true` because this is developed on Windows, where `npm` is `npm.cmd` and
 * `spawn('npm', …)` without a shell fails with ENOENT.
 */
function runBinding(binding: string, extraArgs: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
        const started = Date.now();
        const args = ['run', binding, ...(extraArgs.length > 0 ? ['--', ...extraArgs] : [])];
        const child = spawn('npm', args, {
            cwd: REPO_ROOT,
            shell: true,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const tail: string[] = [];
        const capture = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
            const text = chunk.toString();
            sink.write(text);
            for (const line of text.split('\n')) {
                tail.push(line);
                if (tail.length > TAIL_LINES) tail.shift();
            }
        };

        child.stdout.on('data', (chunk: Buffer) => capture(chunk, process.stdout));
        child.stderr.on('data', (chunk: Buffer) => capture(chunk, process.stderr));

        const finish = (exitCode: number | null): void => {
            resolve({ exitCode, durationMs: Date.now() - started, tail: tail.join('\n').trim().slice(0, 2000) });
        };

        child.on('error', (error) => {
            process.stderr.write(`\n  spawn failed: ${error.message}\n`);
            finish(null);
        });
        child.on('close', (code) => finish(code));
    });
}

const APPLIED_BY = `${userInfo().username}@${hostname()}`;

async function applyAll(only: string | null, dryRun: boolean): Promise<number> {
    const resolved = await resolveAll();

    let queue = resolved.filter((r) => needsApplying(r.status));
    if (only) {
        const target = resolved.find((r) => r.migration.name === only);
        if (!target) {
            throw new Error(
                `--only ${only}: no such migration. Known names:\n  ${MIGRATIONS.map((m) => m.name).join('\n  ')}`
            );
        }
        // `--only` names one deliberately, so it runs even when the ledger says `applied` —
        // every migration here is idempotent, and refusing would make the flag useless for
        // the case it exists for (re-running one after fixing its data).
        queue = [target];
    }

    if (queue.length === 0) {
        console.log('\n  Nothing to apply — every migration is applied at its current checksum.\n');
        return 0;
    }

    console.log(
        `\n  ${queue.length} migration(s) to ${dryRun ? 'REHEARSE' : 'apply'}, in declared order:\n` +
        queue.map((r) => `    ${r.migration.name}  (${r.status})`).join('\n') +
        '\n'
    );

    if (dryRun) {
        console.log('  DRY RUN — every script runs with --dry-run and NOTHING is written to the ledger.');
        console.log('  A rehearsal is not an application, and recording it as one would be the lie this ledger exists to prevent.\n');
    }

    let failures = 0;

    for (const row of queue) {
        console.log(`\n${'─'.repeat(78)}\n▶ ${row.migration.name}  [${row.status}]\n${'─'.repeat(78)}`);

        if (dryRun && !row.migration.dryRun) {
            console.log('  SKIPPED — this script has no --dry-run. Run it for real or not at all.');
            continue;
        }

        const result = await runBinding(row.migration.name, dryRun ? ['--dry-run'] : []);
        const ok = result.exitCode === 0;

        if (!dryRun) {
            await SchemaMigrationModel.create({
                name: row.migration.name,
                checksum: row.checksum,
                environment: ENVIRONMENT,
                appliedAt: new Date(),
                appliedBy: APPLIED_BY,
                durationMs: result.durationMs,
                outcome: ok ? 'success' : 'failed',
                exitCode: result.exitCode,
                note: ok ? null : result.tail || null,
            });
        }

        console.log(
            `\n  ${ok ? '✔' : '✖'} ${row.migration.name} — exit ${result.exitCode ?? 'none'} in ${result.durationMs}ms` +
            `${dryRun ? ' (rehearsal, not ledgered)' : ' (ledgered)'}`
        );

        if (!ok) {
            failures += 1;
            // Stop. The order is declared because later migrations assume earlier ones ran;
            // carrying on past a failure applies a migration against a shape that is not the
            // one it was written for, which is how a bad deploy becomes a bad database.
            console.error(
                '\n  STOPPING. The remaining migrations are not attempted — the order is declared ' +
                'because later ones assume earlier ones ran.\n' +
                `  Fix the cause, then re-run: npm run migrate:up${only ? ` -- --only ${only}` : ''}\n`
            );
            break;
        }
    }

    return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Entry
// ─────────────────────────────────────────────────────────────────────────────

function usage(): void {
    console.log(`
  npm run migrate:status                                    what has run in this environment
  npm run migrate:up                                        apply everything unapplied, in order
  npm run migrate:up -- --only <name>                       apply exactly one, even if applied
  npm run migrate:up -- --dry-run                           rehearse; write nothing to the ledger

  Names:
${MIGRATIONS.map((m) => `    ${m.name}`).join('\n')}
`);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const command = argv.find((a) => !a.startsWith('--')) ?? 'status';

    if (command === 'help' || argv.includes('--help')) {
        usage();
        return;
    }
    if (command !== 'status' && command !== 'up') {
        throw new Error(`Unknown command "${command}". Expected "status" or "up".`);
    }

    const dryRun = argv.includes('--dry-run');
    const onlyIndex = argv.indexOf('--only');
    const only = onlyIndex >= 0 ? argv[onlyIndex + 1] ?? null : null;
    if (onlyIndex >= 0 && !only) {
        throw new Error('--only needs a migration name. Run `npm run migrate:status` for the list.');
    }

    // Before touching the database: the registry and package.json must agree. A status
    // report that silently omits a migration is worse than no report.
    assertRegistryCovers();

    // No `autoIndex: false` here, deliberately, even though `lifecycle.ts` now sets it in
    // production. The ledger's own index is the one thing that cannot be created by a
    // ledgered migration without circularity, and the collection is one row per migration
    // plus one per re-run — the build is instant and this process is the only writer.
    await mongoose.connect(MONGO_URI);

    try {
        if (command === 'status') {
            printStatus(await resolveAll());
            return;
        }

        const failures = await applyAll(only, dryRun);
        printStatus(await resolveAll());
        if (failures > 0) process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

/**
 * Run only when INVOKED, never when imported.
 *
 * `scripts/test/test-system.ts` imports `MIGRATIONS` and `assertRegistryCovers` so the
 * registry's closure is asserted by the suite rather than only by whoever happens to run
 * `migrate:status` next. Without this guard that import would APPLY EVERY MIGRATION as a
 * side effect of a DB-free unit test.
 */
if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
