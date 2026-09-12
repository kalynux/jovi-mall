/**
 * Test: the environment contract — `.env.example` against what `src/` actually reads.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. It does two unrelated jobs, and only the first is a normal unit test.
 *
 *   1. **A source CENSUS**, in the shape `test:errors` already uses for its ~1517
 *      `createAppError` sites. It re-derives the set of variables `src/` reads — including the
 *      ~120 that reach `process.env` through a helper (`intEnv('COD_BATCH_SIZE', 200)`) and are
 *      therefore invisible to a `process.env.X` grep — and asserts `.env.example` documents
 *      every one. This is the check whose absence produced the audit finding: 84 of 149
 *      variables undocumented, and the real number was worse because the audit's own grep
 *      could not see the helper-read ones either.
 *
 *      It fails in BOTH directions on purpose. An undocumented variable is a deploy
 *      misconfigured with no error at boot; a documented variable nothing reads is the
 *      `CLOUDINARY_CLOUD_NAME` trap — an operator sets it, believes storage is configured, and
 *      uploads go to a container disk that is wiped on restart.
 *
 *   2. **The validator's rules**, driven against synthetic environments.
 *
 * What it cannot cover: whether a documented DESCRIPTION is true. A variable can be listed,
 * spelled right, and described wrongly. Only reading the consuming code catches that.
 *
 * Run: npm run test:env
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { validateEnv, formatEnvProblems, EnvProblem } from '../../src/config/env';

 
const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
    if (condition) {
        passed += 1;
    } else {
        failures.push(label);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    assert(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** True when the problem list contains an error naming `variable`. */
function hasError(problems: EnvProblem[], variable: string): boolean {
    return problems.some((p) => p.level === 'error' && p.variable === variable);
}

/** True when the problem list contains a warning naming `variable`. */
function hasWarning(problems: EnvProblem[], variable: string): boolean {
    return problems.some((p) => p.level === 'warning' && p.variable === variable);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The census
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(__dirname, '..', '..', 'src');
const ENV_EXAMPLE = join(__dirname, '..', '..', '.env.example');

/**
 * Directories excluded from the census.
 *
 * `src/scripts/**` is one-off operational and migration tooling. It is ESLint-ignored, it is
 * not type-checked by the build, several files in it no longer compile, and it is not part of
 * the deployed service — so a variable only IT reads is not part of this service's
 * environment contract.
 */
const EXCLUDED_DIRS = new Set(['scripts', 'node_modules']);

/**
 * Variables that are read but deliberately NOT offered in the template, each with the reason.
 *
 * This list is meant to stay short. An entry here is a claim that an operator setting the
 * variable would be making a mistake.
 */
const INTENTIONALLY_UNDOCUMENTED: Readonly<Record<string, string>> = Object.freeze({
    // Read by `src/scripts/**` and by the /system/config wiring probe, never by the server's
    // own connection. Offering it in the template is how an operator sets the wrong one of the
    // two and boots cleanly against localhost. `config/env.ts` errors when it is set alone.
    MONGODB_URI: 'trap name — server.ts connects with MONGO_URI',
});

/** Every `.ts` file under src/, minus the excluded directories. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (EXCLUDED_DIRS.has(entry)) continue;
            collectSourceFiles(full, out);
        } else if (entry.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Every environment variable a source file reads, by either route.
 *
 * The second pattern is the one that matters. Roughly half of this service's variables never
 * appear as `process.env.NAME` anywhere — they are string literals handed to a module config's
 * `intEnv` / `boolEnv` / `listEnv` / `numEnv` / `envInt` / `percentListEnv` helper. A census
 * that only looked for the first pattern would report a clean bill of health while missing
 * every tunable in `agent.config.ts`, `cod.config.ts`, `system.config.ts` and the rest.
 */
function readsIn(source: string): Set<string> {
    const found = new Set<string>();

    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        found.add(match[1]);
    }
    for (const match of source.matchAll(/\b(?:intEnv|boolEnv|listEnv|numEnv|percentListEnv|envInt|requireSecret)\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
        found.add(match[1]);
    }
    return found;
}

const sourceFiles = collectSourceFiles(SRC);
assert(sourceFiles.length > 100, `census found ${sourceFiles.length} source files — expected the whole of src/`);

/** variable → the files that read it, for a failure message that says where to look. */
const readBy = new Map<string, string[]>();
for (const file of sourceFiles) {
    for (const name of readsIn(readFileSync(file, 'utf8'))) {
        const list = readBy.get(name) ?? [];
        list.push(relative(SRC, file).replace(/\\/g, '/'));
        readBy.set(name, list);
    }
}

const envExample = readFileSync(ENV_EXAMPLE, 'utf8');

/**
 * Names offered by the template — both `NAME=` and `# NAME=`.
 *
 * A commented-out line still counts as documented: it names the variable, states its default
 * and explains the effect, which is everything an operator needs.
 */
const documented = new Set<string>();
for (const line of envExample.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) documented.add(match[1]);
}

assert(documented.size > 200, `.env.example declares only ${documented.size} variables — the template looks truncated`);

// ── No variable may be ASSIGNED twice, here or in a real .env ────────────────
//
// ⚠ This exists because of a live misconfiguration, not a hypothetical one.
// `.env` carried VECTORISER_BASE_URL and VECTORISER_API_KEY twice: once with the
// real values, and again several hundred lines later in a stale section. dotenv
// lets the LAST occurrence win, so the stale pair was the one in force — the base
// URL pointed at a path that no longer exists and the key was still the literal
// placeholder `your-t8n-api-key-here`. Nothing failed at boot, nothing logged,
// and every vectorisation request 404'd against n8n's own Express handler.
//
// The census above cannot see this: a duplicate name is documented, and it is
// read, so both of its checks pass. Only counting ASSIGNMENTS finds it.
//
// Commented lines are excluded on purpose — `# NAME=` beside an active `NAME=` is
// the normal way this template documents a default next to a chosen value.
function activeAssignments(text: string): Map<string, number[]> {
    const seen = new Map<string, number[]>();
    text.split('\n').forEach((line, index) => {
        const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
        if (!match) return;
        const at = seen.get(match[1]) ?? [];
        at.push(index + 1);
        seen.set(match[1], at);
    });
    return seen;
}

function reportDuplicates(text: string, label: string): void {
    const duplicated = [...activeAssignments(text).entries()].filter(([, lines]) => lines.length > 1);
    assert(
        duplicated.length === 0,
        `${label} assigns the same variable more than once — dotenv silently takes the LAST one:\n` +
            duplicated.map(([name, lines]) => `      ${name} (lines ${lines.join(', ')})`).join('\n'),
    );
}

reportDuplicates(envExample, '.env.example');

// The real .env is not in the repository, so this half only runs where one exists
// — a developer's machine and any CI job that writes one. That is exactly where
// the bug above lived, and where it would have been caught.
const LOCAL_ENV = join(__dirname, '..', '..', '.env');
if (existsSync(LOCAL_ENV)) {
    reportDuplicates(readFileSync(LOCAL_ENV, 'utf8'), '.env');
}

// ── Every variable read must be documented ───────────────────────────────────
const undocumented = [...readBy.keys()]
    .filter((name) => !documented.has(name))
    .filter((name) => !(name in INTENTIONALLY_UNDOCUMENTED))
    .sort();

assertEqual(
    undocumented.length,
    0,
    `variables read by src/ but absent from .env.example (a deploy from the template is misconfigured with no error at boot):\n` +
        undocumented.map((n) => `      ${n}  ← ${(readBy.get(n) ?? []).slice(0, 3).join(', ')}`).join('\n'),
);

// ── Every documented variable must be read ───────────────────────────────────
const unread = [...documented]
    .filter((name) => !readBy.has(name))
    .sort();

assertEqual(
    unread.length,
    0,
    `variables offered by .env.example that nothing in src/ reads (an operator sets them and they do nothing):\n` +
        unread.map((n) => `      ${n}`).join('\n'),
);

// ── The intentional exclusions must still be real ────────────────────────────
// An entry that stops being read, or that someone adds to the template, is a stale claim.
for (const [name, reason] of Object.entries(INTENTIONALLY_UNDOCUMENTED)) {
    assert(readBy.has(name), `INTENTIONALLY_UNDOCUMENTED lists ${name} (${reason}) but nothing reads it — drop the entry`);
    assert(!documented.has(name), `${name} is in INTENTIONALLY_UNDOCUMENTED but .env.example offers it anyway`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The validator
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal environment that produces no ERRORS, so each case below tests one thing. */
const clean: NodeJS.ProcessEnv = Object.freeze({
    NODE_ENV: 'development',
    MONGO_URI: 'mongodb://localhost:27017/jovi_mall',
    JWT_SECRET: 'x'.repeat(32),
    ALLOWED_ORIGINS: 'http://localhost:5173',
});

const baseline = validateEnv(clean);
assertEqual(baseline.filter((p) => p.level === 'error').length, 0, `the clean environment produced errors:\n${formatEnvProblems(baseline)}`);

// ── Shape ────────────────────────────────────────────────────────────────────
assert(hasError(validateEnv({ ...clean, COD_DEPOSIT_DEADLINE_DAYS: 'two' }), 'COD_DEPOSIT_DEADLINE_DAYS'),
    'an unparseable integer must be an error — parseInt silently substitutes the default');
assert(hasError(validateEnv({ ...clean, EARNINGS_HOLD_DAYS: '-3' }), 'EARNINGS_HOLD_DAYS'),
    'a negative integer must be an error — the helper discards it and the default applies');
assert(hasError(validateEnv({ ...clean, FILE_CLEANUP_ENABLED: 'yes' }), 'FILE_CLEANUP_ENABLED'),
    '"yes" is not a boolean this codebase agrees on — the helpers disagree about what it means');
assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 's3' }), 'STORAGE_PROVIDER'),
    'an unsupported provider must be caught at boot, not at the first upload');

// ── STORAGE_PROVIDER=r2 ──────────────────────────────────────────────────────
// The bucket-equality case is the one that matters: R2 has no per-object ACL, so one bucket for
// both trees puts every digital product and delivery-proof photo on a public CDN. Nothing at
// runtime would report it — the upload succeeds, the URL is withheld by `toFileDetail`, and the
// object is served to anyone holding the key anyway (ADR-A01 D-2).
const R2_OK: NodeJS.ProcessEnv = Object.freeze({
    STORAGE_R2_ACCOUNT_ID: 'acct',
    STORAGE_R2_ACCESS_KEY_ID: 'akid',
    STORAGE_R2_SECRET_ACCESS_KEY: 'x'.repeat(40),
    STORAGE_R2_BUCKET: 'wi-mall-public',
    STORAGE_R2_PRIVATE_BUCKET: 'wi-mall-private',
    STORAGE_R2_PUBLIC_URL: 'https://cdn.example.com',
});

assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 'r2' }), 'STORAGE_R2_ACCOUNT_ID'),
    'r2 named without credentials must fail — loadStorageConfig attaches no block and the factory has nothing to build from');
assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 'r2', ...R2_OK, STORAGE_R2_PRIVATE_BUCKET: R2_OK.STORAGE_R2_BUCKET }), 'STORAGE_R2_PRIVATE_BUCKET'),
    'one bucket for both trees must refuse the boot — every digital/ object would be on the CDN (ADR-A01 D-2)');
assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 'r2', ...R2_OK, STORAGE_R2_PUBLIC_URL: 'https://cdn.example.com/' }), 'STORAGE_R2_PUBLIC_URL'),
    'a trailing slash must be caught — it emits `//key`, and it is identically wrong on wi-admin so nothing diverges to reveal it');
assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 'r2', ...R2_OK, STORAGE_R2_PUBLIC_URL: 'cdn.example.com' }), 'STORAGE_R2_PUBLIC_URL'),
    'a bare hostname must be caught — this is the custom domain, not the derived S3 endpoint');
assertEqual(validateEnv({ ...clean, STORAGE_PROVIDER: 'r2', ...R2_OK }).filter((p) => p.level === 'error').length, 0,
    'a fully configured r2 environment must produce no errors');
assert(validateEnv({ ...clean, COD_DEPOSIT_DEADLINE_DAYS: '3' }).every((p) => p.variable !== 'COD_DEPOSIT_DEADLINE_DAYS'),
    'a valid integer must not be flagged');

// An UNSET optional variable is the module config's business, never a problem here.
assert(validateEnv(clean).every((p) => p.variable !== 'COD_BATCH_SIZE'),
    'an unset optional variable must not be reported — it has a default and is entitled to it');

// ── The renamed-variable trap ────────────────────────────────────────────────
// Severity tracks blast radius, not tidiness. A stale name whose subsystem is not selected is
// dead config: worth reporting, not worth refusing a boot over. A validator that fails a start
// over harmless leftovers is one somebody switches off, after which it protects nothing.
assert(hasWarning(validateEnv({ ...clean, CLOUDINARY_CLOUD_NAME: 'demo' }), 'CLOUDINARY_CLOUD_NAME'),
    'a legacy storage name must be reported — the value is silently ignored');
assert(!hasError(validateEnv({ ...clean, CLOUDINARY_CLOUD_NAME: 'demo' }), 'CLOUDINARY_CLOUD_NAME'),
    'a legacy name under a provider that is not selected must NOT refuse the boot — it is dead config, not a fault');
assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'demo' }), 'STORAGE_CLOUDINARY_CLOUD_NAME'),
    'the DANGEROUS case — the legacy spelling under the provider it configures — must still be a hard error, caught by the storage block rather than the rename check');
assert(hasError(validateEnv({ ...clean, MONGODB_URI: 'mongodb://prod/db', MONGO_URI: undefined }), 'MONGODB_URI'),
    'MONGODB_URI alone must be an error — there is no configuration under which it is harmless, and connecting to localhost succeeds silently');
assert(!hasWarning(validateEnv({ ...clean, CLOUDINARY_CLOUD_NAME: 'demo', STORAGE_CLOUDINARY_CLOUD_NAME: 'demo' }), 'CLOUDINARY_CLOUD_NAME'),
    'a legacy name set ALONGSIDE the current one is harmless and must not be reported at all');

// ── Conditional requirements ─────────────────────────────────────────────────
assert(hasError(validateEnv({ ...clean, STORAGE_PROVIDER: 'cloudinary' }), 'STORAGE_CLOUDINARY_CLOUD_NAME'),
    'a provider named without its credentials must fail — loadStorageConfig attaches no block and the factory has nothing to build from');
assert(hasError(validateEnv({ ...clean, MAIL_PROVIDER: 'smtp' }), 'SMTP_HOST'),
    'MAIL_PROVIDER=smtp without a host must fail — nodemailer fails at delivery, not at boot');
assert(hasError(validateEnv({ ...clean, STRIPE_SECRET_KEY: 'sk_test_x' }), 'STRIPE_WEBHOOK_SECRET'),
    'a Stripe key without a webhook secret must fail — customers are charged and orders stay unpaid');
assert(hasError(validateEnv({ ...clean, GEO_TRACKER_BASE_URL: 'http://localhost:8090' }), 'GEO_TRACKER_WEBHOOK_SECRET'),
    'a geo-tracker URL without the shared HMAC secret must fail — every event is rejected');
assert(validateEnv(clean).every((p) => p.variable !== 'GEO_TRACKER_WEBHOOK_SECRET'),
    'an unset GEO_TRACKER_BASE_URL means the integration is inert — that is the documented local default, not a fault');

// ── Cross-field rules ────────────────────────────────────────────────────────
assert(hasError(validateEnv({ ...clean, COD_DEPOSIT_CONFIRM_DEADLINE_DAYS: '5', COD_DEPOSIT_DEADLINE_DAYS: '2' }), 'COD_DEPOSIT_CONFIRM_DEADLINE_DAYS'),
    'a confirmation window longer than the deposit deadline lets an agent stop their own late-deposit clock with an unfalsifiable claim');
assert(hasError(validateEnv({ ...clean, COD_TRUST_REDUCED_THRESHOLD: '90', COD_TRUST_FULL_THRESHOLD: '80' }), 'COD_TRUST_REDUCED_THRESHOLD'),
    'an inverted trust band leaves the reduced-exposure range empty');

// ── Warnings are warnings, and must not refuse a boot ────────────────────────
assert(hasWarning(validateEnv(clean), 'TRUST_PROXY'),
    'an unset TRUST_PROXY must warn — this process cannot know whether a proxy is in front of it');
assert(!hasError(validateEnv(clean), 'TRUST_PROXY'),
    'TRUST_PROXY must never refuse a boot — a service reached directly is a valid deployment');
assert(hasWarning(validateEnv(clean), 'VENDOR_APP_URL'),
    'an unset app URL must warn — notifications arrive with no action button');

// ── Production tightening ────────────────────────────────────────────────────
const prod: NodeJS.ProcessEnv = { ...clean, NODE_ENV: 'production' };

assert(hasError(validateEnv({ ...prod, ALLOWED_ORIGINS: undefined }), 'ALLOWED_ORIGINS'),
    'an empty CORS allowlist must refuse a production boot — the symptom is otherwise a browser-side error and a 200 in the log');
assert(hasWarning(validateEnv({ ...clean, ALLOWED_ORIGINS: undefined }), 'ALLOWED_ORIGINS'),
    'the same condition is only a warning in development');
assert(hasError(validateEnv({ ...prod, MONGO_URI: undefined }), 'MONGO_URI'),
    'an unset MONGO_URI must refuse a production boot rather than serving an empty localhost database');
assert(hasError(validateEnv({ ...prod, GEO_TRACKER_BASE_URL: 'http://b:8090', GEO_TRACKER_WEBHOOK_SECRET: 'changeme' }), 'GEO_TRACKER_WEBHOOK_SECRET'),
    'a placeholder shared secret must refuse a production boot');
assert(hasError(validateEnv({ ...prod, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's'.repeat(20) }), 'GOOGLE_TOKEN_ENCRYPTION_KEY'),
    'Google Calendar configured without an encryption key must refuse a production boot — the vault would fall back to a key committed to this repository');
assert(hasError(validateEnv({ ...prod, GOOGLE_CLIENT_ID: 'id' }), 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET'),
    'half a Google credential must refuse a production boot — the client substitutes a hardcoded one for the missing half');
assert(hasError(validateEnv({ ...prod, ALLOWED_ORIGINS: 'https://app.example.com/' }), 'ALLOWED_ORIGINS'),
    'a trailing slash must be caught — origin matching is exact, so it would never match anything');

// ── Every problem at once ────────────────────────────────────────────────────
const messy = validateEnv({
    ...clean,
    COD_DEPOSIT_DEADLINE_DAYS: 'two',
    STORAGE_PROVIDER: 's3',
    FILE_CLEANUP_ENABLED: 'yes',
});
assert(messy.filter((p) => p.level === 'error').length >= 3,
    'the validator must report every problem in one pass — an operator should fix one list, not restart three times');

// ─────────────────────────────────────────────────────────────────────────────
// Report
//
// Printed through `originalConsole`: with LOG_CONSOLE_BRIDGE on, a plain console.log is
// swallowed by the logging bridge and this harness reports nothing.
// ─────────────────────────────────────────────────────────────────────────────

originalConsole.log('');
originalConsole.log(`  src/ files scanned:        ${sourceFiles.length}`);
originalConsole.log(`  variables read:            ${readBy.size}`);
originalConsole.log(`  variables documented:      ${documented.size}`);
originalConsole.log('');

if (failures.length > 0) {
    originalConsole.error(`✖ test:env — ${failures.length} failed, ${passed} passed\n`);
    for (const failure of failures) originalConsole.error(`  ✖ ${failure}`);
    originalConsole.error('');
    process.exit(1);
}

originalConsole.log(`✔ test:env — ${passed} assertions passed`);
