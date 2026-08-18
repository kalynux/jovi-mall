/**
 * Test: the interim admin-action log — the shim that records administrative actions still
 * performed on THIS service until the wi-admin cutover.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: everything under test is a pure function or a source-level rule.
 *
 * Two sections carry the weight:
 *
 *   §1  redaction, and the rule that makes it a second line of defence rather than the
 *       first — the middleware never stores a request BODY at all, only key names. The
 *       legacy admin surface accepts KYC documents, payout references and delivery codes,
 *       and a redaction list over that is a list somebody must keep complete forever.
 *   §4  the transaction rule. Several call sites sit inside an open transaction, and a row
 *       written outside it can assert a change that rolled back. `runInTransactionWithRetry`
 *       is separately forbidden here — it re-runs its callback, so a row inside would be
 *       written once per retry.
 *
 * Run: npm run test:admin-audit
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { REDACTED_MARKER, SENSITIVE_FIELD_NAMES, redact } from '../../src/core/audit/redact';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const SRC = join(__dirname, '..', '..', 'src');

function readCode(...segments: string[]): string {
  return readFileSync(join(SRC, ...segments), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

console.log('\n── 1. Redaction ──────────────────────────────────────────────\n');

assert('a password is replaced, not stored', () => {
  const out = redact({ email: 'a@b.test', password: 'hunter2' });
  return out.value?.password === REDACTED_MARKER && out.value?.email === 'a@b.test';
});

assert('naming variants all match — camelCase, snake_case, upper', () =>
  redact({ passwordHash: 'x' }).value?.passwordHash === REDACTED_MARKER
  && redact({ password_hash: 'x' }).value?.password_hash === REDACTED_MARKER
  && redact({ PASSWORD: 'x' }).value?.PASSWORD === REDACTED_MARKER);

assert('nested credentials are reached', () => {
  const out = redact({ actor: { name: 'A', credentials: { token: 'abc' } } });
  const actor = out.value?.actor as Record<string, unknown>;
  const credentials = actor.credentials as Record<string, unknown>;
  return credentials.token === REDACTED_MARKER && actor.name === 'A';
});

assert('the COD delivery code is redacted — it is a customer secret', () =>
  redact({ code_plain: '4821' }).value?.code_plain === REDACTED_MARKER);

assert('an array of objects is walked', () => {
  const out = redact({ items: [{ secret: 's', id: 1 }] });
  const items = out.value?.items as Record<string, unknown>[];
  return items[0].secret === REDACTED_MARKER && items[0].id === 1;
});

assert('a Date becomes an ISO string rather than an empty object', () => {
  const out = redact({ at: new Date('2026-08-12T00:00:00.000Z') });
  return out.value?.at === '2026-08-12T00:00:00.000Z';
});

/**
 * Never throwing is the property that matters: this runs on the path of an action that
 * ALREADY HAPPENED, so a redaction failure must not turn a successful administrative write
 * into a 500.
 */
assert('a cycle is marked, not thrown on', () => {
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;
  const out = redact(cyclic);
  return out.value?.self === '[CIRCULAR]';
});

assert('an over-large payload is summarised rather than stored whole', () => {
  const big = { blob: 'x'.repeat(10_000) };
  const out = redact(big, 4096);
  return out.truncated === true && out.value?.truncated === true;
});

assert('a non-object is null rather than a crash', () =>
  redact('a string').value === null && redact(null).value === null && redact(42).value === null);

console.log('\n── 2. The body-keys rule — the PRIMARY control ───────────────\n');

/**
 * The middleware must never store a request body value. This is asserted at the source
 * because it is a rule about what the code does NOT do, which no unit test on a pure
 * function can express.
 */
const MIDDLEWARE = ['api', 'middlewares', 'admin-action-log.middleware.ts'];

assert('the middleware stores Object.keys(req.body), never the body', () => {
  const code = readCode(...MIDDLEWARE);
  return code.includes('Object.keys(body as Record<string, unknown>)')
    && !/body_keys:\s*req\.body/.test(code)
    && !/changes:\s*req\.body/.test(code);
});

assert('it never assigns req.body to any stored field', () => {
  const code = readCode(...MIDDLEWARE);
  // Every `req.body` mention must be inside the key-extraction helper.
  const mentions = (code.match(/req\.body/g) ?? []).length;
  return mentions <= 2;
});

assert('multipart requests are skipped entirely', () => {
  const code = readCode(...MIDDLEWARE);
  return code.includes("req.is('application/json')");
});

assert('safe methods are not recorded — a read changes nothing', () => {
  const code = readCode(...MIDDLEWARE);
  return /req\.method === 'GET'/.test(code);
});

assert('the row is written on finish, never before next()', () => {
  const code = readCode(...MIDDLEWARE);
  return code.includes("res.on('finish'") && code.includes('next();');
});

assert('a write failure is swallowed — an audit shim must not 500 a working endpoint', () => {
  const code = readCode(...MIDDLEWARE);
  return /catch\s*\{/.test(code);
});

console.log('\n── 3. The drift check against wi-admin ───────────────────────\n');

/**
 * This file is a deliberate copy of wi-admin's leaf-name approach, because the two services
 * share no package. wi-admin's `test-audit.ts` asserts the same relationship from its side;
 * this is the half that lives here.
 */
assert('every name wi-admin redacts by leaf is covered here', () => {
  const required = ['password', 'token', 'secret', 'authorization', 'cookie', 'pan', 'cvv'];
  return required.every((name) => SENSITIVE_FIELD_NAMES.has(name));
});

assert('the marker matches wi-admin’s, so a reader sees one convention', () =>
  REDACTED_MARKER === '[REDACTED]');

console.log('\n── 4. The transaction rule ───────────────────────────────────\n');

const RECORDER = ['core', 'audit', 'admin-action.recorder.ts'];

assert('the recorder accepts a session and passes it to create()', () => {
  const code = readCode(...RECORDER);
  return code.includes('session?: ClientSession')
    && code.includes('AdminActionLogModel.create([row], session ? { session } : undefined)');
});

/**
 * The array form is not stylistic. `create(doc, options)` is read as a SECOND DOCUMENT by
 * some Mongoose versions, which writes outside the session and defeats the point — the same
 * footgun ADR-006 D-2 records for wi-admin.
 */
assert('create() uses the ARRAY form, so the session is not read as a document', () => {
  const code = readCode(...RECORDER);
  return code.includes('create([row]') && !/create\(row,/.test(code);
});

/**
 * `runInTransactionWithRetry` re-invokes its callback on a transient error, so a row written
 * inside would be written again per retry. The admin paths use `runInTransaction` (no
 * retry), which is what makes passing a session safe there.
 */
assert('no file both records an admin action and uses the RETRYING transaction helper', () => {
  const offenders: string[] = [];
  const files = [
    ['modules', 'delivery', 'services', 'admin-agency.service.ts'],
    ['core', 'audit', 'admin-action.recorder.ts'],
    ['core', 'audit', 'audit-logger.ts'],
  ];

  for (const segments of files) {
    const code = readCode(...segments);
    const records = code.includes('auditLogger.log(') || code.includes('recordAdminAction(');
    if (records && code.includes('runInTransactionWithRetry')) offenders.push(segments.join('/'));
  }

  if (offenders.length > 0) console.error(`      offenders: ${offenders.join(', ')}`);
  return offenders.length === 0;
});

assert('the two admin call sites pass their session', () => {
  const code = readCode('modules', 'delivery', 'services', 'admin-agency.service.ts');
  return (code.match(/\}, session\);/g) ?? []).length >= 2;
});

console.log('\n── 5. Scope of what persists ─────────────────────────────────\n');

/**
 * Only administrative actions persist. The other twelve `auditLogger.log` call sites are
 * vendor/store/magazin self-service profile writes; persisting those would turn a Phase-12
 * admin audit into an unbounded platform event stream with no retention owner.
 */
assert('the adapter persists only actor.role === admin', () => {
  const code = readCode('core', 'audit', 'audit-logger.ts');
  return code.includes("entry.actor.role !== 'admin'") && code.includes('recordAdminAction(');
});

assert('self-service still goes to the console, exactly as before', () => {
  const code = readCode('core', 'audit', 'audit-logger.ts');
  return code.includes("console.log('[Audit]'");
});

assert('query() is gone rather than half-implemented', () => {
  const code = readCode('core', 'audit', 'audit-logger.ts');
  return !code.includes('async query(');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
