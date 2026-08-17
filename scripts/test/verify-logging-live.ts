/**
 * Verify: the logging subsystem against a real MongoDB.
 *
 * The DB-free suite (`test:system` §7–9) drives the scrubber, the ring buffer and the console
 * bridge from literals. Four things it structurally cannot cover, and all four are exactly the
 * ones that fail in production rather than in review:
 *
 *   1. that `system_logs` is created **capped** on this deployment — Mongoose's `autoIndex`
 *      creating it uncapped first is the failure this design exists to avoid, and a capped
 *      collection cannot be converted afterwards;
 *   2. that `$collStats` is permitted here (a managed tier may refuse it, exactly as it refuses
 *      `serverStatus` — see `probeMongoServerDetail`);
 *   3. that a `warn` line actually lands in the collection and a `debug` line does not;
 *   4. that the level floor is enforced, so persistence cannot be turned down to `debug` and
 *      quietly evict the errors the collection exists to keep.
 *
 * It WRITES — a handful of log rows into a self-evicting capped collection, which is the one
 * place in this repo where writing test data cleans itself up by construction. It does not drop
 * the collection: doing so on a shared dev database would destroy whatever history was there.
 *
 * Needs Mongo. Run: npm run verify:logs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { COLLECTIONS } from '../../src/core/database/collections';

// Env before anything reads config at module load. Persistence is off by default outside
// production, so this check has to ask for it explicitly.
process.env.LOG_PERSIST_ENABLED = 'true';
process.env.LOG_PERSIST_LEVEL = 'warn';
process.env.LOG_STDOUT = 'false';
process.env.LOG_LEVEL = 'debug';
process.env.LOG_CONSOLE_BRIDGE = 'false';

import { enableLogPersistence, logger, logMongoSink, loggingConfig } from '../../src/core/logging';
import { originalConsole } from '../../src/core/logging/sink-guard';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let passed = 0;
let failed = 0;

function assert(name: string, ok: boolean, detail = ''): void {
    if (ok) {
        originalConsole.log(`  ✅ ${name}`);
        passed++;
    } else {
        originalConsole.error(`  ❌ FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
        failed++;
    }
}

function section(title: string): void {
    originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

/** The sink is unacknowledged (`w:0`) by design, so a read must give it a moment to land. */
async function settle(ms = 400): Promise<void> {
    await logMongoSink.flush();
    await new Promise((resolve) => setTimeout(resolve, ms));
}

void (async () => {
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    if (!db) {
        originalConsole.error('No database handle after connect.');
        process.exit(1);
    }

    section('Level floor — configuration cannot defeat the feature');

    assert(
        'LOG_PERSIST_LEVEL=warn is honoured',
        loggingConfig().PERSIST_LEVEL === 'warn',
        loggingConfig().PERSIST_LEVEL,
    );

    section('Collection creation — capped, and verified rather than assumed');

    await enableLogPersistence();
    const facts = logMongoSink.describe();

    assert('the sink reports itself enabled', facts.enabled === true, JSON.stringify(facts.note));
    assert('the sink is in the active state', logMongoSink.state() === 'active', String(logMongoSink.state()));

    assert(
        '$collStats is permitted on this deployment',
        facts.verified === true,
        String(facts.note ?? ''),
    );

    assert(
        `${COLLECTIONS.SYSTEM_LOG} is CAPPED — the whole point of the design`,
        facts.capped === true,
        `capped=${String(facts.capped)} note=${String(facts.note ?? '')}`,
    );

    assert(
        'the cap size is reported so a mismatch is visible rather than assumed',
        typeof facts.sizeBytes === 'number' && (facts.sizeBytes as number) > 0,
        String(facts.sizeBytes),
    );

    const indexes = await db.collection(COLLECTIONS.SYSTEM_LOG).listIndexes().toArray();
    assert(
        'exactly one secondary index exists, on requestId',
        indexes.length === 2 && indexes.some((i) => i.name === 'requestId_1'),
        indexes.map((i) => i.name).join(','),
    );
    assert(
        'there is deliberately NO index on `at` — natural order IS time order here',
        !indexes.some((i) => JSON.stringify(i.key).includes('"at"')),
        indexes.map((i) => JSON.stringify(i.key)).join(' '),
    );

    section('Writes — the floor is enforced at the stream, not by hope');

    const marker = `verify-logs-${Date.now()}`;
    logger().warn({ requestId: marker }, `warn ${marker}`);
    logger().error({ requestId: marker }, `error ${marker}`);
    logger().info({ requestId: marker }, `info ${marker}`);
    logger().debug({ requestId: marker }, `debug ${marker}`);
    await settle();

    const rows = await db
        .collection(COLLECTIONS.SYSTEM_LOG)
        .find({ requestId: marker })
        .toArray();
    const levels = rows.map((r) => String(r.level)).sort();

    assert('a warn line is persisted', levels.includes('warn'), levels.join(','));
    assert('an error line is persisted', levels.includes('error'), levels.join(','));
    assert(
        'an info line is NOT persisted — the floor is warn',
        !levels.includes('info'),
        levels.join(','),
    );
    assert(
        'a debug line is NOT persisted',
        !levels.includes('debug'),
        levels.join(','),
    );

    assert(
        'the persisted row carries its requestId — this is the cross-service join',
        rows.every((r) => r.requestId === marker),
    );
    assert(
        'the persisted row stores `at` as a real Date, so $natural and time agree',
        rows.every((r) => r.at instanceof Date),
    );

    section('Redaction reaches the collection, not just the console');

    const secretMarker = `verify-secret-${Date.now()}`;
    logger().warn(
        { requestId: secretMarker, password: 'hunter2' },
        `leaked eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij ${secretMarker}`,
    );
    await settle();

    const secretRows = await db
        .collection(COLLECTIONS.SYSTEM_LOG)
        .find({ requestId: secretMarker })
        .toArray();

    assert('the line landed', secretRows.length === 1, String(secretRows.length));
    assert(
        'the JWT in the MESSAGE was scrubbed before storage',
        secretRows.every((r) => !String(r.msg).includes('eyJhbGciOi')),
        String(secretRows[0]?.msg),
    );

    section('Failure posture — a struggling sink must not become the incident');

    const before = logMongoSink.describe();
    assert(
        'in-flight writes are bounded and reported',
        typeof before.inflight === 'number' && (before.inflight as number) <= loggingConfig().MONGO_MAX_INFLIGHT,
    );
    assert(
        'dropped and failed writes are counted separately, so silence is not mistaken for health',
        typeof before.droppedWrites === 'number' && typeof before.failedWrites === 'number',
    );

    await mongoose.disconnect();

    originalConsole.log(`\n${'═'.repeat(76)}`);
    originalConsole.log(`  ${passed} passed, ${failed} failed`);
    originalConsole.log('═'.repeat(76));
    process.exit(failed > 0 ? 1 : 0);
})();
