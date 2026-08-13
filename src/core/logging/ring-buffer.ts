import { LogLevel, levelRank } from './logging.config';
import { LogRecord, recordBytes } from './log-record';

/**
 * The recent-lines buffer behind `GET /system/logs?source=ring`.
 *
 * A fixed array with a head index — never `Array.prototype.shift`/`splice`, which are O(n) and
 * would run on every line the process logs.
 *
 * ── Two bounds, not one ───────────────────────────────────────────────────────
 * A count alone is not a bound. 2000 entries of a 100 KB stack trace is 200 MB of retained heap
 * inside a process that is, by hypothesis, already having a bad day. `RING_MAX_BYTES` is the
 * bound that actually holds; the count is what makes the read predictable.
 *
 * ── `droppedSinceBoot` is not decoration ──────────────────────────────────────
 * Without it, "the ring is full and you are looking at the last ninety seconds" is
 * indistinguishable from "nothing has happened". It ships on the wire for the same reason
 * `executeFlush` reports `truncated`: silent truncation reads as completeness.
 *
 * ── PROCESS-LOCAL ─────────────────────────────────────────────────────────────
 * This describes the instance that answered the request, exactly like `describeWorkers()`'s
 * three booleans. `SCOPE_NOTE` travels with every response so an operator behind a load
 * balancer is not quietly misled.
 */

export const RING_SCOPE_NOTE =
    'These lines are PROCESS-LOCAL. With several instances behind a load balancer this is the buffer of the one that answered.';

export interface RingStats {
    capacity: number;
    maxBytes: number;
    stored: number;
    bytes: number;
    droppedSinceBoot: number;
    unparseableSinceBoot: number;
    oldestAt: string | null;
    newestAt: string | null;
    scopeNote: string;
}

export interface RingQuery {
    level?: LogLevel;
    since?: Date;
    until?: Date;
    requestId?: string;
    /** Applied as a literal, case-insensitive substring. Never a caller-supplied regex. */
    q?: string;
    limit: number;
}

export class LogRingBuffer {
    private readonly slots: Array<LogRecord | null>;
    private readonly sizes: number[];
    private head = 0;
    private stored = 0;
    private bytes = 0;
    private dropped = 0;
    private unparseable = 0;

    constructor(
        private readonly capacity: number,
        private readonly maxBytes: number,
    ) {
        const size = Math.max(1, capacity);
        this.slots = new Array<LogRecord | null>(size).fill(null);
        this.sizes = new Array<number>(size).fill(0);
    }

    noteUnparseable(): void {
        this.unparseable += 1;
    }

    push(record: LogRecord): void {
        const size = recordBytes(record);

        // Evict from the tail until this record fits both bounds. The count bound is handled by
        // the overwrite below; this loop exists for the byte budget, which one large record can
        // breach on its own.
        while (this.stored > 0 && this.bytes + size > this.maxBytes) {
            this.evictOldest();
        }

        const index = this.head;
        if (this.slots[index] !== null) {
            // Wrapped — the slot we are about to reuse still holds a live record.
            this.bytes -= this.sizes[index];
            this.stored -= 1;
            this.dropped += 1;
        }

        this.slots[index] = record;
        this.sizes[index] = size;
        this.bytes += size;
        this.stored += 1;
        this.head = (this.head + 1) % this.slots.length;
    }

    private evictOldest(): void {
        // Oldest lives at `head` once wrapped, otherwise at the first non-null slot behind it.
        const oldest = (this.head - this.stored + this.slots.length * 2) % this.slots.length;
        if (this.slots[oldest] === null) return;
        this.bytes -= this.sizes[oldest];
        this.slots[oldest] = null;
        this.sizes[oldest] = 0;
        this.stored -= 1;
        this.dropped += 1;
    }

    /** Newest first, which is the order an operator reads. */
    private *newestFirst(): Generator<LogRecord> {
        for (let step = 1; step <= this.slots.length; step += 1) {
            const index = (this.head - step + this.slots.length * 2) % this.slots.length;
            const record = this.slots[index];
            if (record !== null) yield record;
        }
    }

    query(filter: RingQuery): LogRecord[] {
        const floor = filter.level ? levelRank(filter.level) : 0;
        const needle = filter.q?.toLowerCase();
        const since = filter.since?.getTime();
        const until = filter.until?.getTime();

        const out: LogRecord[] = [];
        for (const record of this.newestFirst()) {
            if (out.length >= filter.limit) break;
            if (floor > 0 && levelRank(record.level) < floor) continue;

            if (since !== undefined || until !== undefined) {
                const at = Date.parse(record.at);
                if (since !== undefined && at < since) continue;
                if (until !== undefined && at >= until) continue;
            }

            if (filter.requestId && record.requestId !== filter.requestId) continue;
            if (needle && !record.msg.toLowerCase().includes(needle)) continue;

            out.push(record);
        }
        return out;
    }

    stats(): RingStats {
        let oldest: string | null = null;
        let newest: string | null = null;
        for (const record of this.newestFirst()) {
            if (newest === null) newest = record.at;
            oldest = record.at;
        }
        return {
            capacity: this.slots.length,
            maxBytes: this.maxBytes,
            stored: this.stored,
            bytes: this.bytes,
            droppedSinceBoot: this.dropped,
            unparseableSinceBoot: this.unparseable,
            oldestAt: oldest,
            newestAt: newest,
            scopeNote: RING_SCOPE_NOTE,
        };
    }

    /** Test-only. */
    clear(): void {
        this.slots.fill(null);
        this.sizes.fill(0);
        this.head = 0;
        this.stored = 0;
        this.bytes = 0;
        this.dropped = 0;
        this.unparseable = 0;
    }
}
