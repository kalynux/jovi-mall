/**
 * Verify: the graceful shutdown, against a real boot.
 *
 * ── Why this needs its own script ─────────────────────────────────────────────
 * `test:system` asserts the drain's SHAPE by scanning source — the order of the calls, the
 * absence of a competing signal handler. It cannot assert the drain's BEHAVIOUR, and the
 * behaviour is the whole point: that an in-flight request completes rather than being
 * truncated, that the timers really stop, and that a second drain is refused rather than
 * closing connections the first one is still using.
 *
 * ── Why it is a script and not a signal test ──────────────────────────────────
 * **Windows cannot deliver a real `SIGTERM` to a child process.** Node maps
 * `child.kill('SIGTERM')` onto `TerminateProcess`, an uncatchable hard kill. A test that sent
 * a signal would prove nothing here and would pass for the wrong reason. So this calls the
 * exported `drain()` directly — which is exactly why `lifecycle.ts` exports it, and the same
 * argument `admin/scripts/test/verify-live.ts` makes about wi-admin's.
 *
 * The signal path itself is covered on Linux by `docker compose kill -s SIGTERM` once Part 2.B
 * lands. What is asserted here is everything downstream of the handler, which is all of it.
 *
 * NEEDS Mongo (a replica set, as every path here does). Redis optional — the worker-lock layer
 * fails open without it, which this exercises incidentally.
 *
 * Run: npm run verify:shutdown
 * See PRODUCTION-READINESS plan step 2.A.
 */
import 'dotenv/config';
import http from 'http';
import mongoose from 'mongoose';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { WORKER_INVENTORY } from '../../src/modules/dev-tools/worker-registry';

let passed = 0;
const failures: string[] = [];

function assert(label: string, condition: boolean): void {
    if (condition) {
        passed += 1;
        originalConsole.log(`  ✅ ${label}`);
    } else {
        failures.push(label);
        originalConsole.log(`  ❌ FAIL: ${label}`);
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}`);
}

/**
 * Its OWN port, not the service's.
 *
 * This boots a second full instance of jovi-mall, so running it while `npm run dev` is up —
 * which is the normal state of a developer's machine, and the only state this can be run on —
 * would fail with EADDRINUSE and prove nothing. Set `SHUTDOWN_VERIFY_PORT` to override.
 *
 * Assigned onto `process.env` BEFORE the dynamic import of `lifecycle`, which reads PORT at
 * module load. That ordering is why the import is dynamic.
 */
const PORT = Number(process.env.SHUTDOWN_VERIFY_PORT || 8922);
process.env.PORT = String(PORT);

/** A plain GET against the running listener, resolved with status + body. */
function get(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
    });
}

async function main(): Promise<void> {
    originalConsole.log('\n═══ verify:shutdown — the drain, against a real boot ═══');

    const lifecycle = await import('../../src/lifecycle');

    section('Boot');
    const server = await lifecycle.startServer();
    assert('the listener is bound and the handle is retained', server.listening);
    assert('keepAliveTimeout is set — Node defaults it to 0, which holds a drain open',
        server.keepAliveTimeout === 65_000);
    assert('headersTimeout EXCEEDS keepAliveTimeout, or Node drops valid requests',
        server.headersTimeout > server.keepAliveTimeout);

    const health = await get('/api/health');
    assert('GET /api/health answers 200 before the drain', health.status === 200);

    section('The workers really started');
    const scheduled = WORKER_INVENTORY.filter((e) => e.worker.scheduled);
    const disabled = WORKER_INVENTORY.filter((e) => !e.worker.enabled);
    originalConsole.log(`     ${scheduled.length} scheduled, ${disabled.length} disabled by config`);
    assert('every ENABLED worker reports scheduled: true after boot',
        WORKER_INVENTORY.every((e) => !e.worker.enabled || e.worker.scheduled));

    section('An in-flight request survives the drain');
    /**
     * The assertion that matters, and the one no source scan can make.
     *
     * `/api/health/ready` probes Mongo and Redis, so it is genuinely in flight for a few
     * milliseconds rather than answering from memory. The drain is started WITHOUT awaiting it,
     * while that request is open; a drain that severed connections would reject here.
     */
    const inFlight = get('/api/health/ready');
    const draining = lifecycle.drain('verify:shutdown');

    const [response, clean] = await Promise.all([
        inFlight.then(
            (r) => ({ ok: true as const, r }),
            (e: Error) => ({ ok: false as const, e }),
        ),
        draining,
    ]);

    assert('the in-flight request COMPLETED rather than being truncated', response.ok);
    if (response.ok) {
        assert('and it carries a real body, not a severed one',
            response.r.body.includes('"service":"jovi-mall"'));
    } else {
        originalConsole.log(`     truncated with: ${response.e.message}`);
    }
    assert('drain() reported a clean shutdown', clean === true);

    section('After the drain');
    assert('the listener stopped accepting connections', !server.listening);

    assert('every worker reports scheduled: false — the timers are gone',
        WORKER_INVENTORY.every((e) => !e.worker.scheduled));

    assert('Mongo is disconnected (readyState 0)', mongoose.connection.readyState === 0);

    const refused = await get('/api/health').then(() => false, () => true);
    assert('a NEW request is refused — the port is released', refused);

    section('A second drain is refused, not run twice');
    /**
     * An impatient operator's second Ctrl-C must not start a parallel sequence that closes
     * connections the first one is still using. `drain()` returns false rather than throwing.
     */
    const second = await lifecycle.drain('verify:shutdown-again');
    assert('the second drain returns false rather than re-closing everything', second === false);

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failures.length} failed`);
    originalConsole.log(`${'═'.repeat(76)}\n`);
    if (failures.length > 0) {
        failures.forEach((f) => originalConsole.log(`  ✗ ${f}`));
        process.exit(1);
    }
    process.exit(0);
}

main().catch((error) => {
    originalConsole.error('verify:shutdown crashed:', error);
    process.exit(1);
});
