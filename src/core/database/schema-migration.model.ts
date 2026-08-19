import mongoose, { Schema } from 'mongoose';
import { COLLECTIONS, MODELS } from './collections';

/**
 * The migration ledger — one row per attempt to apply one migration.
 *
 * ── What this closes ──────────────────────────────────────────────────────────
 * Fifteen idempotent migration and backfill programs live under `scripts/`, each wired to
 * an `npm run` binding, each with a good header. Between them there was no record of what
 * had been applied anywhere. Project notes carried three as written-but-never-applied, two
 * of which had since become silent no-ops; the tree could neither confirm nor deny that,
 * which was the finding. Plan step 2.C.1.
 *
 * ── Semantics, copied from geo-tracker ────────────────────────────────────────
 * `internal/platform/postgres/migrate.go` is the house precedent and it is deliberately
 * minimal: **forward-only, no down migrations, one version table**. This is that, in
 * Mongo, with two additions the Go version does not need:
 *
 *   - `checksum` — sha256 of the script source. Go's migrations are embedded SQL files
 *     that are never edited after they ship; these fifteen are TypeScript programs
 *     somebody may still edit. Without the checksum the ledger answers "this migration
 *     ran", which is the wrong question. With it, it answers "*this version of* this
 *     migration ran", and an edit since the last run reports as `changed` rather than
 *     hiding inside `applied`.
 *   - `environment` — the same script legitimately runs against dev, staging and
 *     production, and "applied" is only ever true of one of them at a time.
 *
 * ── APPEND-ONLY, and why there is no unique key ───────────────────────────────
 * A failed attempt is worth as much as a successful one — more, during an incident — so a
 * run never overwrites its predecessor. Status is therefore "the newest row for this name
 * in this environment", not "the row". That also means the collection is the migration's
 * history: who ran it, how long it took, and how many times it was re-run after an edit.
 *
 * Deliberately NOT a unique index on `(name, environment)`: a uniqueness claim here would
 * force the runner to either upsert (destroying the history) or fail the second run of an
 * idempotent script (which is the normal case, not an error).
 *
 * ── Nothing in `src/` writes to this ──────────────────────────────────────────
 * The only writer is `scripts/migrate.ts`. The model lives here rather than beside it
 * because `COLLECTIONS` is the frozen registry the database inspector reads physical names
 * from, and a collection that exists on disk but not in that registry is invisible to
 * `GET /api/internal/admin/system/database` — which is exactly the endpoint an operator
 * would use to ask whether the ledger is there.
 */

/** Forward-only: there is no `rolled_back`. A mistake is corrected by a new migration. */
export type MigrationOutcome = 'success' | 'failed';

export interface ISchemaMigration extends mongoose.Document {
    /** The npm binding, e.g. `migrate:storefront-indexes`. The stable identity. */
    name: string;
    /** sha256 of the script source at the moment it ran. */
    checksum: string;
    /** `NODE_ENV` at the time of the run. `applied` is always relative to one of these. */
    environment: string;
    appliedAt: Date;
    /** `user@host`, best-effort. A ledger nobody can attribute is half a ledger. */
    appliedBy: string;
    durationMs: number;
    outcome: MigrationOutcome;
    /** The child's exit code. Non-null only when it actually exited. */
    exitCode: number | null;
    /** Last few lines of the child's output on failure — enough to recognise it later. */
    note: string | null;
}

const SchemaMigrationSchema = new Schema<ISchemaMigration>(
    {
        name: { type: String, required: true },
        checksum: { type: String, required: true },
        environment: { type: String, required: true },
        appliedAt: { type: Date, required: true, default: Date.now },
        appliedBy: { type: String, required: true },
        durationMs: { type: Number, required: true },
        outcome: { type: String, enum: ['success', 'failed'], required: true },
        exitCode: { type: Number, default: null },
        note: { type: String, default: null },
    },
    { versionKey: false }
);

/**
 * The only read the runner performs: newest-first within one name and environment.
 *
 * No TTL. This collection is the answer to "when did the schema last change here", and a
 * retention policy on it would silently delete that answer — the collection is fifteen
 * rows plus one per re-run, so it costs nothing to keep forever.
 */
SchemaMigrationSchema.index({ name: 1, environment: 1, appliedAt: -1 });

export const SchemaMigrationModel = mongoose.model<ISchemaMigration>(
    MODELS.SCHEMA_MIGRATION,
    SchemaMigrationSchema,
    COLLECTIONS.SCHEMA_MIGRATION
);

/** Status of one migration, resolved from its rows. Pure — see `resolveMigrationStatus`. */
export type MigrationStatus =
    /** No successful row in this environment. */
    | 'not_applied'
    /** The newest successful row carries the checksum the file has now. */
    | 'applied'
    /** It ran, but the file has been EDITED since. The current version has never run. */
    | 'changed'
    /** The newest attempt failed and no later success replaced it. */
    | 'failed';

export interface LedgerRow {
    checksum: string;
    appliedAt: Date;
    outcome: MigrationOutcome;
}

/**
 * Resolve a migration's status from its ledger rows and the checksum of the file on disk.
 *
 * Extracted off the I/O path and exported so `test:system` can drive it from literals —
 * the four states are the whole point of the ledger and each one has been wrong somewhere
 * before:
 *
 *   - `changed` is the state the checksum exists for. Reporting an edited migration as
 *     `applied` is the failure this whole part was written to prevent.
 *   - `failed` must NOT read as `not_applied`, because the two want the same action from
 *     `migrate:up` but very different attention from a person.
 *
 * @param rows every row for this (name, environment), in any order.
 */
export function resolveMigrationStatus(rows: LedgerRow[], currentChecksum: string): MigrationStatus {
    if (rows.length === 0) return 'not_applied';

    const newestFirst = [...rows].sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime());
    const successes = newestFirst.filter((row) => row.outcome === 'success');

    // A success anywhere in the history beats a later failure for the purposes of "has the
    // CURRENT version run" — but only if the success carries the current checksum, which is
    // checked first. A failure after a matching success means somebody re-ran it and it
    // broke; that is `failed`, and it is the more urgent reading.
    if (successes.length === 0) return 'failed';
    if (newestFirst[0].outcome === 'failed' && newestFirst[0].checksum === currentChecksum) {
        return 'failed';
    }
    return successes[0].checksum === currentChecksum ? 'applied' : 'changed';
}

/** Everything `migrate:up` should act on. `applied` is the only state that is skipped. */
export function needsApplying(status: MigrationStatus): boolean {
    return status !== 'applied';
}
