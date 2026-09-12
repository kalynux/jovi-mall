/**
 * One-off: copy the local storage volume into the two Cloudflare R2 buckets.
 *
 * ── Why this has to run BEFORE `STORAGE_PROVIDER=r2` ──────────────────────────
 * `toFileDetail` resolves every file through the **active** provider, never through the row's
 * own `provider` field (`catalog/read-models/file-detail.resolver.ts`, and wi-admin copies the
 * behaviour deliberately — see `admin/src/infra/storage/public-url.ts`). So the moment the
 * variable flips, every historical row is looked up in R2:
 *
 *   - every product image and avatar 404s on the CDN;
 *   - every paid digital product's download 404s;
 *   - every delivery-proof photograph 404s.
 *
 * Nothing warns. The files are still on the volume, and the volume stays mounted as the
 * rollback — but until they are in R2 under the SAME keys, the platform behaves as though they
 * were deleted.
 *
 * ── Why a Node script rather than rclone ──────────────────────────────────────
 * It imports `bucketForKey` from the provider itself, so it CANNOT disagree with the running
 * application about which bucket a key belongs in. An `rclone` invocation restates that routing
 * in a shell loop, and a restated rule is a rule that drifts — putting one `digital/` object in
 * the public bucket is ADR-A01 D-2 reopened for that object, permanently and silently.
 *
 * ── Why it is NOT a `migrate:*` binding ───────────────────────────────────────
 * `scripts/migrate.ts` keeps a CLOSED registry: `assertRegistryCovers()` fails if any
 * `migrate:*` / `backfill:*` script in package.json has no row in `MIGRATIONS`. This one is
 * deliberately named `storage:migrate-r2` so it stays out of that set — it touches no
 * collection, writes no `schema_migrations` row, and must run at a chosen moment in the
 * cutover rather than as part of `migrate:up`. Putting it in the ledger would make every
 * deploy copy the whole storage volume as a side effect.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   npm run storage:migrate-r2 -- --dry-run     # plan + per-tree counts, writes nothing
 *   npm run storage:migrate-r2                  # do it; re-runnable, skips what is present
 *
 * Re-runnable by construction: every object is HEADed first and skipped if it already exists,
 * so an interrupted run is resumed by running it again.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { bucketForKey } from '../src/core/storage/providers/r2-storage.provider';
import { isPrivateStorageKey, treeOfKey } from '../src/core/storage/storage-trees';
import { R2StorageConfig } from '../src/core/storage/storage.config';

const DRY_RUN = process.argv.includes('--dry-run');
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Extension → MIME, the inverse of the provider's map. Anything else uploads as octet-stream. */
const MIME_BY_EXTENSION: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.txt': 'text/plain',
};

function loadConfig(): R2StorageConfig {
    const required = [
        'STORAGE_R2_ACCOUNT_ID', 'STORAGE_R2_ACCESS_KEY_ID', 'STORAGE_R2_SECRET_ACCESS_KEY',
        'STORAGE_R2_BUCKET', 'STORAGE_R2_PRIVATE_BUCKET',
    ];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
        console.error(`✖ Missing: ${missing.join(', ')}`);
        console.error('  This script reads jovi-mall/.env directly and does not need');
        console.error('  STORAGE_PROVIDER=r2 — run it BEFORE the flip, not after.');
        process.exit(1);
    }

    const config: R2StorageConfig = {
        accountId: process.env.STORAGE_R2_ACCOUNT_ID!,
        accessKeyId: process.env.STORAGE_R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.STORAGE_R2_SECRET_ACCESS_KEY!,
        bucket: process.env.STORAGE_R2_BUCKET!,
        privateBucket: process.env.STORAGE_R2_PRIVATE_BUCKET!,
        publicUrl: (process.env.STORAGE_R2_PUBLIC_URL || '').replace(/\/+$/, ''),
    };

    // The same guard the provider and the boot validator apply. One bucket for both trees would
    // copy every digital product and delivery-proof photo onto the public CDN — and unlike a
    // misconfigured runtime, a migration does it once and leaves it there.
    if (config.bucket === config.privateBucket) {
        console.error(`✖ STORAGE_R2_BUCKET and STORAGE_R2_PRIVATE_BUCKET are both "${config.bucket}".`);
        console.error('  R2 has no per-object ACL, so one bucket cannot be both public and not.');
        console.error('  Refusing to migrate: this would put every digital/ and shipments/ object');
        console.error('  on the public CDN permanently (ADR-A01 D-2).');
        process.exit(1);
    }
    return config;
}

/** Every file under `root`, as keys relative to it with forward slashes. */
function collectKeys(root: string): string[] {
    const keys: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) keys.push(path.relative(root, full).replace(/\\/g, '/'));
        }
    };
    if (fs.existsSync(root)) walk(root);
    return keys.sort();
}

async function main(): Promise<void> {
    const config = loadConfig();
    const root = path.resolve(process.env.STORAGE_LOCAL_PATH || './storage');

    console.log(`\n  Source : ${root}`);
    console.log(`  Public : ${config.bucket}`);
    console.log(`  Private: ${config.privateBucket}`);
    console.log(`  Mode   : ${DRY_RUN ? 'DRY RUN — nothing is written' : 'LIVE'}\n`);

    const keys = collectKeys(root);
    if (keys.length === 0) {
        console.log(`  Nothing to migrate — no files under ${root}.`);
        return;
    }

    // Per-tree plan first, so an operator sees the public/private split BEFORE any bytes move.
    // This is the table to check against the dashboard afterwards.
    const byTree = new Map<string, { count: number; bytes: number; private: boolean }>();
    for (const key of keys) {
        const tree = treeOfKey(key) ?? '(no tree)';
        const stat = fs.statSync(path.join(root, key));
        const row = byTree.get(tree) ?? { count: 0, bytes: 0, private: isPrivateStorageKey(key) };
        row.count += 1;
        row.bytes += stat.size;
        byTree.set(tree, row);
    }

    console.log('  tree                        files        size  → bucket');
    console.log('  ' + '─'.repeat(66));
    for (const [tree, row] of [...byTree.entries()].sort()) {
        const bucket = row.private ? config.privateBucket : config.bucket;
        const mb = (row.bytes / (1024 * 1024)).toFixed(1) + ' MB';
        console.log(
            `  ${tree.padEnd(26)} ${String(row.count).padStart(5)} ${mb.padStart(11)}  → ${bucket}`
            + (row.private ? '   [PRIVATE]' : ''),
        );
    }
    console.log('  ' + '─'.repeat(66));
    console.log(`  ${String(keys.length).padStart(32)} files total\n`);

    if (DRY_RUN) {
        console.log('  Dry run — nothing written. Re-run without --dry-run to migrate.\n');
        return;
    }

    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
        // ⚠ Same reason as the provider: from aws-sdk-js-v3 3.729 the default attaches
        // `x-amz-checksum-crc32`, which R2 answers with a 501 naming the header rather than the
        // cause. Without these two lines every upload in this script fails.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 4,
    });

    let uploaded = 0;
    let skipped = 0;
    const failures: { key: string; reason: string }[] = [];

    for (const [index, key] of keys.entries()) {
        const bucket = bucketForKey(key, config);
        const isPrivate = isPrivateStorageKey(key);
        const progress = `[${String(index + 1).padStart(String(keys.length).length)}/${keys.length}]`;

        try {
            // Re-runnable: an object already there is left alone rather than re-sent.
            try {
                await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
                skipped += 1;
                console.log(`  ${progress} skip    ${key}`);
                continue;
            } catch (error: any) {
                const status = error?.$metadata?.httpStatusCode;
                if (status !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchKey') {
                    throw error;   // a real failure (403, network) — do not mistake it for absent
                }
            }

            const body = fs.readFileSync(path.join(root, key));
            const extension = path.extname(key).toLowerCase();
            const params = {
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentType: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
                // Identical to the provider's, so a migrated object is indistinguishable from a
                // freshly uploaded one.
                CacheControl: isPrivate
                    ? 'private, no-store'
                    : 'public, max-age=31536000, immutable',
            };

            if (body.length >= MULTIPART_THRESHOLD_BYTES) {
                await new Upload({
                    client,
                    params,
                    partSize: MULTIPART_THRESHOLD_BYTES,
                    queueSize: 2,
                    leavePartsOnError: false,
                }).done();
            } else {
                await client.send(new PutObjectCommand(params));
            }

            uploaded += 1;
            console.log(`  ${progress} copied  ${key}${isPrivate ? '   [PRIVATE]' : ''}`);
        } catch (error: any) {
            const reason = error?.message ?? String(error);
            failures.push({ key, reason });
            console.error(`  ${progress} FAILED  ${key} — ${reason}`);
        }
    }

    console.log(`\n  copied ${uploaded} · skipped ${skipped} · failed ${failures.length}\n`);

    if (failures.length > 0) {
        console.error('  Failures (re-run to retry — copied objects are skipped):');
        for (const { key, reason } of failures) console.error(`    ${key} — ${reason}`);
        console.error('');
        process.exit(1);
    }

    console.log('  Done. Before flipping STORAGE_PROVIDER=r2 on BOTH services, confirm in the');
    console.log('  Cloudflare dashboard that the PRIVATE bucket has no custom domain and that');
    console.log('  its r2.dev development URL is disabled. No code can check that.\n');
}

// The migration-ledger convention: importable without running.
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
