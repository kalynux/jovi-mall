/**
 * Cloudflare R2 provider tests — no DB, no network, no credentials.
 *
 * ── Why this suite exists ─────────────────────────────────────────────────────
 * Three properties of the R2 provider are load-bearing and NOTHING else on the platform can
 * observe them:
 *
 *   - `test:uploads` asserts the storage-tree CLASSIFICATION (which trees are private). It says
 *     nothing about whether a provider honours it.
 *   - `verify:files` proves the two services build the same URL, but needs a live jovi-mall, a
 *     live wi-admin, two databases and real R2 credentials — so it will not run on most changes.
 *   - `toFileDetail`'s guard means `getPublicUrl` is never CALLED with a private key today, so a
 *     provider that leaked one would pass every existing test.
 *
 * The single most expensive mistake available here is routing a `digital/` or `shipments/` object
 * into the PUBLIC bucket. R2 has no per-object ACL, so that object is then served by the CDN to
 * anyone holding its key, permanently, and no test in the repository would notice. That is
 * ADR-A01 D-2 reopened, and §1 below is the guard against it.
 *
 * Run: npx ts-node scripts/test/test-storage-r2.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { bucketForKey, R2StorageProvider } from '../../src/core/storage/providers/r2-storage.provider';
import { R2StorageConfig } from '../../src/core/storage/storage.config';
import {
    PUBLIC_STORAGE_TREES,
    PRIVATE_STORAGE_TREES,
} from '../../src/core/storage/storage-trees';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, label: string): void {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL  ${label}`);
    }
}

function section(title: string): void {
    console.log(`\n${title}`);
}

const CONFIG: R2StorageConfig = {
    accountId: 'acct-test',
    accessKeyId: 'key-test',
    secretAccessKey: 'secret-test',
    bucket: 'wi-mall-public',
    privateBucket: 'wi-mall-private',
    publicUrl: 'https://cdn.example.com',
};

const PROVIDER_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'core', 'storage', 'providers', 'r2-storage.provider.ts'),
    'utf8',
);

/** Strip comments, so a source scan matches CODE rather than the prose describing it. */
function code(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const PROVIDER_CODE = code(PROVIDER_SRC);

function main(): void {
    // ─── 1. The bucket split IS the mechanism ────────────────────────────────
    section('1. Bucket routing — the ADR-A01 D-2 mechanism');

    for (const tree of PRIVATE_STORAGE_TREES) {
        assert(
            bucketForKey(`${tree}/2026/09/uuid_file.pdf`, CONFIG) === CONFIG.privateBucket,
            `${tree}/ routes to the PRIVATE bucket`,
        );
    }

    // Driven off the exported array, so a public tree added next year is covered without
    // anybody remembering to extend this list.
    for (const tree of PUBLIC_STORAGE_TREES) {
        assert(
            bucketForKey(`${tree}/2026/09/uuid_file.png`, CONFIG) === CONFIG.bucket,
            `${tree}/ routes to the public bucket`,
        );
    }

    // Fails CLOSED. Wrong-but-private costs a broken thumbnail; wrong-but-public is the leak.
    assert(
        bucketForKey('some-tree-nobody-classified/2027/01/x.pdf', CONFIG) === CONFIG.privateBucket,
        'an UNCLASSIFIED tree routes to the private bucket (fails closed)',
    );
    assert(
        bucketForKey('loose-file.pdf', CONFIG) === CONFIG.privateBucket,
        'a key with no tree at all routes to the private bucket',
    );
    assert(
        bucketForKey('', CONFIG) === CONFIG.privateBucket,
        'an empty key routes to the private bucket',
    );

    // The local provider builds keys with `path.join`, so a key written on Windows carries `\`.
    // If that normalisation were missed, the same file would be private in the container and
    // PUBLIC on a developer's machine — the worst possible split.
    assert(
        bucketForKey('shipments\\2026\\08\\proof.jpg', CONFIG) === CONFIG.privateBucket,
        'a BACKSLASHED private key routes identically to its forward-slash twin',
    );
    assert(
        bucketForKey('images\\2026\\08\\photo.png', CONFIG) === CONFIG.bucket,
        'a backslashed public key routes identically too',
    );

    // ─── 2. Source scan — no way to reach a bucket except through the router ──
    section('2. Source scan — every operation routes, nothing writes an ACL');

    const bucketAssignments = PROVIDER_CODE.match(/Bucket:\s*[^,\n]+/g) ?? [];
    assert(bucketAssignments.length > 0, 'the scan found Bucket: assignments to check');
    assert(
        bucketAssignments.every((line) =>
            line.includes('bucketForKey(') || line.includes('Bucket,')),
        'every `Bucket:` is bucketForKey(...) or the pre-computed `Bucket` from put() — '
        + 'a literal this.config.bucket reaching a command IS the defect',
    );

    // R2 accepts and DISCARDS ACL. Writing one would read as a security control and be none.
    assert(!/\bACL\s*:/.test(PROVIDER_CODE), 'the provider never sets an ACL (R2 discards it)');

    // The two providers that throw 501 are the reason supportsDownloadStream() exists at all.
    assert(!/\b501\b/.test(PROVIDER_CODE), 'the provider throws no 501 — it implements the byte path');

    // The SDK default since 3.729 attaches a checksum header R2 answers with a 501 that names
    // the header rather than the cause. Removing this line breaks every upload.
    assert(
        /requestChecksumCalculation:\s*'WHEN_REQUIRED'/.test(PROVIDER_CODE),
        'the S3 client sets requestChecksumCalculation: WHEN_REQUIRED (R2 interop)',
    );

    // ─── 3. The constructor refuses a fused configuration ─────────────────────
    section('3. Constructor guards');

    let threwOnEqual = false;
    try {
        new R2StorageProvider({ ...CONFIG, privateBucket: CONFIG.bucket });
    } catch (error: any) {
        threwOnEqual = error?.code === 'CONFIG_INVALID_STORAGE_PROVIDER'
            || /same bucket|cannot be both/i.test(error?.message ?? '');
    }
    assert(threwOnEqual, 'equal public/private buckets THROW rather than silently sharing one bucket');

    let threwOnMissing = false;
    try {
        new R2StorageProvider({ ...CONFIG, privateBucket: '' });
    } catch (error: any) {
        threwOnMissing = error?.code === 'CONFIG_MISSING_STORAGE_PROVIDER'
            || /required/i.test(error?.message ?? '');
    }
    assert(threwOnMissing, 'a missing private bucket THROWS');

    // Both guards must run BEFORE the client is constructed, so a misconfiguration is a cheap
    // synchronous refusal rather than something that needs credentials to discover.
    const guardPos = PROVIDER_CODE.indexOf('privateBucket === ');
    const clientPos = PROVIDER_CODE.indexOf('new S3Client(');
    assert(
        guardPos > -1 && clientPos > -1 && guardPos < clientPos,
        'the guards appear BEFORE new S3Client(...) in the source',
    );

    // ─── 4. getPublicUrl ──────────────────────────────────────────────────────
    section('4. getPublicUrl');

    const provider = new R2StorageProvider(CONFIG);

    assert(
        provider.getPublicUrl('images/2026/09/uuid_a.png')
            === 'https://cdn.example.com/images/2026/09/uuid_a.png',
        'a public key returns exactly `${publicUrl}/${key}`',
    );
    assert(
        provider.getPublicUrl('images\\2026\\09\\uuid_a.png')
            === 'https://cdn.example.com/images/2026/09/uuid_a.png',
        'backslashes normalise to forward slashes',
    );

    let threwOnPrivateUrl = false;
    try {
        provider.getPublicUrl('digital/2026/09/uuid_ebook.pdf');
    } catch {
        threwOnPrivateUrl = true;
    }
    assert(
        threwOnPrivateUrl,
        'a PRIVATE key throws rather than returning a URL — the factory header names this exact '
        + 'method as how a provider reinstates the leak',
    );

    // No percent-encoding: the local provider does not encode, and encoding on one side alone
    // is the silent divergence verify:files exists to catch.
    assert(
        !/encodeURIComponent/.test(PROVIDER_CODE),
        'getPublicUrl does not percent-encode (wi-admin does not either)',
    );

    // ─── 5. Cross-service parity — the cheap half of verify:files § 6 ─────────
    section('5. wi-admin reproduces the same URL');

    const adminPublicUrl = path.join(
        __dirname, '..', '..', '..', 'admin', 'src', 'infra', 'storage', 'public-url.ts',
    );

    if (!fs.existsSync(adminPublicUrl)) {
        // `backend/` is not itself a repository — jovi-mall's CI checks out jovi-mall alone, so
        // wi-admin is legitimately absent there. Skip LOUDLY rather than passing silently.
        skipped += 4;
        console.log('  SKIP  wi-admin is not checked out beside this repo (4 assertions skipped)');
    } else {
        const adminSrc = fs.readFileSync(adminPublicUrl, 'utf8');
        const adminCode = code(adminSrc);

        assert(
            /REPRODUCIBLE_PROVIDERS\s*=\s*\[[^\]]*'r2'/.test(adminCode),
            "wi-admin's REPRODUCIBLE_PROVIDERS includes 'r2'",
        );
        assert(
            /STORAGE_R2_PUBLIC_URL/.test(adminCode),
            'wi-admin reads STORAGE_R2_PUBLIC_URL',
        );
        assert(
            /\$\{base\.replace\(\/\\\/\+\$\/,\s*''\)\}\/\$\{normalizedKey\}/.test(adminCode)
            || /base\.replace\([^)]*\)\}\/\$\{normalizedKey\}/.test(adminCode),
            "wi-admin's r2 branch concatenates `${base-without-trailing-slash}/${normalizedKey}`",
        );
        assert(
            !/encodeURIComponent/.test(adminCode),
            'wi-admin does not percent-encode either — the two sides must agree byte for byte',
        );
    }

    // ─── 6. Capability, and the provider stamp that was hardcoded ─────────────
    section('6. Capability and the File.provider stamp');

    assert(provider.supportsDownloadStream() === true, 'supportsDownloadStream() is true');
    assert(provider.getProviderType() === 'r2', "getProviderType() returns 'r2'");

    const fileModel = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'modules', 'catalog', 'models', 'file.model.ts'),
        'utf8',
    );
    assert(/enum:\s*\[[^\]]*'r2'/.test(fileModel), "the File model's provider enum allows 'r2'");

    // The durable guard for the bug this change fixed: UploadIntakeService stamped every row
    // 'local' from a hardcoded private helper, so under any object-storage provider the field
    // recording WHERE THE BYTES WENT was wrong on every row.
    const intake = code(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'core', 'uploads', 'upload-intake.service.ts'),
        'utf8',
    ));
    assert(
        !/return\s+'local'/.test(intake),
        "upload-intake.service.ts no longer hardcodes return 'local'",
    );
    assert(
        /provider:\s*this\.storageProvider\.getProviderType\(\)/.test(intake),
        'upload-intake.service.ts stamps the ACTIVE provider',
    );

    // ─── Result ───────────────────────────────────────────────────────────────
    console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
    if (failed > 0) {
        process.exit(1);
    }
}

main();
