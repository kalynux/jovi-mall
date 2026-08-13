import type { RedisClientType } from 'redis';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * The closed set of Redis commands the inspection surface may issue.
 *
 * ── Why an allowlist and not a code review ────────────────────────────────────
 * This is `route-group.ts`'s argument applied to Redis: *the allowlist IS the cap.* A "cache
 * inspection" endpoint is exactly one convenience away from `sendCommand(req.body.args)` — the
 * feature request writes itself ("just let me run `TTL` on an arbitrary key", then "just let me
 * run anything"). Routing every command through one helper converts "we did not write a
 * passthrough" into "a passthrough does not compile", which is the difference between a
 * convention and a control.
 *
 * The brief's last line — *do not create arbitrary server command execution* — is enforced here
 * and by the source scan in `test:system`, rather than being honoured by nobody having written
 * one yet.
 *
 * ── Every command here is READ-ONLY ───────────────────────────────────────────
 * No `DEL`, no `UNLINK`, no `SET`, no `EXPIRE`, no `FLUSHDB`, no `FLUSHALL`, and no `SELECT` —
 * the factory pins the database at client creation, so a `SELECT` bug cannot cross databases.
 * Deletion lives on `POST /dev-tools/cache/flush`, behind its own destructive permission, its
 * own `confirm` and its own dry run. Looking is not clearing.
 */
export const REDIS_READ_COMMANDS = Object.freeze([
    'scan',
    'type',
    'pttl',
    'ttl',
    'memoryUsage',
    'info',
] as const);

export type RedisReadCommand = (typeof REDIS_READ_COMMANDS)[number];

export function isRedisReadCommand(value: string): value is RedisReadCommand {
    return (REDIS_READ_COMMANDS as readonly string[]).includes(value);
}

/**
 * Issue one read-only command.
 *
 * The refusal is a 500 rather than a 4xx on purpose: a caller cannot choose the command — every
 * call site here passes a literal — so reaching it means the code is wrong, not the request.
 */
export async function runReadCommand(
    client: RedisClientType,
    command: RedisReadCommand,
    ...args: unknown[]
): Promise<unknown> {
    if (!isRedisReadCommand(command)) {
        throw createAppError(
            ERROR_CODES.SYSTEM_REDIS_COMMAND_REFUSED,
            500,
            `"${String(command)}" is not on the read-only Redis allowlist.`,
            { allowed: [...REDIS_READ_COMMANDS] },
        );
    }

    const fn = (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[command];
    if (typeof fn !== 'function') {
        throw createAppError(
            ERROR_CODES.SYSTEM_REDIS_COMMAND_REFUSED,
            500,
            `The Redis client exposes no "${command}".`,
        );
    }

    return fn.apply(client, args);
}
