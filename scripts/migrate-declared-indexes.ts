/**
 * Migration: build EVERY index the schemas declare and the database does not have.
 *
 * The catch-all. The twenty-two migrations before this one each build a named handful for a
 * reason somebody wrote down; this one closes the gap those twenty-two were never meant to
 * cover — the several hundred indexes that exist only because a schema declares them and
 * `autoIndex` used to create them.
 *
 * ── WHY THIS COULD NOT HAVE BEEN FOUND BEFORE THE FIRST PRODUCTION DEPLOY ─────
 * Development runs `autoIndex: true` (`lifecycle.ts`), so Mongoose builds every declared
 * index silently at boot and a developer never sees an absence. Production runs it OFF,
 * where nothing builds anything that is not a migration. The two environments therefore
 * disagree about which constraints exist, and they disagree SILENTLY — that is the whole
 * shape of the defect.
 *
 * The first deploy, 2026-09-13, measured it from `reportIndexDrift()`'s own boot log:
 *
 *     before `migrate:up`   389 declared indexes missing across 95 collections
 *     after all 22          350 still missing across 89
 *
 * So the ledgered twenty-two account for 39. The schemas declare ~396. The exit criterion
 * for this migration is the other end of that same line: a boot that logs
 * `index drift: none — every declared index exists`.
 *
 * ── 83 OF THEM ARE `unique`, WHICH MAKES THIS CORRECTNESS ────────────────────
 * ⚠ Measured by this script's own `--dry-run` against an empty database: 83 of the 396
 * declared indexes are unique. The figure is written here because the number first carried
 * into this work was "about twenty" — a partial list read as a count. Re-measure rather than
 * trusting this line; `--dry-run` prints it on every run.
 *
 * This is not a slow-query cleanup. The code upserts and pre-checks against constraints the
 * database is not enforcing, and every one of these is a guarantee somebody already believes
 * they have:
 *
 *   channel_connections {channel, external_id}   two accounts cannot claim one WhatsApp
 *                                                identity — `verify:connections` asserts
 *                                                this and says "the index enforces it"
 *   cash_collections {shipment_id}               one COD collection per shipment
 *   credit_wallets / earnings_accounts /         ONE WALLET PER OWNER. Money integrity.
 *     cod_cash_accounts / billing_settings
 *     {owner_type, owner_id}
 *   product_variants {sku}                       SKU uniqueness
 *   products {vendorId, slug}                    no storefront URL collisions
 *
 * ── `createIndex`, NEVER `syncIndexes()` ─────────────────────────────────────
 * ⚠ The obvious one-liner for "make the database match the schemas" is `syncIndexes()`, and
 * it is WRONG here: it DROPS every index the schema does not declare. That is precisely the
 * 39 the twenty-two migrations just built — `product_storefront_browse`,
 * `payment_merchant_ref`, the TTL on `admin_action_log` — each of which is declared in a
 * migration rather than in a schema. A `syncIndexes()` here would delete the work of every
 * migration that ran before it, on the same run, and report success.
 *
 * This script creates and never drops. Nothing it does is destructive.
 *
 * ── It builds only what is MISSING, and that ordering is load-bearing ────────
 * The plan is a `diffIndexes()` of declared-against-live, the SAME comparison
 * `reportIndexDrift()` makes at boot and `GET /system/database` serves — imported, not
 * reimplemented, so the boot log reads "no drift" after this runs rather than disagreeing
 * with it over some normalisation detail (the `$text` sentinel being the one that bites).
 *
 * Building only the missing ones is also what keeps this clear of the twenty-two. Where a
 * schema declares the same KEY a migration already built under a chosen NAME, MongoDB
 * refuses a second index on that key (`IndexOptionsConflict`, code 85). Skipping anything
 * already live means that collision never arises — which is why this migration is LAST in
 * the registry, after the named builds, and would be wrong first.
 *
 * ── What it deliberately does NOT fix: `mismatched` ──────────────────────────
 * An index that exists on the right key with the WRONG options — live non-unique where the
 * schema declares unique — is the most dangerous state in the whole diff, and this migration
 * cannot repair it: changing an index's options means dropping and recreating it, which is
 * destructive and belongs in a window somebody chose. Those are listed, loudly, and left
 * alone. A create-only migration that silently skipped them would read as "all clear".
 *
 * ── Cheapest at zero rows ────────────────────────────────────────────────────
 * ⚠ An empty collection indexes instantly. A populated one takes minutes to hours, loads the
 * primary, and a unique build fails outright on data that already holds duplicates. Run this
 * BEFORE real traffic. On a fresh production database it is close to free, which is the only
 * reason ~350 index builds in one migration is a reasonable thing to do at all.
 *
 * Idempotent: a second run finds nothing missing and exits having issued no write. Reads and
 * writes no document — it stays inside the pre-production "index migrations only" rule (D-5).
 *
 * Run:  npx ts-node scripts/migrate-declared-indexes.ts [--dry-run] [--only <collection>]
 *       (npm run migrate:declared-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import { readdirSync, statSync } from 'fs';
import mongoose from 'mongoose';
import { MODELS } from '../src/core/database/collections';
import {
    NormalisedIndex,
    diffIndexes,
    indexIdentity,
    normaliseIndex,
} from '../src/modules/system/domain/index-diff';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const onlyFlag = process.argv.indexOf('--only');
const ONLY: string | null = onlyFlag > -1 ? (process.argv[onlyFlag + 1] ?? null) : null;

/**
 * Models named in the registry that deliberately have NO compiled schema.
 *
 * `SystemLog` is the capped log collection. `core/logging/mongo-sink.ts` reaches it through
 * the raw driver precisely so that no Mongoose index build can create it UNCAPPED first — a
 * collection that cannot be converted afterwards. This script iterates registered models, so
 * it never touches that collection; the entry exists so the completeness assert below can
 * tell "deliberately absent" from "the glob missed a file".
 */
const MODELS_WITHOUT_A_SCHEMA = new Set<string>(['SystemLog']);

// ─────────────────────────────────────────────────────────────────────────────
//  Loading every model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Import every `*.model.ts` under `src/`, so Mongoose has registered all of them.
 *
 * ⚠ THE TRAP THIS AVOIDS. `mongoose.modelNames()` only sees models whose module was
 * imported — which is why `inspectDatabase`'s own notes say a model nobody imported "reads
 * as neither declared nor drifted". Importing `app.ts` and relying on the route graph to
 * pull the models in is NOT complete: a model reached only from a worker, a subscriber or a
 * script is absent from it, and every index on that collection would be skipped by a run
 * that then reported success.
 *
 * DISCOVERED, not declared — the opposite of `MIGRATIONS` in the runner, and deliberately. A
 * hand-written list of models to index is a list somebody forgets to add to, and a forgotten
 * entry is an index that silently does not exist: the exact defect this migration closes,
 * arriving again by a different door. The glob cannot forget.
 *
 * Anchored at `src/` rather than the repo root so it never walks `dist/` — the toolbox image
 * carries both trees, and requiring the compiled copy of a model registers it twice
 * (`OverwriteModelError`).
 */
function everyModelFile(): string[] {
    const root = path.resolve(__dirname, '..', 'src');
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = path.join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith('.model.ts')) found.push(full);
        }
    };

    walk(root);
    return found.sort();
}

/**
 * Load them, and REFUSE TO CONTINUE if any one fails to import.
 *
 * A model whose module throws is a model Mongoose never registers, which is a collection
 * this migration silently skips — and a silently skipped collection is indistinguishable
 * from a healthy one in every report we have. Better to fail loudly and have somebody fix
 * the import than to build 340 indexes, exit 0, and leave 16 absent under a green ledger row.
 */
function loadEveryModel(): number {
    const files = everyModelFile();
    const failures: Array<{ file: string; message: string }> = [];

    for (const file of files) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require(file);
        } catch (error) {
            failures.push({
                file: path.relative(path.resolve(__dirname, '..'), file),
                message: (error as Error).message.split('\n')[0],
            });
        }
    }

    if (failures.length > 0) {
        for (const failure of failures) console.error(`  ✖ ${failure.file}\n      ${failure.message}`);
        throw new Error(
            `${failures.length} model module(s) could not be imported. Every one of them is a `
            + 'collection this migration would silently skip — fix the imports and re-run.',
        );
    }

    return files.length;
}

/**
 * Every model the registry names must actually be registered, BEFORE any work starts.
 *
 * The second half of the same guard, and the one that makes under-import loud. The glob
 * proves the files it FOUND imported cleanly; this proves it found them all, by checking
 * against the one independent list of what should exist. A model moved to a filename that
 * does not end `.model.ts` passes the first check and fails this one.
 *
 * Run before the connection is even opened: an under-import is a code fault, and there is no
 * reason to discover it half way through creating indexes on a production primary.
 */
function assertEveryRegistryModelIsRegistered(): void {
    const registered = new Set(mongoose.modelNames());
    const absent = (Object.values(MODELS) as string[])
        .filter((name) => !registered.has(name) && !MODELS_WITHOUT_A_SCHEMA.has(name));

    if (absent.length > 0) {
        throw new Error(
            'these models are named in core/database/collections.ts but were NOT registered by the '
            + `glob over src/**/*.model.ts: ${absent.join(', ')}.\n`
            + '  Either the file no longer ends in `.model.ts`, or the model is genuinely schema-less '
            + 'and belongs in MODELS_WITHOUT_A_SCHEMA with the reason written down. Refusing to run: '
            + 'every one of these is a collection whose indexes would be silently skipped.',
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The plan
// ─────────────────────────────────────────────────────────────────────────────

interface PlannedIndex {
    collection: string;
    /** The key exactly as the schema declares it — what is passed to `createIndex`. */
    key: Record<string, unknown>;
    /** The options exactly as the schema declares them, less Mongoose's internal marker. */
    options: Record<string, unknown>;
    /** For the log: the properties worth seeing at a glance. */
    flags: string;
}

interface CollectionPlan {
    collection: string;
    model: string;
    declared: number;
    live: number;
    build: PlannedIndex[];
    mismatched: Array<{ key: Record<string, number | string>; declared: NormalisedIndex; live: NormalisedIndex }>;
    unreadable: string | null;
}

/**
 * The properties worth seeing at a glance on a planned build.
 *
 * The partial filter is printed in FULL rather than as a bare `partial`, because two indexes
 * on one key are distinguished by nothing else: `subscriber_plans` declares
 * `{owner_type, owner_id}` twice, and with the filter elided the two lines of the plan render
 * identically — which reads as this script having queued the same index twice.
 */
function flagsOf(options: Record<string, unknown>): string {
    const flags: string[] = [];
    if (options.unique === true) flags.push('UNIQUE');
    if (typeof options.expireAfterSeconds === 'number') flags.push(`ttl=${options.expireAfterSeconds}s`);
    if (options.partialFilterExpression) flags.push(`partial=${JSON.stringify(options.partialFilterExpression)}`);
    if (options.sparse === true) flags.push('sparse');
    if (options.collation) flags.push('collation');
    if (typeof options.name === 'string') flags.push(`name=${options.name}`);
    return flags.length > 0 ? `  [${flags.join(' ')}]` : '';
}

/**
 * What a model declares.
 *
 * `schema.indexes()` already merges field-level `index: true` / `unique: true` declarations
 * with explicit `schema.index(...)` calls, so it IS the whole declared set — the same list
 * Mongoose's own `autoIndex` builds from (`_ensureIndexes` in `lib/model.js` reads exactly
 * this). `_autoIndex` is Mongoose's marker for "this came from a field option"; MongoDB
 * rejects it as an unknown index option, and `_ensureIndexes` deletes it for that reason.
 */
function declaredFor(modelName: string): Array<{ key: Record<string, unknown>; options: Record<string, unknown> }> {
    return mongoose.model(modelName).schema.indexes().map(([key, options]) => {
        const cleaned = { ...(options as Record<string, unknown>) };
        delete cleaned._autoIndex;
        return { key: key as Record<string, unknown>, options: cleaned };
    });
}

async function liveFor(collectionName: string): Promise<NormalisedIndex[]> {
    const raw = await mongoose.connection.db!.collection(collectionName).listIndexes().toArray();
    return raw.map((index) => normaliseIndex(index.key as Record<string, unknown>, index as Record<string, unknown>));
}

async function buildPlan(): Promise<CollectionPlan[]> {
    const plans: CollectionPlan[] = [];

    for (const modelName of [...mongoose.modelNames()].sort()) {
        const collection = mongoose.model(modelName).collection.collectionName;
        if (ONLY && collection !== ONLY) continue;

        const declaredRaw = declaredFor(modelName);
        const declaredNorm = declaredRaw.map((declaration) => normaliseIndex(declaration.key, declaration.options));

        // The raw declaration, keyed by the identity `diffIndexes` will report it under, so a
        // `missing` verdict maps back to the spec that has to be built. `normaliseIndex`
        // canonicalises a `$text` key, hence the round trip rather than a direct lookup.
        const rawByIdentity = new Map<string, { key: Record<string, unknown>; options: Record<string, unknown> }>();
        declaredRaw.forEach((raw, i) => rawByIdentity.set(indexIdentity(declaredNorm[i]), raw));

        const plan: CollectionPlan = {
            collection,
            model: modelName,
            declared: declaredRaw.length,
            live: 0,
            build: [],
            mismatched: [],
            unreadable: null,
        };

        let live: NormalisedIndex[];
        try {
            live = await liveFor(collection);
        } catch (error) {
            const code = (error as { code?: number }).code;
            // 26 / "ns does not exist": the collection has never been written to. That is the
            // normal state for most of them on a fresh database and means no indexes rather than
            // an error — `createIndex` creates the collection on the way past.
            if (code === 26 || /ns does not exist|not found/i.test((error as Error).message)) {
                live = [];
            } else {
                plan.unreadable = (error as Error).message;
                plans.push(plan);
                continue;
            }
        }

        plan.live = live.length;
        const drift = diffIndexes(declaredNorm, live);
        plan.mismatched = drift.mismatched;

        for (const missing of drift.missing) {
            const identity = indexIdentity(missing);
            // MongoDB creates `_id_` itself and refuses to have it redefined. A schema that
            // declared it would otherwise report as permanently missing and fail on every run.
            if (identity === '_id:1') continue;

            const raw = rawByIdentity.get(identity);
            if (!raw) continue; // unreachable: every `missing` came from `declaredNorm`

            plan.build.push({
                collection,
                key: raw.key,
                options: raw.options,
                flags: flagsOf(raw.options),
            });
        }

        plans.push(plan);
    }

    return plans;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Applying
// ─────────────────────────────────────────────────────────────────────────────

interface Failure {
    collection: string;
    key: string;
    code: number | null;
    diagnosis: string;
    message: string;
}

/**
 * Turn a driver error into the sentence an operator can act on.
 *
 * The ones that actually happen here are worth naming, because the remedy for each is
 * completely different and the raw driver message says none of them.
 */
function diagnose(error: unknown): { code: number | null; diagnosis: string } {
    const code = (error as { code?: number }).code ?? null;
    const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;

    switch (code) {
        case 11000:
            return {
                code,
                diagnosis:
                    'THE DATA ALREADY HOLDS DUPLICATES, so this unique constraint cannot be built. '
                    + (keyValue ? `First collision: ${JSON.stringify(keyValue)}. ` : '')
                    + 'Resolve them, then re-run with --only <collection>. The guarantee is enforced '
                    + 'by NOTHING until this succeeds.',
            };
        case 85:
            return {
                code,
                diagnosis:
                    'An index on this key already exists under a DIFFERENT NAME or with different '
                    + 'options. Normally unreachable here — only missing indexes are built — so this '
                    + 'means the database changed under the run. Re-run; it re-diffs from scratch.',
            };
        case 86:
            return {
                code,
                diagnosis:
                    'An index of this NAME exists on a different key. Rename one of them by hand; '
                    + 'this script will not drop.',
            };
        case 13:
            return { code, diagnosis: 'The connected user is not authorised to create indexes on this database.' };
        default:
            return { code, diagnosis: 'Unclassified — read the driver message below.' };
    }
}

async function applyPlan(plans: CollectionPlan[]): Promise<Failure[]> {
    const failures: Failure[] = [];
    const total = plans.reduce((sum, plan) => sum + plan.build.length, 0);
    let done = 0;

    for (const plan of plans) {
        if (plan.build.length === 0) continue;
        console.log(`\n  ${plan.collection}`);

        for (const planned of plan.build) {
            done += 1;
            const label = JSON.stringify(planned.key);
            // Progress is printed per index rather than per collection: a build on a populated
            // collection runs for minutes, and a silent terminal is indistinguishable from a hang.
            process.stdout.write(`    [${String(done).padStart(3)}/${total}] ${label}${planned.flags} … `);
            try {
                await mongoose.connection.db!
                    .collection(planned.collection)
                    .createIndex(planned.key as never, planned.options as never);
                console.log('built');
            } catch (error) {
                const { code, diagnosis } = diagnose(error);
                console.log(`✖ FAILED (${code ?? 'no code'})`);
                // One failure must not abandon the other 349. A collection holding duplicates is
                // a data problem for one constraint, not a reason to leave every later index
                // unbuilt — and the ones that succeeded stay succeeded, because this is create-only.
                failures.push({
                    collection: planned.collection,
                    key: label,
                    code,
                    diagnosis,
                    message: (error as Error).message.split('\n')[0],
                });
            }
        }
    }

    return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Both guards run BEFORE the connection opens. Neither touches the database, and an
    // under-import is a code fault — there is no reason to find it half way through creating
    // indexes on a production primary.
    const fileCount = loadEveryModel();
    assertEveryRegistryModelIsRegistered();
    console.log(
        `Loaded ${fileCount} model module(s) from src/**/*.model.ts; `
        + `${mongoose.modelNames().length} model(s) registered; every model in the registry accounted for.`,
    );

    /**
     * ⚠ `autoIndex` AND `autoCreate` OFF, and this is not a tuning choice — without them this
     * script writes during its own `--dry-run`.
     *
     * Every model is registered by the time we connect, and on connect Mongoose runs
     * `Model.init()` for each one: `_createCollection()` then `_ensureIndexes()`. In
     * development `autoIndex` is on (`lifecycle.ts` keys it off NODE_ENV), so the connection
     * ALONE creates all 99 collections and starts building all ~396 indexes, in the
     * background, before this script has planned anything.
     *
     * Measured, not theorised: the first rehearsal of this migration against an empty scratch
     * database reported "23 live, 395 to build" and left 99 collections behind it. The 23 were
     * simply the builds Mongoose had finished by the time the plan read `listIndexes()`.
     *
     * Two things break without this, and the second is worse than the first. A `--dry-run`
     * that writes is a rehearsal nobody can trust. And a real run would diff against a moving
     * target — racing its own connection — so its report of what it built would be fiction.
     *
     * It also keeps the script behaving IDENTICALLY in development and production. Production
     * has `autoIndex` off, so this defect is invisible there; development is where a migration
     * gets rehearsed. Two environments quietly disagreeing about who creates indexes is the
     * exact shape of the defect this migration exists to close — it should not be reintroduced
     * by the tool that closes it.
     */
    await mongoose.connect(MONGO_URI, { autoIndex: false, autoCreate: false });
    console.log(`Connected to ${mongoose.connection.name}${DRY_RUN ? '  (DRY RUN — nothing will be built)' : ''}`);
    if (ONLY) console.log(`Restricted to collection "${ONLY}".`);

    const plans = await buildPlan();

    if (ONLY && plans.length === 0) {
        throw new Error(`--only ${ONLY}: no registered model uses that collection.`);
    }

    const declared = plans.reduce((sum, plan) => sum + plan.declared, 0);
    const live = plans.reduce((sum, plan) => sum + plan.live, 0);
    const toBuild = plans.reduce((sum, plan) => sum + plan.build.length, 0);
    const mismatched = plans.flatMap((plan) => plan.mismatched.map((row) => ({ collection: plan.collection, ...row })));
    const unreadable = plans.filter((plan) => plan.unreadable !== null);

    console.log(
        `\n${plans.length} collection(s): ${declared} declared index(es), ${live} live `
        + `(including each collection's automatic _id_), ${toBuild} to build.`,
    );

    // Reported BEFORE the build, and never repaired. Changing an index's options means
    // DROPPING it, which this migration does not do. Silence here would read as "all clear" on
    // the most dangerous state in the whole diff.
    if (mismatched.length > 0) {
        console.log(`\n⚠ ${mismatched.length} index(es) exist on the right key with the WRONG OPTIONS.`);
        console.log('  NOT REPAIRED — fixing one means DROPPING and recreating it. Decide deliberately:\n');
        for (const row of mismatched) {
            console.log(
                `    ${row.collection}  ${JSON.stringify(row.key)}\n`
                + `      declared: unique=${row.declared.unique} sparse=${row.declared.sparse} `
                + `ttl=${row.declared.expireAfterSeconds ?? '—'} partial=${row.declared.partialFilterExpression ?? '—'}\n`
                + `      live:     unique=${row.live.unique} sparse=${row.live.sparse} `
                + `ttl=${row.live.expireAfterSeconds ?? '—'} partial=${row.live.partialFilterExpression ?? '—'}`,
            );
        }
    }

    if (unreadable.length > 0) {
        console.log(`\n⚠ ${unreadable.length} collection(s) could not be read, so nothing was planned for them:`);
        for (const plan of unreadable) console.log(`    ${plan.collection}: ${plan.unreadable}`);
    }

    if (toBuild === 0) {
        console.log('\nNothing to build — every declared index already exists.');
        await mongoose.disconnect();
        // A `mismatched` finding is a report, not this migration's own failure: it cannot fix
        // one, so exiting non-zero on it would make this script permanently un-greenable by
        // anything it is able to do. An unreadable collection IS its failure — it means the plan
        // was incomplete, and a green ledger row would claim otherwise.
        if (unreadable.length > 0) process.exitCode = 1;
        return;
    }

    const uniques = plans.flatMap((plan) => plan.build).filter((planned) => planned.options.unique === true);
    console.log(
        `\n${toBuild} index(es) to build, ${uniques.length} of them UNIQUE`
        + (uniques.length > 0 ? ' — a unique build FAILS on data that already holds duplicates.' : '.'),
    );

    if (DRY_RUN) {
        for (const plan of plans) {
            if (plan.build.length === 0) continue;
            console.log(`\n  ${plan.collection}  (${plan.build.length} of ${plan.declared} declared)`);
            for (const planned of plan.build) console.log(`    ${JSON.stringify(planned.key)}${planned.flags}`);
        }
        console.log('\nDRY RUN — nothing was built. Re-run without --dry-run to apply.');
        await mongoose.disconnect();
        return;
    }

    const started = Date.now();
    const failures = await applyPlan(plans);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    await mongoose.disconnect();

    // The summary is LAST on purpose: `scripts/migrate.ts` keeps the final twelve lines of a
    // failing migration as the ledger's `note`, so the diagnosis has to be the last thing said.
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`Built ${toBuild - failures.length} of ${toBuild} index(es) in ${seconds}s.`);

    if (failures.length === 0) {
        console.log('Every declared index now exists.');
        console.log('The next boot should log: index drift: none — every declared index exists');
        return;
    }

    console.log(`\n✖ ${failures.length} index(es) COULD NOT BE BUILT — each is a guarantee still enforced by nothing:\n`);
    for (const failure of failures) {
        console.log(`  ${failure.collection}  ${failure.key}`);
        console.log(`    ${failure.diagnosis}`);
        console.log(`    driver: ${failure.message}`);
    }
    process.exitCode = 1;
}

main().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
});
