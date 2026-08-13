import mongoose from 'mongoose';
import { COLLECTIONS } from '../../../core/database/collections';
import { SYSTEM_CONFIG } from '../config/system.config';
import {
    IndexDrift,
    NormalisedIndex,
    diffIndexes,
    normaliseIndex,
} from '../domain/index-diff';

/**
 * `GET /api/internal/admin/system/database` — collection shape and index health.
 *
 * Two answers on one read, because an operator asking "is this collection healthy" wants both:
 * how big it is, and whether the indexes it is supposed to have actually exist.
 *
 * ── NOTHING HERE WRITES ───────────────────────────────────────────────────────
 * No `createIndex`, no `dropIndex`, no `collMod`. A "fix the drift" button has a real blast
 * radius — a unique index build fails outright on a collection that already holds duplicates,
 * and a large build on a primary is an availability event. Reporting the drift is the useful
 * 90%; repairing it is a decision with a maintenance window attached.
 *
 * ── Bounded, and it says what it did not reach ────────────────────────────────
 * 182 collections × 2 commands is real work on a primary. A wall-clock budget stops the sweep
 * and the response names the collections it never got to — the same bound-and-report shape
 * `executeFlush` uses, because silent truncation reads as completeness.
 */

export interface CollectionReport {
    name: string;
    model: string | null;
    stats: {
        available: boolean;
        reason: string | null;
        count: number | null;
        sizeBytes: number | null;
        storageSizeBytes: number | null;
        totalIndexSizeBytes: number | null;
        avgObjSizeBytes: number | null;
        indexCount: number | null;
        capped: boolean | null;
    };
    indexes: {
        available: boolean;
        reason: string | null;
        declared: number;
        live: number;
        drift: IndexDrift;
    };
}

export interface DatabaseInspectResult {
    database: string | null;
    collections: CollectionReport[];
    summary: {
        collections: number;
        declaredIndexes: number;
        liveIndexes: number;
        missing: number;
        extra: number;
        mismatched: number;
    };
    truncated: boolean;
    notReached: string[];
    notes: string[];
}

const NOTES = [
    'Index drift reflects the models THIS PROCESS registered. A model whose module was never '
    + 'imported at boot is invisible here, and reads as neither declared nor drifted.',
    'An index build still in progress reads as `missing`. Re-run before treating it as a fault.',
    '`missing` is the actionable bucket: autoIndex is on and a failed build fails SILENTLY at '
    + 'boot, so a declared index that is absent has already stopped protecting whatever it guarded.',
    'Nothing here writes. Building or dropping an index is a deliberate migration, not a button.',
];

/** Mongoose model name → physical collection name, for the models actually registered. */
function registeredModels(): Map<string, string> {
    const map = new Map<string, string>();
    for (const name of mongoose.modelNames()) {
        try {
            map.set(mongoose.model(name).collection.collectionName, name);
        } catch {
            // A model that cannot be resolved is simply not reported; this read must never be
            // the thing that throws.
        }
    }
    return map;
}

/**
 * What the schema declares.
 *
 * `schema.indexes()` covers `schema.index(...)` calls. Field-level `index: true` / `unique: true`
 * declarations are walked separately and merged — belt and braces, because a missed declaration
 * reads as "no drift", which is the wrong failure direction for this endpoint.
 */
function declaredIndexes(modelName: string): NormalisedIndex[] {
    const schema = mongoose.model(modelName).schema;
    const out: NormalisedIndex[] = [];

    for (const [key, options] of schema.indexes()) {
        out.push(normaliseIndex(key as Record<string, unknown>, options as Record<string, unknown>));
    }

    schema.eachPath((path, type) => {
        const options = (type as unknown as { options?: Record<string, unknown> }).options ?? {};
        if (options.index === true || options.unique === true || options.sparse === true) {
            const candidate = normaliseIndex({ [path]: 1 }, options);
            if (!out.some((existing) => JSON.stringify(existing.key) === JSON.stringify(candidate.key))) {
                out.push(candidate);
            }
        }
    });

    return out;
}

export async function inspectDatabase(requested: string[] | null): Promise<DatabaseInspectResult> {
    const db = mongoose.connection.db;
    const models = registeredModels();

    // Names come from the FROZEN registry, never from the request — see the validator, which
    // pins `?collection=` to this same list. A caller cannot name an arbitrary namespace.
    const all = Object.values(COLLECTIONS) as string[];
    const targets = requested && requested.length > 0 ? all.filter((n) => requested.includes(n)) : all;

    const result: DatabaseInspectResult = {
        database: mongoose.connection.name ?? null,
        collections: [],
        summary: {
            collections: 0, declaredIndexes: 0, liveIndexes: 0, missing: 0, extra: 0, mismatched: 0,
        },
        truncated: false,
        notReached: [],
        notes: NOTES,
    };

    if (!db) {
        result.notes = ['No Mongo connection is open in this process.', ...NOTES];
        result.notReached = targets;
        result.truncated = true;
        return result;
    }

    const deadline = Date.now() + SYSTEM_CONFIG.DB_INSPECT_BUDGET_MS;

    for (const name of targets) {
        if (Date.now() > deadline) {
            result.truncated = true;
            result.notReached.push(name);
            continue;
        }

        const modelName = models.get(name) ?? null;
        const report: CollectionReport = {
            name,
            model: modelName,
            stats: {
                available: false, reason: null, count: null, sizeBytes: null, storageSizeBytes: null,
                totalIndexSizeBytes: null, avgObjSizeBytes: null, indexCount: null, capped: null,
            },
            indexes: {
                available: false, reason: null, declared: 0, live: 0,
                drift: { missing: [], extra: [], mismatched: [] },
            },
        };

        /**
         * `$collStats`, because `collection.stats()` was removed in driver 6 (Mongoose 8 ships
         * it). Unlike `serverStatus` this needs no elevated role, but a managed tier may still
         * refuse it — so a refusal degrades this row with a reason rather than 500ing the
         * response or inventing a number. Same posture as `probeMongoServerDetail`.
         */
        try {
            const rows = await db.collection(name)
                .aggregate([{ $collStats: { storageStats: {} } }])
                .toArray();
            const s = (rows[0] as { storageStats?: Record<string, number | boolean> })?.storageStats;
            if (s) {
                report.stats = {
                    available: true,
                    reason: null,
                    count: Number(s.count ?? 0),
                    sizeBytes: Number(s.size ?? 0),
                    storageSizeBytes: Number(s.storageSize ?? 0),
                    totalIndexSizeBytes: Number(s.totalIndexSize ?? 0),
                    avgObjSizeBytes: Number(s.avgObjSize ?? 0),
                    indexCount: Number(s.nindexes ?? 0),
                    capped: Boolean(s.capped),
                };
            } else {
                report.stats.reason = '$collStats returned no storageStats for this collection.';
            }
        } catch (error) {
            report.stats.reason = (error as Error).message;
        }

        try {
            const liveRaw = await db.collection(name).listIndexes().toArray();
            const live = liveRaw.map((index) =>
                normaliseIndex(index.key as Record<string, unknown>, index as Record<string, unknown>));
            const declared = modelName ? declaredIndexes(modelName) : [];

            report.indexes = {
                available: true,
                reason: modelName ? null : 'No Mongoose model is registered for this collection, so nothing is declared to compare against.',
                declared: declared.length,
                live: live.length,
                drift: diffIndexes(declared, live),
            };
        } catch (error) {
            report.indexes.reason = (error as Error).message;
        }

        result.collections.push(report);
        result.summary.collections += 1;
        result.summary.declaredIndexes += report.indexes.declared;
        result.summary.liveIndexes += report.indexes.live;
        result.summary.missing += report.indexes.drift.missing.length;
        result.summary.extra += report.indexes.drift.extra.length;
        result.summary.mismatched += report.indexes.drift.mismatched.length;
    }

    return result;
}
