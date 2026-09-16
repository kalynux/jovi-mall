/**
 * Publish a mobile app build so the marketing site can hand it out.
 *
 * ── Why publishing is a SCRIPT and not an endpoint ────────────────────────────
 * The write uploads ~79 MB through the storage provider and then asserts "this is what an
 * agent should install". Neither half belongs behind a request timeout, and the second half is
 * the kind of claim that should cost somebody a deliberate command rather than a button that
 * can be double-clicked. `modules/app-distribution/models/app-release.model.ts` carries the
 * same note at the model.
 *
 * ── Why it is NOT a `migrate:*` binding ───────────────────────────────────────
 * `scripts/migrate.ts` keeps a CLOSED registry — `assertRegistryCovers()` fails if any
 * `migrate:*` / `backfill:*` binding in package.json has no row in `MIGRATIONS`. This is
 * `app:publish` for the same reason `storage:migrate-r2` is not `migrate:*`: it is run at a
 * chosen moment by a human, not as part of `migrate:up`, and putting it in the ledger would
 * make every deploy try to re-upload an APK.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npm run app:publish -- --apk <path> [--notes "..."] [--notes-file <path>] [--dry-run]
 *   npm run app:publish -- --promote <versionCode>      # roll back to an earlier build
 *   npm run app:publish -- --list
 *
 *   --app <key>          default `agent-android`; must be one of APP_KEYS
 *   --dry-run            read, verify and print. Uploads nothing, writes nothing.
 *
 * `--dry-run` runs every check including the signing-key refusal, so it is the rehearsal that
 * actually proves the real run will get past its gates.
 */

import dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import mongoose from 'mongoose';

dotenv.config();

import { getStorageProvider, getStorageProviderType } from '../src/core/storage';
import { AppReleaseModel } from '../src/modules/app-distribution/models/app-release.model';
import {
    APK_MIME_TYPE,
    APP_KEYS,
    APP_RELEASE_STORAGE_FOLDER,
    AppKey,
    isAppKey,
} from '../src/modules/app-distribution/app-distribution.types';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

/**
 * The certificate subject Android's own debug keystore carries.
 *
 * ⚠ **Refusing this is the single most valuable check in the script.** A debug-signed APK
 * installs perfectly and behaves normally, so nothing about it looks wrong until the day the
 * app reaches Play — at which point every device that installed the debug build must
 * UNINSTALL before it can take a properly signed update, losing its local state, because
 * Android refuses an update whose signing certificate changed. That failure arrives months
 * after the mistake, on other people's phones, and cannot be repaired from the server side.
 *
 * `android/app/build.gradle.kts` falls back to the debug key when `key.properties` is absent,
 * which is right for a developer's own build and is exactly what makes this reachable: a
 * release APK built on a machine that does not hold the keystore is indistinguishable from a
 * real one by size, by name and by how it runs.
 */
const DEBUG_CERT_MARKERS = ['CN=Android Debug', 'O=Android'];

interface Args {
    app: AppKey;
    apk: string | null;
    notes: string | null;
    promote: number | null;
    list: boolean;
    dryRun: boolean;
}

function fail(message: string): never {
    console.error('\n  x ' + message + '\n');
    process.exit(1);
}

function parseArgs(argv: string[]): Args {
    const get = (flag: string): string | null => {
        const i = argv.indexOf(flag);
        return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
    };

    const appRaw = get('--app') ?? 'agent-android';
    if (!isAppKey(appRaw)) {
        fail('--app must be one of: ' + APP_KEYS.join(', ') + '  (got "' + appRaw + '")');
    }

    const notesFile = get('--notes-file');
    const notes = notesFile ? fs.readFileSync(notesFile, 'utf8').trim() : get('--notes');
    const promoteRaw = get('--promote');

    return {
        app: appRaw,
        apk: get('--apk'),
        notes: notes || null,
        promote: promoteRaw === null ? null : Number(promoteRaw),
        list: argv.includes('--list'),
        dryRun: argv.includes('--dry-run'),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Android SDK tooling — used when present, never required to exist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Locate a build-tools binary, newest version first.
 *
 * Optional by design: this script runs on whatever laptop built the APK, and that machine has
 * the SDK. A CI box or a container may not, and the script must still fail with a sentence
 * that names the missing tool rather than with a stack trace.
 */
function findBuildTool(name: string): string | null {
    const roots = [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
        process.env.HOME ? path.join(process.env.HOME, 'Android', 'Sdk') : null,
        process.env.HOME ? path.join(process.env.HOME, 'Library', 'Android', 'sdk') : null,
    ].filter((r): r is string => Boolean(r));

    for (const root of roots) {
        const buildTools = path.join(root, 'build-tools');
        if (!fs.existsSync(buildTools)) continue;
        // Newest first. A plain string sort is wrong across a major-version boundary
        // ("9" > "36"), so compare the dotted parts numerically.
        const versions = fs.readdirSync(buildTools).sort((a, b) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const d = (pb[i] || 0) - (pa[i] || 0);
                if (d !== 0) return d;
            }
            return 0;
        });
        for (const version of versions) {
            for (const ext of ['.exe', '.bat', '']) {
                const candidate = path.join(buildTools, version, name + ext);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    }
    return null;
}

interface Badging {
    packageId: string;
    versionName: string;
    versionCode: number;
    minSdk: number | null;
}

function readBadging(apkPath: string): Badging | null {
    const aapt = findBuildTool('aapt2');
    if (!aapt) return null;
    let out: string;
    try {
        out = execFileSync(aapt, ['dump', 'badging', apkPath], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch {
        return null;
    }

    const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(out);
    if (!pkg) return null;
    const minSdk = /minSdkVersion:'(\d+)'/.exec(out);

    return {
        packageId: pkg[1],
        versionCode: Number(pkg[2]),
        versionName: pkg[3],
        minSdk: minSdk ? Number(minSdk[1]) : null,
    };
}

interface Signing {
    certSha256: string;
    subject: string;
    schemes: string;
}

function readSigning(apkPath: string): Signing | null {
    const apksigner = findBuildTool('apksigner');
    if (!apksigner) return null;
    let out: string;
    try {
        out = execFileSync(apksigner, ['verify', '--print-certs', '-v', apkPath], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
    } catch (error: any) {
        // A verification FAILURE is a real answer, not a missing tool — apksigner exits
        // non-zero on an unsigned or corrupt APK and prints why.
        const combined = (error?.stdout ?? '') + (error?.stderr ?? '');
        fail('apksigner could not verify the APK:\n' + (combined.trim() || error?.message));
    }

    const sha = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(out);
    const dn = /certificate DN:\s*(.+)/.exec(out);
    if (!sha) return null;

    const schemes = ['v1', 'v2', 'v3', 'v3.1', 'v4']
        .filter((v) => new RegExp('Verified using ' + v.replace('.', '\\.') + ' scheme[^:]*: true').test(out))
        .join(', ');

    return { certSha256: sha[1].toLowerCase(), subject: dn ? dn[1].trim() : '(unknown)', schemes };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Modes
// ─────────────────────────────────────────────────────────────────────────────

async function listReleases(app: AppKey): Promise<void> {
    const rows = await AppReleaseModel.find({ app, deletedAt: null }).sort({ versionCode: -1 }).exec();
    if (rows.length === 0) {
        console.log('\n  No releases for ' + app + '.\n');
        return;
    }
    console.log('\n  ' + app + ' - ' + rows.length + ' release(s), newest first\n');
    for (const r of rows) {
        const mark = r.status === 'published' ? '>' : ' ';
        const mb = (r.sizeBytes / 1024 / 1024).toFixed(1);
        console.log(
            ('  ' + mark + ' ' + r.versionName + '+' + r.versionCode).padEnd(28)
            + r.status.padEnd(12) + mb.padStart(6) + ' MB  '
            + r.publishedAt.toISOString().slice(0, 10),
        );
        console.log('      ' + r.storageKey);
    }
    console.log('');
}

/**
 * Roll back: make an earlier build the published one again.
 *
 * ⚠ **This does not, and cannot, un-install anything.** A phone already running the newer
 * build keeps it — Android will not downgrade — so a rollback only changes what a NEW
 * downloader receives. Withdrawing a build from devices is not something a server can do.
 */
async function promote(app: AppKey, versionCode: number, dryRun: boolean): Promise<void> {
    const target = await AppReleaseModel.findOne({ app, versionCode, deletedAt: null }).exec();
    if (!target) fail(app + ' has no release with versionCode ' + versionCode + '. Try --list.');

    const current = await AppReleaseModel
        .findOne({ app, status: 'published', deletedAt: null })
        .sort({ versionCode: -1 })
        .exec();

    console.log('\n  ' + app);
    console.log('    currently published:  '
        + (current ? current.versionName + '+' + current.versionCode : '(none)'));
    console.log('    promoting:            ' + target.versionName + '+' + target.versionCode);
    if (current && current.versionCode > versionCode) {
        console.log('\n  ! This DOWNGRADES the published pointer. Devices already running the newer');
        console.log('    build keep it — Android refuses a downgrade — so this changes what a NEW');
        console.log('    downloader gets, and nothing else.');
    }
    if (dryRun) {
        console.log('\n  DRY RUN — nothing written.\n');
        return;
    }

    await AppReleaseModel.updateMany(
        { app, status: 'published', versionCode: { $ne: versionCode }, deletedAt: null },
        { $set: { status: 'superseded' } },
    ).exec();
    await AppReleaseModel.updateOne({ _id: target._id }, { $set: { status: 'published' } }).exec();
    console.log('\n  OK - promoted.\n');
}

async function publish(args: Args): Promise<void> {
    const apkPath = path.resolve(args.apk as string);
    if (!fs.existsSync(apkPath)) fail('No such file: ' + apkPath);

    console.log('\n  Reading ' + apkPath);
    const buffer = fs.readFileSync(apkPath);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    console.log('    ' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB   sha256 ' + sha256);

    /**
     * Check the sibling checksum file when the build produced one.
     *
     * Flutter writes `app-release.apk.sha1` beside the APK. SHA-1 is not being used as a
     * security control here — it catches the realistic failure, which is a truncated or
     * half-synced copy of a 79 MB file, before that copy is uploaded and declared current.
     */
    const sidecars: Array<[string, string]> = [['.sha1', sha1], ['.sha256', sha256]];
    for (const [ext, actual] of sidecars) {
        const sidecar = apkPath + ext;
        if (!fs.existsSync(sidecar)) continue;
        const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase();
        if (expected !== actual) {
            fail(
                path.basename(sidecar) + ' does not match the file.\n'
                + '      expected ' + expected + '\n'
                + '      actual   ' + actual + '\n'
                + '      The APK is corrupt or the checksum is stale. Rebuild before publishing.',
            );
        }
        console.log('    OK - matches ' + path.basename(sidecar));
    }

    // ── Metadata ────────────────────────────────────────────────────────────
    const badging = readBadging(apkPath);
    if (!badging) {
        fail(
            'Could not read the APK manifest - `aapt2` was not found in any Android SDK\n'
            + '      build-tools directory (looked under ANDROID_HOME, ANDROID_SDK_ROOT and the\n'
            + '      platform default). Publish from a machine with the SDK installed, or set\n'
            + '      ANDROID_HOME.',
        );
    }
    console.log('\n  ' + badging.packageId);
    console.log('    version   ' + badging.versionName + ' (versionCode ' + badging.versionCode + ')');
    console.log('    minSdk    ' + (badging.minSdk ?? '(unknown)'));

    // ── Signing ─────────────────────────────────────────────────────────────
    const signing = readSigning(apkPath);
    if (!signing) {
        console.log('\n  ! `apksigner` not found - the signing certificate could not be recorded');
        console.log('    and THE DEBUG-KEY REFUSAL BELOW DID NOT RUN. Publishing a debug-signed');
        console.log('    build means every device that installs it must uninstall before it can');
        console.log('    take a Play-signed update. Verify by hand before continuing.');
    } else {
        console.log('\n  Signed by  ' + signing.subject);
        console.log('    schemes   ' + (signing.schemes || '(none reported)'));
        console.log('    cert      SHA-256 ' + signing.certSha256);
        if (DEBUG_CERT_MARKERS.every((marker) => signing.subject.includes(marker))) {
            fail(
                'This APK is signed with the ANDROID DEBUG KEY.\n'
                + '      `android/app/build.gradle.kts` falls back to it when `key.properties` is\n'
                + '      missing, so this is a build made on a machine without the keystore.\n'
                + '      Publishing it would mean every device that installs it has to UNINSTALL\n'
                + '      before it can take a properly signed update. Rebuild with the upload key.',
            );
        }
    }

    // ── Refuse a duplicate BEFORE uploading 79 MB ───────────────────────────
    const clash = await AppReleaseModel
        .findOne({ app: args.app, versionCode: badging.versionCode, deletedAt: null })
        .exec();
    if (clash) {
        fail(
            args.app + ' already has versionCode ' + badging.versionCode + ' (' + clash.versionName
            + ', published ' + clash.publishedAt.toISOString().slice(0, 10) + ').\n'
            + '      Bump `version:` in pubspec.yaml and rebuild - Android identifies a build by\n'
            + '      versionCode, and two artefacts sharing one are indistinguishable to a phone.\n'
            + '      To make that existing row current again:\n'
            + '        npm run app:publish -- --promote ' + badging.versionCode,
        );
    }

    const current = await AppReleaseModel
        .findOne({ app: args.app, status: 'published', deletedAt: null })
        .sort({ versionCode: -1 })
        .exec();
    if (current && current.versionCode >= badging.versionCode) {
        fail(
            'The published build is ' + current.versionName + '+' + current.versionCode + ', which\n'
            + '      is not LOWER than this one (' + badging.versionName + '+' + badging.versionCode
            + '). Android refuses to install a build whose\n'
            + '      versionCode does not increase, so every agent who already has the app would be\n'
            + '      unable to take this update.',
        );
    }

    const fileName = 'wi-' + args.app.replace(/-android$/, '') + '-' + badging.versionName + '.apk';

    console.log('\n  Storage provider: ' + getStorageProviderType());
    console.log('    folder    ' + APP_RELEASE_STORAGE_FOLDER + '/  (public tree)');
    console.log('    filename  ' + fileName);

    if (args.dryRun) {
        console.log('\n  DRY RUN - every check above ran. Nothing uploaded, nothing written.\n');
        return;
    }

    // ── Upload, then record ─────────────────────────────────────────────────
    console.log('\n  Uploading...');
    const stored = await getStorageProvider().put(buffer, {
        mimeType: APK_MIME_TYPE,
        folder: APP_RELEASE_STORAGE_FOLDER,
        filename: fileName,
    });
    console.log('    OK - ' + stored.key);

    /**
     * ⚠ The upload is already done by the time this runs, and it is NOT rolled back if the
     * write below fails. An object with no row is unreachable — nothing can name its key — but
     * it is still billable storage, so the key is printed above and can be deleted by hand. A
     * transaction spanning object storage and Mongo does not exist; ordering it this way at
     * least makes the failure an orphaned object rather than a row pointing at bytes that were
     * never written.
     */
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await AppReleaseModel.updateMany(
                { app: args.app, status: 'published', deletedAt: null },
                { $set: { status: 'superseded' } },
                { session },
            ).exec();
            // ⚠ ARRAY form. `create(doc, { session })` treats the options object as a SECOND
            // document and writes outside the transaction — see the repository's note.
            await AppReleaseModel.create([{
                app: args.app,
                platform: 'android' as const,
                versionName: badging.versionName,
                versionCode: badging.versionCode,
                packageId: badging.packageId,
                minSdk: badging.minSdk,
                storageKey: stored.key,
                fileName,
                sizeBytes: buffer.length,
                sha256,
                signingCertSha256: signing ? signing.certSha256 : null,
                releaseNotes: args.notes,
                status: 'published' as const,
                publishedAt: new Date(),
            }], { session });
        });
    } finally {
        await session.endSession();
    }

    const base = (process.env.API_PUBLIC_URL || 'http://localhost:8022').replace(/\/+$/, '');
    console.log('\n  OK - published.\n');
    console.log('    download   ' + base + '/api/public/app/' + args.app + '/download');
    console.log('    metadata   ' + base + '/api/public/app/' + args.app + '/latest');
    console.log('    artefact   ' + getStorageProvider().getPublicUrl(stored.key));
    console.log('');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    if (!args.list && args.promote === null && !args.apk) {
        fail('Nothing to do. Pass --apk <path>, or --promote <versionCode>, or --list.');
    }
    if (args.promote !== null && !Number.isInteger(args.promote)) {
        fail('--promote takes an integer versionCode.');
    }

    await mongoose.connect(MONGO_URI);
    try {
        if (args.list) return await listReleases(args.app);
        if (args.promote !== null) return await promote(args.app, args.promote, args.dryRun);
        return await publish(args);
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\n  x ' + (error?.message ?? error) + '\n');
        process.exit(1);
    });
}
