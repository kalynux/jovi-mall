import mongoose from 'mongoose';
import { COLLECTIONS } from '../database/collections';
import { loggingConfig } from './logging.config';
import { LogRecord, parseLogLine } from './log-record';
import { makeThrottledReporter, originalConsole, runInSink } from './sink-guard';

/**
 * Durable warn+ log persistence, into a CAPPED collection.
 *
 * ── Why capped rather than a TTL index ────────────────────────────────────────
 * In weight order:
 *  1. A capped collection has a **hard byte ceiling**. A TTL bounds by *age*, so an error
 *     storm inside the TTL window is unbounded — precisely the incident in which you least
 *     want the log collection filling the volume that holds `orders`.
 *  2. TTL deletion is a best-effort background thread on a 60-second cycle. Under load it
 *     falls behind, so the bound is soft exactly when it matters.
 *  3. TTL deletes are ordinary deletes — oplog entries, index churn, replication traffic —
 *     generated on the platform's error path. Capped eviction is an in-place overwrite.
 *  4. **Insertion order is time order**, so the read is a `$natural` reverse scan and needs no
 *     time index at all.
 *
 * **The cost, stated plainly:** a capped collection cannot be resized without dropping and
 * recreating it. `LOG_MONGO_CAP_BYTES` is a one-way door; treat a change to it as a migration.
 *
 * ── Why there is no Mongoose model ────────────────────────────────────────────
 * Mongoose's `capped:` schema option only applies when Mongoose itself creates the collection,
 * and `autoIndex` (on by default in this repo) will happily create it FIRST, uncapped, as a
 * side effect of building an index. The window is real: the model compiles at import, the
 * index build queues, and it fires the moment the connection opens — before any code here
 * runs. Since the collection cannot be converted afterwards, the failure would be permanent
 * and silent. The raw driver removes the race rather than sequencing around it.
 *
 * ── Why it never throws ───────────────────────────────────────────────────────
 * A logger that throws while logging an error is a disaster: it turns a diagnosable failure
 * into a second, undiagnosable one. Five layers below, and none of them propagates.
 */

type SinkState = 'disabled' | 'active' | 'cooling' | 'awaiting_connection';

interface CollectionFacts {
    capped: boolean | null;
    sizeBytes: number | null;
    configuredSizeBytes: number;
    verified: boolean;
    note: string | null;
}

class MongoLogSink {
    private enabled = false;
    private inflight = new Set<Promise<unknown>>();
    private failureStreak = 0;
    private coolingUntil = 0;

    private droppedWrites = 0;
    private failedWrites = 0;
    private lastErrorAt: string | null = null;
    private lastError: string | null = null;
    private written = 0;

    private facts: CollectionFacts = {
        capped: null, sizeBytes: null, configuredSizeBytes: 0, verified: false, note: null,
    };

    private report = makeThrottledReporter(60_000);

    /** The pino stream. Attached at logger construction and inert until `enable()` runs. */
    stream(): { write(line: string): void } {
        return {
            write: (line: string): void => {
                runInSink(() => this.accept(line));
            },
        };
    }

    private accept(line: string): void {
        if (!this.enabled) return;

        // Circuit breaker. A logger hammering a struggling Mongo during an incident IS part of
        // the incident.
        if (this.coolingUntil > Date.now()) {
            this.droppedWrites += 1;
            return;
        }

        // One comparison removes the whole class of "wrote during a reconnect".
        if (mongoose.connection.readyState !== 1) {
            this.droppedWrites += 1;
            return;
        }

        const config = loggingConfig();

        // Bounded in-flight, NOT an unbounded promise pile. Beyond the cap we drop and count —
        // queueing is what turns "Mongo is slow" into "the process ran out of memory".
        if (this.inflight.size >= config.MONGO_MAX_INFLIGHT) {
            this.droppedWrites += 1;
            return;
        }

        const record = parseLogLine(line, config.MAX_STACK_BYTES);
        if (record === null) return;

        this.insert(record);
    }

    private insert(record: LogRecord): void {
        const db = mongoose.connection.db;
        if (!db) {
            this.droppedWrites += 1;
            return;
        }

        /**
         * `writeConcern: { w: 0 }` — unacknowledged. The right trade for a log line: it takes
         * the sink off the request latency path entirely. The `.catch` stays anyway, because
         * `w:0` still rejects on client-side and serialization errors.
         */
        const promise = db
            .collection(COLLECTIONS.SYSTEM_LOG)
            .insertOne({ ...record, at: new Date(record.at) }, { writeConcern: { w: 0 } })
            .then(() => {
                this.written += 1;
                this.failureStreak = 0;
            })
            .catch((error: unknown) => {
                this.onFailure(error);
            })
            .finally(() => {
                this.inflight.delete(promise);
            });

        this.inflight.add(promise);
    }

    private onFailure(error: unknown): void {
        const config = loggingConfig();
        this.failedWrites += 1;
        this.failureStreak += 1;
        this.lastErrorAt = new Date().toISOString();
        this.lastError = error instanceof Error ? error.message : String(error);

        if (this.failureStreak >= config.SINK_FAILURE_STREAK) {
            this.coolingUntil = Date.now() + config.SINK_COOLDOWN_MS;
            this.failureStreak = 0;
        }

        // Throttled, and through the CAPTURED original console — never `console` (which may be
        // the bridge) and never the logger (which is what just failed).
        this.report(`[log-sink] persistence failing: ${this.lastError} (${this.failedWrites} total)`);
    }

    /**
     * Create-and-verify, then start accepting. Called after `mongoose.connect` resolves.
     *
     * Never throws and never attempts a conversion. If the collection already exists uncapped —
     * because an older deploy created it, or somebody restored a dump — we say so loudly, once,
     * and carry on writing. Refusing to log would be a worse answer than logging into a
     * collection that grows.
     */
    async enable(): Promise<void> {
        const config = loggingConfig();
        this.facts.configuredSizeBytes = config.MONGO_CAP_BYTES;

        if (!config.PERSIST_ENABLED) {
            this.facts.note = 'LOG_PERSIST_ENABLED is false — warn+ lines are kept in the ring buffer only.';
            return;
        }

        const db = mongoose.connection.db;
        if (!db) {
            this.facts.note = 'No Mongo connection was open when persistence was enabled.';
            return;
        }

        try {
            await db.createCollection(COLLECTIONS.SYSTEM_LOG, {
                capped: true,
                size: config.MONGO_CAP_BYTES,
                // `max` as well as `size`, so a pathological burst of tiny rows cannot hold a
                // million documents inside the byte ceiling.
                max: config.MONGO_CAP_MAX_DOCS,
            });
        } catch (error: unknown) {
            // 48 = NamespaceExists. Every other code is worth reporting but not fatal.
            const code = (error as { code?: number }).code;
            if (code !== 48) {
                originalConsole.error(
                    `[log-sink] could not create ${COLLECTIONS.SYSTEM_LOG}: ${(error as Error).message}`,
                );
            }
        }

        await this.verify(db);

        /**
         * Exactly ONE secondary index, and deliberately not on `at`.
         *
         * `_id` is indexed by default, natural order IS time order in a capped collection, and
         * the endpoint's query is a `$natural` reverse scan. `request_id` is the only filter
         * that is not a prefix of natural order, and it is the join an operator actually needs.
         * Every further index would be write amplification on the hottest write path here.
         */
        try {
            await db.collection(COLLECTIONS.SYSTEM_LOG).createIndex({ requestId: 1 }, { background: true });
        } catch (error: unknown) {
            originalConsole.error(`[log-sink] could not build requestId index: ${(error as Error).message}`);
        }

        this.enabled = true;
    }

    private async verify(db: NonNullable<typeof mongoose.connection.db>): Promise<void> {
        try {
            const stats = await db
                .collection(COLLECTIONS.SYSTEM_LOG)
                .aggregate([{ $collStats: { storageStats: {} } }])
                .toArray();

            const storage = (stats[0] as { storageStats?: { capped?: boolean; maxSize?: number; size?: number } })
                ?.storageStats;

            this.facts.capped = storage?.capped ?? null;
            this.facts.sizeBytes = storage?.maxSize ?? null;
            this.facts.verified = true;

            if (this.facts.capped === false) {
                this.facts.note =
                    'This collection exists and is NOT capped. It will grow without bound. '
                    + 'Converting requires dropping and recreating it — a deliberate migration, not a restart.';
                originalConsole.error(`[log-sink] ${this.facts.note}`);
            } else if (
                this.facts.capped === true
                && this.facts.sizeBytes !== null
                && this.facts.sizeBytes !== this.facts.configuredSizeBytes
            ) {
                this.facts.note =
                    `Capped at ${this.facts.sizeBytes} bytes, but LOG_MONGO_CAP_BYTES asks for `
                    + `${this.facts.configuredSizeBytes}. A capped collection cannot be resized in place; `
                    + 'the existing cap is what applies.';
                originalConsole.error(`[log-sink] ${this.facts.note}`);
            }
        } catch (error: unknown) {
            // `$collStats` needs no elevated role, but a managed tier may still refuse it —
            // report `verified: false` rather than inventing numbers, the same posture
            // `probeMongoServerDetail` already takes for `serverStatus`.
            this.facts.note = `Could not verify collection stats: ${(error as Error).message}`;
        }
    }

    /**
     * Best-effort flush of in-flight writes, for `SIGTERM`.
     *
     * **This is not a graceful-shutdown path** and must not be mistaken for one — the service
     * has none (see ADR-015's debts). It is the log subsystem taking responsibility for its own
     * buffer and nothing else.
     */
    async flush(): Promise<void> {
        if (this.inflight.size === 0) return;
        const budget = loggingConfig().SINK_FLUSH_BUDGET_MS;
        await Promise.race([
            Promise.allSettled([...this.inflight]),
            new Promise((resolve) => setTimeout(resolve, budget)),
        ]);
    }

    state(): SinkState {
        if (!this.enabled) {
            return loggingConfig().PERSIST_ENABLED ? 'awaiting_connection' : 'disabled';
        }
        if (this.coolingUntil > Date.now()) return 'cooling';
        if (mongoose.connection.readyState !== 1) return 'awaiting_connection';
        return 'active';
    }

    /** Cheap counters for the wire. No database round trip. */
    describe(): Record<string, unknown> {
        const config = loggingConfig();
        return {
            enabled: this.enabled,
            state: this.state(),
            levelFloor: config.PERSIST_LEVEL,
            collection: COLLECTIONS.SYSTEM_LOG,
            capped: this.facts.capped,
            sizeBytes: this.facts.sizeBytes,
            configuredSizeBytes: this.facts.configuredSizeBytes,
            verified: this.facts.verified,
            written: this.written,
            droppedWrites: this.droppedWrites,
            failedWrites: this.failedWrites,
            inflight: this.inflight.size,
            lastErrorAt: this.lastErrorAt,
            lastError: this.lastError,
            note: this.facts.note,
        };
    }

    /** Test-only. */
    __disableForTests(): void {
        this.enabled = false;
        this.coolingUntil = 0;
        this.failureStreak = 0;
    }
}

export const logMongoSink = new MongoLogSink();
