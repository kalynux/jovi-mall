import * as crypto from 'crypto';
import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl as presignUrl } from '@aws-sdk/s3-request-presigner';
import { IStorageProvider, StoragePutOptions, StoragePutResult } from '../storage-provider.interface';
import { R2StorageConfig } from '../storage.config';
import { isPrivateStorageKey } from '../storage-trees';
import { createAppError } from '../../errors';
import { ERROR_CODES } from '../../error-codes';

/**
 * Cloudflare R2 Storage Provider — S3-compatible object storage.
 *
 * File structure: {folder}/{yyyy}/{mm}/{uuid}[_{name}][.ext] — byte-identical to the local and
 * firebase providers, so a key means the same thing whichever provider wrote it.
 *
 * ── Why this provider exists, and what it fixes ───────────────────────────────
 * It is the FIRST non-local provider with a real `getDownloadStream`. `firebase` and
 * `cloudinary` both throw 501 from it, which breaks the two private-file routes on this
 * platform — the digital-product download (`download-execution.service.ts`) and the
 * delivery-proof download (`delivery-proof.service.ts`), NEITHER of which guards the call with
 * `supportsDownloadStream()`. So on those providers both routes are already broken. This one
 * implements the byte path for real, and `getSignedUrl` besides.
 *
 * ── TWO BUCKETS, and that is the security mechanism (ADR-A01 D-2) ─────────────
 * ⚠ **R2 has no per-object ACL.** `PutObjectCommand({ ACL: 'public-read' })` is accepted and
 * silently discarded. An object is reachable if and only if its BUCKET carries a public binding
 * (a Cloudflare custom domain, or the r2.dev development URL). So the requirement in
 * `storage.factory.ts`'s header — that the private trees be stored with no public read
 * permission, "the object itself must be unreadable without a credential, not merely
 * un-linked" — cannot be satisfied with one bucket and a per-object flag. It is satisfied
 * structurally: every operation routes through `bucketForKey`, and the private bucket has no
 * public binding at all.
 *
 * The factory's header predicts precisely the mistake this avoids: a provider "that hands back a
 * public CDN URL — which is exactly what an object-storage provider does by default — would
 * reinstate the leak without touching either file, and without a single test failing."
 * `getPublicUrl` below therefore THROWS on a private key rather than returning a string.
 */

/**
 * The bucket a key belongs in — the single decision this provider exists to get right.
 *
 * Exported and PURE so `test:storage-r2` can assert the routing with no network, no credential
 * and no `S3Client`. Everything else in this file is I/O arranged around this one line.
 *
 * ⚠ Fails CLOSED through `isPrivateStorageKey`: an unclassified tree, a key with no tree at all,
 * and a Windows-separated key all land in the PRIVATE bucket. Wrong-but-private costs a broken
 * thumbnail; wrong-but-public is ADR-A01 D-2 reopened.
 */
export function bucketForKey(key: string, config: R2StorageConfig): string {
  return isPrivateStorageKey(key) ? config.privateBucket : config.bucket;
}

/**
 * Above this size, upload as multipart with per-part retry; below it, one `PutObject`.
 *
 * The hot path here is a sub-megabyte image from the `by-type` intake. Making every avatar pay
 * `CreateMultipartUpload` + `UploadPart` + `CompleteMultipartUpload` is three extra round trips
 * for a benefit that only exists in the tail, so the split is deliberate rather than a default.
 */
const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;

export class R2StorageProvider implements IStorageProvider {
  private readonly client: S3Client;

  constructor(private readonly config: R2StorageConfig) {
    // ── Refuse BEFORE building a client ──────────────────────────────────────
    // A fused configuration must be a boot failure, not a surprise on the first digital-product
    // upload. `config/env.ts` refuses it earlier and names the variable; this is the backstop
    // for any caller that reaches the factory without passing through that validator.
    if (!config.privateBucket) {
      throw createAppError(
        ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER,
        500,
        'STORAGE_R2_PRIVATE_BUCKET is required. R2 has no per-object ACL, so the private trees '
        + '(digital, shipments, ticket-attachments) can only be kept off a public CDN by living '
        + 'in a bucket that has no public binding.',
      );
    }
    if (config.privateBucket === config.bucket) {
      throw createAppError(
        ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER,
        500,
        `STORAGE_R2_PRIVATE_BUCKET and STORAGE_R2_BUCKET are both "${config.bucket}". One bucket `
        + 'cannot be both publicly bound and not, so every digital product and every '
        + 'delivery-proof photograph would be fetchable from the CDN by anyone holding the key '
        + '(ADR-A01 D-2).',
      );
    }

    this.client = new S3Client({
      // R2 is single-region; 'auto' is the literal string its S3 API expects.
      region: 'auto',
      // Derived, never configured — there is no endpoint variable and there must not be one.
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      /**
       * ⚠ **Load-bearing, and the failure it prevents names the wrong thing.**
       *
       * From aws-sdk-js-v3 3.729 the default became `WHEN_SUPPORTED`, which attaches
       * `x-amz-checksum-crc32` to every PutObject and UploadPart. R2 does not implement those
       * headers and answers `501 NotImplemented — Header 'x-amz-checksum-crc32' with value
       * '...' not implemented`, which reads as a bug in this code rather than as an SDK default.
       * Requesting checksums only when the operation actually requires them is Cloudflare's
       * documented interop setting. We compute our own SHA-256 below regardless.
       *
       * Do not "clean this up" — removing it breaks every upload.
       */
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 4,
      requestHandler: {
        connectionTimeout: 5_000,
        /**
         * INACTIVITY, not total elapsed — `@smithy/node-http-handler` applies this with
         * `socket.setTimeout`, which fires only after this long with NO bytes moving. A large
         * download over a slow link is therefore safe as long as it keeps flowing, while a
         * wedged socket is still released.
         */
        requestTimeout: 60_000,
      },
    });
  }

  async put(buffer: Buffer, options: StoragePutOptions): Promise<StoragePutResult> {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');

    // Generate unique filename
    const uuid = crypto.randomUUID();
    const extension = this.getExtensionFromMimeType(options.mimeType);
    const filename = options.filename
      ? `${uuid}_${this.sanitizeFilename(options.filename)}`
      : `${uuid}${extension}`;

    // ⚠ Built by hand, NEVER `path.join`: on Windows that yields backslashes, and a key whose
    // tree cannot be read is a key routed to the wrong bucket.
    const key = `${options.folder}/${year}/${month}/${filename}`;
    const isPrivate = isPrivateStorageKey(key);
    const Bucket = isPrivate ? this.config.privateBucket : this.config.bucket;

    const params = {
      Bucket,
      Key: key,
      Body: buffer,
      ContentType: options.mimeType,
      /**
       * Keys carry a uuid, so an object at a given key never changes — a year is safe, and
       * letting the CDN hold these is the point of putting one in front. Private objects are
       * served only through an authorized route and must not be cached by anything.
       *
       * ⚠ No `ACL` key. R2 accepts and discards it, so writing one would read as a security
       * control and be none. The bucket split above IS the control.
       */
      CacheControl: isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable',
      // Deliberately no `Metadata: { originalName }`: S3 user metadata must be US-ASCII, and
      // originalName is uploader-supplied UTF-8 — a French or Arabic filename would throw
      // inside the SDK before the request left the process.
    };

    try {
      if (buffer.length >= MULTIPART_THRESHOLD_BYTES) {
        // Per-part retry: a large asset failing at 99% re-sends one 8 MiB part, not the whole
        // file. `queueSize: 2` rather than the default 4 because the prod container is
        // `mem_limit: 768m` and the pipeline already holds the entire file as one Buffer
        // (`multer.memoryStorage()`), so this caps R2's ADDITIONAL footprint at ~16 MB.
        await new Upload({
          client: this.client,
          params,
          partSize: MULTIPART_THRESHOLD_BYTES,
          queueSize: 2,
          leavePartsOnError: false, // abort on failure, so no billable orphan parts accumulate
        }).done();
      } else {
        await this.client.send(new PutObjectCommand(params));
      }
    } catch (error: any) {
      throw createAppError(
        ERROR_CODES.STORAGE_UPLOAD_FAILED,
        500,
        `R2 upload failed for ${key}: ${error?.message ?? error}`,
      );
    }

    // SHA-256 hex, matching local and firebase — NOT the base64 `ChecksumSHA256` S3 speaks.
    // `upload-intake.service.ts` stores `fileContext.hash || storageResult.checksum`, and the
    // pipeline's own fingerprint is hex, so the two must agree in both format and algorithm.
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      key,
      size: buffer.length,
      mimeType: options.mimeType,
      checksum,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: bucketForKey(key, this.config),
        Key: key,
      }));
    } catch (error: any) {
      // S3 DeleteObject is already idempotent (204 for an absent key). This covers the stores
      // that are not, and keeps the contract identical to the local provider's ENOENT swallow.
      if (this.isNotFound(error)) return;
      throw createAppError(
        ERROR_CODES.STORAGE_DELETE_FAILED,
        500,
        `R2 delete failed for ${key}: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * ⚠ **PUBLIC keys only — a private key THROWS rather than returning a string.**
   *
   * `storage.factory.ts`'s header names this exact method as the way a new provider reinstates
   * the ADR-A01 D-2 leak "without touching either file, and without a single test failing". The
   * signature is `string`, so there is no `null` to return and refusing is the only expressible
   * answer — the same posture `storage-trees.ts` states for itself: refuse rather than degrade.
   *
   * The single production caller (`file-detail.resolver.ts`) guards with the SAME predicate, so
   * this throw is unreachable while that guard stands. The day somebody removes it, this is a
   * loud 500 in a test run instead of a private URL on a customer's screen.
   */
  getPublicUrl(key: string): string {
    const normalizedKey = key.replace(/\\/g, '/');
    if (isPrivateStorageKey(normalizedKey)) {
      throw createAppError(
        ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER,
        500,
        `Refusing to build a public URL for a private key (${normalizedKey}). Private trees live `
        + 'in a bucket with no public binding; serve them through their authorized route via '
        + 'getDownloadStream, or a short-lived getSignedUrl minted inside that route.',
      );
    }
    // ⚠ BYTE-IDENTICAL to wi-admin's `buildPublicUrl` r2 branch — asserted live by
    // `verify:files` § 6 and statically by `test:storage-r2` § 5. No `encodeURIComponent`:
    // sanitizeFilename leaves only [a-zA-Z0-9._-] plus the `/` separators, and the local
    // provider does not encode either. Encoding on one side alone is a silent divergence.
    return `${this.config.publicUrl}/${normalizedKey}`;
  }

  /** Real. This is R2's whole advantage over firebase and cloudinary, both of which throw here. */
  supportsDownloadStream(): boolean {
    return true;
  }

  async getDownloadStream(key: string): Promise<NodeJS.ReadableStream> {
    const body = await this.getObjectBody(key);
    /**
     * `GetObjectCommandOutput.Body` is `StreamingBlobPayloadOutputTypes` — a UNION of
     * `SdkStream<Readable>`, `SdkStream<ReadableStream>` and `SdkStream<Blob>`, because one type
     * serves both Node and the browser. Under Node with the default `node-http-handler` it is
     * always the `Readable`, so this narrows and returns the socket stream directly: no
     * buffering, no copy, and a large asset never lands in this process's heap.
     *
     * The web-stream arm is unreachable in this runtime and is kept because the TYPE admits it —
     * a bare cast would compile and then fail with `.pipe is not a function` if a future SDK
     * release changed the default handler.
     */
    if (body instanceof Readable) return body;
    return Readable.fromWeb(body as any);
  }

  async getBuffer(key: string): Promise<Buffer> {
    const body = await this.getObjectBody(key);
    // `transformToByteArray` is the SdkStream mixin the SDK attaches to every response body; it
    // collects the stream and closes it. Small files only, per the interface's contract.
    const bytes = await (body as any).transformToByteArray();
    return Buffer.from(bytes);
  }

  /**
   * A short-lived credentialed URL — SigV4 against the S3 API endpoint, never the custom domain.
   * (R2 presigned URLs do not work on custom domains, and the private bucket has none anyway.)
   * Works for either bucket.
   *
   * ⚠ Mint one INSIDE an authorized route that has already decided this caller may have these
   * bytes — never inside `getPublicUrl`, which has no idea who is asking. See the header on
   * `storage.factory.ts`.
   */
  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    // SigV4 caps a presigned lifetime at 7 days. A larger value is rejected at signing time with
    // a message about the X-Amz-Expires header rather than about the caller's argument, so clamp
    // it here where the reason is visible.
    const expiresIn = Math.min(Math.max(Math.floor(expiresInSeconds), 1), 604_800);
    return presignUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucketForKey(key, this.config), Key: key }),
      { expiresIn },
    );
  }

  /** GetObject, with the missing-object case translated once for both readers. */
  private async getObjectBody(key: string) {
    try {
      const output = await this.client.send(new GetObjectCommand({
        Bucket: bucketForKey(key, this.config),
        Key: key,
      }));
      if (!output.Body) {
        throw createAppError(ERROR_CODES.STORAGE_FILE_NOT_FOUND, 404, `File not found: ${key}`);
      }
      return output.Body;
    } catch (error: any) {
      // Already ours (the empty-body throw above) — do not rewrap it into itself.
      if (error?.statusCode === 404 && error?.code) throw error;
      if (this.isNotFound(error)) {
        throw createAppError(ERROR_CODES.STORAGE_FILE_NOT_FOUND, 404, `File not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * Missing-object detection across three spellings, on purpose.
   *
   * `GetObject` throws the modelled `NoSuchKey`; `HeadObject` throws `NotFound` with no modelled
   * shape at all; and an S3-compatible store is free to answer a bare 404 that matches neither.
   * `$metadata.httpStatusCode` is the backstop that keeps this store-agnostic — which matters,
   * because the whole point of the S3 API is that this provider also works against B2, Bunny or
   * MinIO with only an endpoint change.
   *
   * Deliberately NOT `instanceof NoSuchKey`: that binds the check to one SDK class and misses
   * the other two.
   */
  private isNotFound(error: any): boolean {
    return error?.name === 'NoSuchKey'
      || error?.name === 'NotFound'
      || error?.Code === 'NoSuchKey'
      || error?.$metadata?.httpStatusCode === 404;
  }

  /**
   * Sanitize filename to prevent directory traversal and invalid characters.
   * ⚠ Verbatim from `local-storage.provider.ts` — keys must be identical across providers.
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, '_') // replace invalid chars
      .replace(/\.+/g, '.')             // collapse multiple dots
      .replace(/^\./, '')                // remove leading dot
      .substring(0, 100);                // limit length
  }

  /**
   * Get file extension from MIME type.
   * ⚠ Verbatim from `local-storage.provider.ts` — keys must be identical across providers.
   */
  private getExtensionFromMimeType(mimeType: string): string {
    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'text/plain': '.txt',
    };

    return mimeMap[mimeType] || '';
  }

  getProviderType(): 'r2' {
    return 'r2';
  }
}
