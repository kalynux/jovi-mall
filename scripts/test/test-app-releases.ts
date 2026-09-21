/**
 * App distribution — the agent APK's public download surface. No DB, no network.
 *
 * ── Why this suite exists ─────────────────────────────────────────────────────
 * Almost everything this module does correctly is invisible in its own behaviour, because the
 * happy path is "a 302 arrives". The four properties worth pinning are all things that would
 * keep working, wrongly, if somebody changed them:
 *
 *   §1 the storage tree is PUBLIC. `test:uploads` asserts every tree is *classified*; it does
 *      not care which verdict this one has, and a well-meaning "APKs should be private"
 *      reclassification would 404 every download with nothing else failing.
 *   §2 the route is UNAUTHENTICATED. The landing site has no session and never will, so an
 *      auth guard added here by habit breaks the download for everyone and looks like a
 *      hardening improvement in the diff.
 *   §3 `/download` REDIRECTS and does not stream. Streaming 79 MB through the Node process is
 *      a correct-looking four-line change that moves the platform's whole install traffic onto
 *      a 2 vCPU box (`docs/DEPLOY-VPS.md`).
 *   §4 the publish script REFUSES the Android debug key. That refusal is the only thing
 *      standing between a keystore-less build machine and an APK that can never be updated
 *      from Play without an uninstall — a failure that surfaces months later on other people's
 *      phones.
 *
 * Run: npx ts-node scripts/test/test-app-releases.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    PUBLIC_STORAGE_TREES,
    PRIVATE_STORAGE_TREES,
    STORAGE_TREE_VISIBILITY,
    isPrivateStorageKey,
} from '../../src/core/storage/storage-trees';
import {
    APK_MIME_TYPE,
    APP_KEYS,
    APP_RELEASE_STATUSES,
    APP_RELEASE_STORAGE_FOLDER,
    isAppKey,
} from '../../src/modules/app-distribution/app-distribution.types';
import { AppReleaseService } from '../../src/modules/app-distribution/services/app-release.service';
import { IAppRelease } from '../../src/modules/app-distribution/models/app-release.model';
import { ERROR_CODES } from '../../src/core/error-codes';

let passed = 0;
let failed = 0;

function assert(label: string, condition: () => boolean): void {
    // Declared without an initial value: every path below assigns it, and a `= false` here
    // is dead — the linter is right that it hides which branch decided the verdict.
    let ok: boolean;
    try {
        ok = condition();
    } catch (error: any) {
        ok = false;
        console.error('  ERROR ' + label + ' -> ' + (error?.message ?? error));
    }
    if (ok) {
        passed++;
    } else {
        failed++;
        console.error('  FAIL  ' + label);
    }
}

function section(title: string): void {
    console.log('\n' + title);
}

const ROOT = path.join(__dirname, '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const MODULE = 'src/modules/app-distribution';
const ROUTES_SRC = read(MODULE, 'routes', 'public-app-release.routes.ts');
const CONTROLLER_SRC = read(MODULE, 'controllers', 'public-app-release.controller.ts');
const SERVICE_SRC = read(MODULE, 'services', 'app-release.service.ts');
const REPO_SRC = read(MODULE, 'repositories', 'app-release.repository.ts');
const MODEL_SRC = read(MODULE, 'models', 'app-release.model.ts');
const SCRIPT_SRC = read('scripts', 'publish-app-release.ts');
const API_INDEX_SRC = read('src', 'api', 'index.ts');

/** Comments are prose about the rules; scanning them instead of the code proves nothing. */
function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CONTROLLER_CODE = code(CONTROLLER_SRC);
const ROUTES_CODE = code(ROUTES_SRC);
const SERVICE_CODE = code(SERVICE_SRC);
const REPO_CODE = code(REPO_SRC);
const SCRIPT_CODE = code(SCRIPT_SRC);

// ─────────────────────────────────────────────────────────────────────────────

function run(): void {
    section('1. The storage tree — PUBLIC, and reachable');

    assert('`app-releases` is classified', () =>
        APP_RELEASE_STORAGE_FOLDER in STORAGE_TREE_VISIBILITY);

    assert('…as PUBLIC — a private verdict 404s every download', () =>
        STORAGE_TREE_VISIBILITY[APP_RELEASE_STORAGE_FOLDER] === 'public');

    assert('…so it is on the express.static mount list', () =>
        PUBLIC_STORAGE_TREES.includes(APP_RELEASE_STORAGE_FOLDER));

    assert('…and not on the private list', () =>
        !PRIVATE_STORAGE_TREES.includes(APP_RELEASE_STORAGE_FOLDER));

    assert('a release key reads as public', () =>
        !isPrivateStorageKey('app-releases/2026/09/uuid_wi-agent-0.1.0.apk'));

    // The local provider builds keys with `path.join`, so a key written on Windows carries
    // backslashes. Same trap `test:uploads` pins for the other trees.
    assert('…including a WINDOWS-separated one', () =>
        !isPrivateStorageKey('app-releases\\2026\\09\\uuid_wi-agent-0.1.0.apk'));

    assert('the folder the publish script writes IS the classified name', () =>
        SCRIPT_CODE.includes('APP_RELEASE_STORAGE_FOLDER')
        && !/folder:\s*'app-releases'/.test(SCRIPT_CODE));

    section('2. The app key is a CLOSED set');

    assert('`agent-android` is a key', () => isAppKey('agent-android'));
    assert('an unlisted app is refused', () => !isAppKey('agent-ios'));
    assert('a path-traversal probe is refused', () => !isAppKey('../../digital'));
    assert('a non-string is refused', () => !isAppKey(undefined) && !isAppKey(42));

    /**
     * ⚠ **PER HANDLER, because the file-wide version of this passed over a real defect.**
     *
     * The original assertion asked whether `APP_UNKNOWN, 404` and `isAppKey` appeared anywhere
     * in the controller. They did — in `download`. `latest` was meanwhile validating the same
     * segment with Zod, so one unknown app key answered `400 VALIDATION_ERROR` on one route and
     * `404 APP_UNKNOWN` on the other, and the api-doc documented only the second. A guard that
     * scans a whole file cannot see two handlers disagreeing inside it.
     */
    const handlerBodies: Array<[string, string]> = ['latest', 'download'].map((name) => {
        const start = CONTROLLER_CODE.indexOf('static ' + name + ' = asyncHandler');
        const rest = CONTROLLER_CODE.slice(start + 1);
        const next = rest.indexOf('static ');
        return [name, next === -1 ? rest : rest.slice(0, next)] as [string, string];
    });

    assert('both handlers were located', () =>
        handlerBodies.length === 2 && handlerBodies.every(([, body]) => body.length > 40));

    for (const [name, body] of handlerBodies) {
        assert('`' + name + '` resolves :app through the shared 404 guard', () =>
            body.includes('requireAppKey(req.params.app)'));
        assert('…and `' + name + '` does NOT parse it with Zod (that would be a 400)', () =>
            !body.includes('.parse(') && !body.includes('Schema'));
    }

    assert('the guard raises APP_UNKNOWN at 404', () =>
        /function requireAppKey[\s\S]{0,400}ERROR_CODES\.APP_UNKNOWN,\s*404/.test(CONTROLLER_CODE));

    // The Zod validator this replaced is gone; a file nothing imports is a trap for the next
    // reader, who would reasonably assume the routes still use it.
    assert('the superseded Zod validator is deleted, not merely unused', () =>
        !fs.existsSync(path.join(ROOT, MODULE, 'validators', 'app-release.validator.ts')));

    section('3. The public routes carry NO auth guard');

    // The landing site is a separate Next.js app with no session — an auth guard added here
    // would break the download for every visitor and read as hardening in the diff.
    for (const guard of ['requireAuth', 'requireRole', 'requireServiceToken', 'requireAdminCaller']) {
        assert('`' + guard + '` is absent from the router', () => !ROUTES_CODE.includes(guard));
    }

    assert('both reads are GET — nothing here writes', () => {
        const verbs = ROUTES_CODE.match(/router\.(get|post|put|patch|delete)\(/g) ?? [];
        return verbs.length === 2 && verbs.every((v) => v === 'router.get(');
    });

    assert('it is mounted on /public, AFTER the publicRateLimiter line', () => {
        const limiter = API_INDEX_SRC.indexOf("router.use('/public', publicRateLimiter)");
        const mount = API_INDEX_SRC.indexOf("router.use('/public', publicAppReleaseRoutes)");
        return limiter !== -1 && mount !== -1 && limiter < mount;
    });

    section('4. /download REDIRECTS — this service never serves the bytes');

    assert('the controller redirects', () => /res\.redirect\(/.test(CONTROLLER_CODE));

    // A 301 is cached indefinitely by browsers and permanently by some proxies, which pins a
    // device to one build's CDN object for the life of the profile.
    assert('…with 302, never 301', () =>
        /res\.redirect\(302,/.test(CONTROLLER_CODE) && !/301/.test(CONTROLLER_CODE));

    for (const byteApi of ['getDownloadStream', 'getBuffer', 'sendFile', 'pipe(']) {
        assert('the controller never calls `' + byteApi + '`', () =>
            !CONTROLLER_CODE.includes(byteApi));
        assert('the service never calls `' + byteApi + '`', () =>
            !SERVICE_CODE.includes(byteApi));
    }

    assert('the URL comes from the provider, not from a stored string', () =>
        SERVICE_CODE.includes('getPublicUrl(release.storageKey)')
        && !/storageUrl|publicUrl:\s*release\./.test(SERVICE_CODE));

    assert('a private key is caught BEFORE getPublicUrl can throw', () => {
        const guard = SERVICE_CODE.indexOf('isPrivateStorageKey');
        const call = SERVICE_CODE.indexOf('getPublicUrl(');
        return guard !== -1 && call !== -1 && guard < call;
    });

    section('5. Cache headers — the metadata is short-lived, the artefact is not');

    assert('both reads set a 300s Cache-Control', () =>
        (CONTROLLER_CODE.match(/max-age=\$\{CACHE_SECONDS\}/g) ?? []).length === 2
        && /CACHE_SECONDS\s*=\s*300/.test(CONTROLLER_CODE));

    // `immutable` belongs on the object (the provider sets it, keys carry a uuid). On the
    // redirect it would pin every downloader to one build forever.
    assert('the redirect is NOT immutable and not a year long', () =>
        !CONTROLLER_CODE.includes('immutable') && !CONTROLLER_CODE.includes('31536000'));

    section('6. The model and the repository');

    assert('(app, versionCode) is UNIQUE — a double publish must fail', () =>
        /index\(\s*\{\s*app:\s*1,\s*versionCode:\s*-1\s*\}\s*,\s*\{\s*unique:\s*true/.test(MODEL_SRC));

    // `findLatestPublished` must order by the number Android itself compares. Ordering by
    // recency would make a rollback the newest row and hand out a build phones refuse.
    assert('the latest-published read sorts by versionCode, never publishedAt', () =>
        REPO_CODE.includes('.sort({ versionCode: -1 })')
        && !/findLatestPublished[\s\S]{0,400}publishedAt/.test(REPO_CODE));

    // Same trap `test:tracking-outbox` § 2 pins: Mongoose reads `{ session }` only when the
    // first argument is an array, so `create(doc, { session })` writes outside the transaction.
    assert('repository `create` uses the ARRAY form', () =>
        /AppReleaseModel\.create\(\[doc\]/.test(REPO_CODE));
    assert('…and so does the publish script', () =>
        /AppReleaseModel\.create\(\[\{/.test(SCRIPT_CODE));

    assert('there is no `draft` status — a public tree cannot hold one', () =>
        !(APP_RELEASE_STATUSES as readonly string[]).includes('draft')
        && APP_RELEASE_STATUSES.length === 2);

    section('7. The DTO tells a downloader what it needs to verify');

    const release = {
        app: 'agent-android',
        platform: 'android',
        versionName: '0.1.0',
        versionCode: 1,
        packageId: 'com.wi_mall.wiagent',
        minSdk: 24,
        storageKey: 'app-releases/2026/09/uuid_wi-agent-0.1.0.apk',
        fileName: 'wi-agent-0.1.0.apk',
        sizeBytes: 82885308,
        sha256: 'a'.repeat(64),
        signingCertSha256: '754b669109fd578938afd18eb8bd9931d8129559cfd31725c82c5bf9cf3fd389',
        releaseNotes: null,
        status: 'published',
        publishedAt: new Date('2026-09-16T02:43:00.000Z'),
    } as unknown as IAppRelease;

    const previousBase = process.env.API_PUBLIC_URL;
    process.env.API_PUBLIC_URL = 'https://api.wi-mall.com/';
    const dto = new AppReleaseService().toDto(release);
    if (previousBase === undefined) delete process.env.API_PUBLIC_URL;
    else process.env.API_PUBLIC_URL = previousBase;

    assert('downloadUrl is THIS service, never the CDN behind it', () =>
        dto.downloadUrl === 'https://api.wi-mall.com/api/public/app/agent-android/download');

    assert('…with the trailing slash on API_PUBLIC_URL stripped', () =>
        !dto.downloadUrl.includes('//api/public'));

    // The file hash proves the mirror; the certificate fingerprint proves the publisher.
    assert('the file checksum is published', () => dto.sha256 === 'a'.repeat(64));
    assert('the SIGNING certificate is published too', () =>
        dto.signingCertSha256 === release.signingCertSha256);

    assert('the storage key is NOT published', () =>
        !JSON.stringify(dto).includes(release.storageKey));

    assert('no `_id` reaches a public reader', () => !('_id' in (dto as object)));

    assert('minSdk survives, so a page can warn an Android 6 phone', () => dto.minSdk === 24);

    section('8. The publish script guards what only it can guard');

    assert('it refuses the Android DEBUG key', () =>
        SCRIPT_CODE.includes('DEBUG_CERT_MARKERS')
        && /DEBUG_CERT_MARKERS\.every[\s\S]{0,120}fail\(/.test(SCRIPT_CODE));

    assert('the debug markers are the real ones', () =>
        SCRIPT_SRC.includes("'CN=Android Debug'") && SCRIPT_SRC.includes("'O=Android'"));

    assert('it verifies a sibling checksum file when the build wrote one', () =>
        SCRIPT_CODE.includes(".sha1'") && SCRIPT_CODE.includes(".sha256'"));

    assert('it refuses a versionCode that does not increase', () =>
        /current\.versionCode\s*>=\s*badging\.versionCode/.test(SCRIPT_CODE));

    // Uploading 79 MB and then discovering the row cannot be written is the expensive order.
    assert('the duplicate check runs BEFORE the upload', () => {
        const clash = SCRIPT_CODE.indexOf('already has versionCode');
        const upload = SCRIPT_CODE.indexOf('.put(');
        return clash !== -1 && upload !== -1 && clash < upload;
    });

    assert('the APK mime type is the one Android expects', () =>
        APK_MIME_TYPE === 'application/vnd.android.package-archive'
        && SCRIPT_CODE.includes('APK_MIME_TYPE'));

    // `assertRegistryCovers()` fails if any `migrate:*` / `backfill:*` binding has no row in
    // MIGRATIONS. Naming this one `app:publish` is what keeps it out of that closed set — and
    // out of every deploy's `migrate:up`.
    assert('it is bound as `app:publish`, NOT as a migrate:* binding', () => {
        const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
        const bindings = Object.entries(scripts)
            .filter(([, cmd]) => cmd.includes('publish-app-release.ts'))
            .map(([name]) => name);
        return bindings.length === 1
            && bindings[0] === 'app:publish'
            && !/^(migrate|backfill):/.test(bindings[0]);
    });

    section('9. Error codes say the right thing to a marketing page');

    // "No build yet" is the ORDINARY state of a new app key and must render as a message, not
    // as a failure — so it is a 404 with its own code rather than a 500.
    assert('the three APP_* codes exist', () =>
        ERROR_CODES.APP_UNKNOWN === 'APP_UNKNOWN'
        && ERROR_CODES.APP_RELEASE_NOT_FOUND === 'APP_RELEASE_NOT_FOUND'
        && ERROR_CODES.APP_RELEASE_UNAVAILABLE === 'APP_RELEASE_UNAVAILABLE');

    // A Zod failure is a 400, and "this app does not exist" is not a malformed request.
    // The per-handler form of this lives in § 2; this is the module-level statement of it.
    assert('an unknown app is a 404, not a validation 400', () =>
        /APP_UNKNOWN,\s*404/.test(CONTROLLER_CODE) && !CONTROLLER_CODE.includes('.parse('));

    /**
     * ⚠ An unknown app key and a build with no app-distribution routes at all BOTH answer 404.
     * The `error.code` is the only thing that separates them, which matters because this
     * endpoint is the one unauthenticated probe on the platform that can answer "is this
     * deployed" — every `/api/internal/*` prefix returns 401 for real and fake paths alike.
     * Documented so nobody builds a deploy check on the status alone.
     */
    assert('the doc states that 404 alone cannot prove route-absence', () => {
        const doc = read('api-doc', 'public', 'app-downloads.md');
        return doc.includes('APP_UNKNOWN') && /404 alone|status alone|error\.code/i.test(doc);
    });

    assert('no published release is a 404', () =>
        /APP_RELEASE_NOT_FOUND,\s*\n?\s*404/.test(SERVICE_CODE));

    assert('an unaddressable artefact is a 503', () =>
        /APP_RELEASE_UNAVAILABLE,\s*\n?\s*503/.test(SERVICE_CODE));

    // The repo bans `throw new Error()` and `res.status().json({ error })` by ESLint rule.
    assert('the module raises through createAppError only', () =>
        !/(throw new Error\()/.test(CONTROLLER_CODE + SERVICE_CODE)
        && !/res\.status\([0-9]+\)\.json/.test(CONTROLLER_CODE));
}

console.log('\nApp distribution — the agent APK download surface');
run();
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
