import mongoose from 'mongoose';
import {
    REDIS_DB_CATALOG,
    peekRedisClient,
    redisClientSnapshot,
} from '../../../infra/redis/redis.factory';
import { SYSTEM_CONFIG } from '../config/system.config';

/**
 * Reading the state of this process's infrastructure connections.
 *
 * **Nothing here opens a connection.** Redis is inspected through `peekRedisClient`, which
 * returns an already-open client or null — see `infra/redis/redis.factory.ts` for why that
 * distinction exists at all. A probe observes; it does not provision.
 *
 * Every probe is time-boxed, and the endpoints that use these run them under
 * `Promise.allSettled`, so one hung dependency degrades its own row rather than hanging the
 * whole response.
 */

export type DependencyStatus = 'up' | 'down' | 'idle' | 'unknown';

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        work,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
}

const READY_STATES: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
};

export interface MongoProbe {
    status: DependencyStatus;
    readyState: string;
    database: string | null;
    host: string | null;
    latencyMs: number | null;
    error: string | null;
}

/**
 * `mongoose.connection.readyState` — read here for the first time anywhere in this repo.
 *
 * The readyState alone is not enough: it reports the driver's belief, which survives a network
 * partition for as long as the socket does. So a real `ping` runs beside it.
 */
export async function probeMongo(): Promise<MongoProbe> {
    const connection = mongoose.connection;
    const readyState = READY_STATES[connection.readyState] ?? `unknown(${connection.readyState})`;

    const base: MongoProbe = {
        status: 'unknown',
        readyState,
        database: connection.name ?? null,
        host: connection.host ? `${connection.host}:${connection.port ?? ''}` : null,
        latencyMs: null,
        error: null,
    };

    if (connection.readyState !== 1 || !connection.db) {
        return { ...base, status: 'down', error: `connection is ${readyState}` };
    }

    const startedAt = Date.now();
    try {
        await withTimeout(
            connection.db.admin().command({ ping: 1 }),
            SYSTEM_CONFIG.HEALTH_PROBE_TIMEOUT_MS,
            'mongo ping',
        );
        return { ...base, status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
        return {
            ...base,
            status: 'down',
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export interface MongoServerDetail {
    available: boolean;
    /** Why not, when unavailable. Managed tiers commonly refuse `serverStatus`. */
    reason: string | null;
    replicaSet: string | null;
    connections: { current: number; available: number; totalCreated: number } | null;
    maxPoolSize: number | null;
}

/**
 * Replica-set membership and connection-pool counters.
 *
 * ⚠ **`serverStatus` is refused on managed Mongo tiers** — an Atlas shared cluster grants no
 * `clusterMonitor` role, and the command comes back as an authorization error. That is a normal
 * deployment, not a fault, so it reports `{available: false, reason}` and never turns the
 * endpoint into a 500.
 *
 * `maxPoolSize` comes from the driver's own options and is therefore always available. Nothing
 * else is invented: a pool number Mongoose does not expose is reported as `null` with the reason
 * beside it, rather than guessed.
 */
export async function probeMongoServerDetail(): Promise<MongoServerDetail> {
    const connection = mongoose.connection;
    const maxPoolSize =
        (connection.getClient?.()?.options as { maxPoolSize?: number } | undefined)?.maxPoolSize ?? null;

    if (connection.readyState !== 1 || !connection.db) {
        return {
            available: false,
            reason: 'connection is not established',
            replicaSet: null,
            connections: null,
            maxPoolSize,
        };
    }

    try {
        const status = await withTimeout(
            connection.db.admin().command({ serverStatus: 1 }),
            SYSTEM_CONFIG.HEALTH_PROBE_TIMEOUT_MS,
            'mongo serverStatus',
        ) as {
            repl?: { setName?: string };
            connections?: { current?: number; available?: number; totalCreated?: number };
        };

        return {
            available: true,
            reason: null,
            replicaSet: status.repl?.setName ?? null,
            connections: status.connections
                ? {
                    current: status.connections.current ?? 0,
                    available: status.connections.available ?? 0,
                    totalCreated: status.connections.totalCreated ?? 0,
                }
                : null,
            maxPoolSize,
        };
    } catch (error) {
        return {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
            replicaSet: null,
            connections: null,
            maxPoolSize,
        };
    }
}

export interface RedisProbeEntry {
    db: number;
    constant: string;
    label: string;
    purpose: string;
    /**
     * `idle` is not a failure. It means this process has never needed that logical database —
     * which for most of them is the normal state on most instances. Reporting it as `down`
     * would make a healthy process look broken in seven places at once.
     */
    status: DependencyStatus;
    everOpened: boolean;
    latencyMs: number | null;
    connectionErrors: number;
    error: string | null;
}

/** Ping only what is already open. Never connects — see this file's header. */
export async function probeRedis(): Promise<RedisProbeEntry[]> {
    const snapshot = new Map(redisClientSnapshot().map((entry) => [entry.db, entry]));

    return Promise.all(
        REDIS_DB_CATALOG.map(async (spec): Promise<RedisProbeEntry> => {
            const state = snapshot.get(spec.db);
            const base = {
                db: spec.db,
                constant: spec.constant,
                label: spec.label,
                purpose: spec.purpose,
                everOpened: state?.everOpened ?? false,
                connectionErrors: state?.connectionErrors ?? 0,
                latencyMs: null,
                error: null,
            };

            const client = peekRedisClient(spec.db);
            if (!client) return { ...base, status: 'idle' };

            const startedAt = Date.now();
            try {
                await withTimeout(client.ping(), SYSTEM_CONFIG.HEALTH_PROBE_TIMEOUT_MS, `redis ping db${spec.db}`);
                return { ...base, status: 'up', latencyMs: Date.now() - startedAt };
            } catch (error) {
                return {
                    ...base,
                    status: 'down',
                    latencyMs: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }),
    );
}
