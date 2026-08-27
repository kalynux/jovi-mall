/**
 * Upload folder-routing tests (no DB needed).
 *
 * The reported bug: the general intake route `POST /api/files/upload` labelled
 * every upload `folder: 'products'`, so the products folder's vendor-only
 * permission rule rejected agency/agent/customer uploads with
 * `PERMISSION_DENIED: Role 'user' cannot upload to products folder`. Uploads now
 * declare `folder: 'by-type'` and each file is stored under the folder for its
 * own sniffed media type.
 *
 * Covered here:
 *  - the media-type → folder mapping is total over MediaCategory
 *  - PermissionValidator: 'by-type' is open to every role; purpose folders keep
 *    their rules; a sniffing violation is no longer reported as a permission one
 *  - the full intake pipeline (fake storage + repository): an agency-role upload
 *    of an image and a PDF in one batch lands in images/ and documents/
 *
 * Run: npx ts-node scripts/test/test-upload-folders.ts
 */

import sharp from 'sharp';
import {
  MEDIA_CATEGORIES,
  MediaCategory,
  resolveMediaCategory,
} from '../../src/modules/catalog/domain/services/media/media-category';
import { MEDIA_CATEGORY_FOLDERS, resolveTypeFolder } from '../../src/core/uploads/media-folder';
import { PermissionValidator } from '../../src/core/uploads/validators/permission.validator';
import { UploadPipelineContextImpl } from '../../src/core/uploads/upload-pipeline-context';
import { UploadIntakeService } from '../../src/core/uploads/upload-intake.service';
import { getDefaultUploadConfig, UploadPolicyConfig } from '../../src/core/uploads/upload-config';
import {
  IUploadObserver,
  IVirusScanner,
  UploadFolderStrategy,
  UploadRequest,
  UserRole,
} from '../../src/core/uploads/upload-policy.types';
import { IStorageProvider, StoragePutOptions, StoragePutResult } from '../../src/core/storage/storage-provider.interface';
import { IFileRepository } from '../../src/modules/catalog/repositories/interfaces/file.repository.interface';
import { File } from '../../src/modules/catalog/repositories/mappers/file.mapper';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL  ${label}`);
  }
}

// ─── Test doubles ─────────────────────────────────────────────────────────────

/** Records what folder each file was written to, without touching a disk. */
class RecordingStorageProvider implements IStorageProvider {
  public readonly puts: StoragePutOptions[] = [];

  async put(buffer: Buffer, options: StoragePutOptions): Promise<StoragePutResult> {
    this.puts.push(options);
    return {
      key: `${options.folder}/2026/07/${this.puts.length}`,
      size: buffer.length,
      mimeType: options.mimeType,
      checksum: 'checksum',
    };
  }

  async delete(): Promise<void> { /* not exercised */ }
  getPublicUrl(key: string): string { return `http://test/${key}`; }
  async getDownloadStream(): Promise<NodeJS.ReadableStream> { return null as unknown as NodeJS.ReadableStream; }
  // `true` because this double impersonates the LOCAL provider (see `getProviderType`),
  // which is the one that genuinely streams. Downloads are not exercised by this suite —
  // it asserts which FOLDER an upload lands in — so the stub above is never read.
  supportsDownloadStream(): boolean { return true; }
  async getBuffer(): Promise<Buffer> { return Buffer.alloc(0); }
  getProviderType(): 'local' { return 'local'; }
}

/** Only `create` and `findByChecksum` are reached by the intake pipeline. */
function fakeFileRepository(): IFileRepository {
  const repo: Partial<IFileRepository> = {
    async create(file) {
      return { id: 'file-id', createdAt: new Date(), updatedAt: new Date(), ...file } as File;
    },
    async findByChecksum() { return null; },
  };
  return repo as IFileRepository;
}

class NoOpObserver implements IUploadObserver { }

class CleanScanner implements IVirusScanner {
  async scan(): Promise<{ clean: boolean }> { return { clean: true }; }
}

function permissionContext(folder: UploadFolderStrategy, role: UserRole, vendorId?: string) {
  const request: UploadRequest = {
    folder,
    context: { userId: 'user-1', role, vendorId },
    files: [{ buffer: Buffer.from('x'), mimeType: 'image/png' }],
  };
  return new UploadPipelineContextImpl(request);
}

async function expectPermissionDenied(
  folder: UploadFolderStrategy,
  role: UserRole,
  vendorId: string | undefined,
  label: string,
): Promise<void> {
  const validator = new PermissionValidator(getDefaultUploadConfig());
  try {
    await validator.validate(permissionContext(folder, role, vendorId));
    assert(false, `${label} (expected a denial, got none)`);
  } catch (error) {
    assert((error as { code?: string }).code === 'UPLOAD_POLICY_VIOLATION', label);
  }
}

async function expectPermissionAllowed(
  folder: UploadFolderStrategy,
  role: UserRole,
  vendorId: string | undefined,
  label: string,
): Promise<void> {
  const validator = new PermissionValidator(getDefaultUploadConfig());
  try {
    await validator.validate(permissionContext(folder, role, vendorId));
    assert(true, label);
  } catch {
    assert(false, `${label} (unexpectedly denied)`);
  }
}

async function main(): Promise<void> {
  // ─── Media-type → folder mapping ────────────────────────────────────────────

  {
    const mapped = MEDIA_CATEGORIES.filter((c: MediaCategory) => !!MEDIA_CATEGORY_FOLDERS[c]);
    assert(mapped.length === MEDIA_CATEGORIES.length, 'every MediaCategory maps to a folder');

    assert(resolveTypeFolder('image/jpeg') === 'images', 'image/jpeg → images');
    assert(resolveTypeFolder('image/webp') === 'images', 'image/webp → images');
    assert(resolveTypeFolder('video/mp4') === 'videos', 'video/mp4 → videos (matches the video route)');
    assert(resolveTypeFolder('audio/mpeg') === 'audio', 'audio/mpeg → audio');
    assert(resolveTypeFolder('application/pdf') === 'documents', 'application/pdf → documents');
    assert(resolveTypeFolder('application/zip') === 'archives', 'application/zip → archives');
    assert(resolveTypeFolder('application/octet-stream') === 'other', 'unknown type → other');
    assert(resolveTypeFolder('') === 'other', 'empty MIME type → other (no crash)');
    assert(resolveTypeFolder('IMAGE/PNG') === 'images', 'MIME matching is case-insensitive');

    // No media type derives a purpose folder — those must be asked for explicitly.
    const derivable: string[] = Object.values(MEDIA_CATEGORY_FOLDERS);
    assert(
      !['products', 'variants', 'digital', 'system', 'shipments'].some((f) => derivable.includes(f)),
      'no media type derives a purpose folder',
    );

    // Keep the in-process resolver aligned with the aggregation's taxonomy.
    assert(resolveMediaCategory('application/epub+zip') === 'document', 'epub is a document, not an archive');
  }

  // ─── PermissionValidator ────────────────────────────────────────────────────

  {
    // The reported bug, at the rule that raised it.
    await expectPermissionAllowed('by-type', 'user', undefined, "by-type: role 'user' (agency/agent/customer) may upload");
    await expectPermissionAllowed('by-type', 'vendor', undefined, 'by-type: vendor without vendorId may upload');
    await expectPermissionAllowed('by-type', 'admin', undefined, 'by-type: admin may upload');
    await expectPermissionDenied('products', 'user', undefined, "products: role 'user' still denied");

    // Purpose-folder rules are untouched.
    await expectPermissionDenied('system', 'user', undefined, 'system: non-admin still denied');
    await expectPermissionDenied('system', 'vendor', 'vendor-1', 'system: vendor still denied');
    await expectPermissionAllowed('system', 'admin', undefined, 'system: admin still allowed');
    await expectPermissionDenied('products', 'vendor', undefined, 'products: vendor without vendorId still denied');
    await expectPermissionAllowed('products', 'vendor', 'vendor-1', 'products: vendor with vendorId still allowed');
    await expectPermissionAllowed('digital', 'vendor', 'vendor-1', 'digital: vendor with vendorId still allowed');

    // A sniffing violation must not be re-labelled as a permission failure.
    const validator = new PermissionValidator(getDefaultUploadConfig());
    const context = permissionContext('by-type', 'user');
    context.addViolation({ code: 'UNDETECTABLE_TYPE', message: 'could not detect type' });
    try {
      await validator.validate(context);
      assert(true, 'a pre-existing sniffing violation is not reported as a permission denial');
    } catch {
      assert(false, 'a pre-existing sniffing violation is not reported as a permission denial');
    }
  }

  // ─── Full intake pipeline, agency ('user') role ─────────────────────────────

  {
    const config: UploadPolicyConfig = getDefaultUploadConfig();
    const storage = new RecordingStorageProvider();
    const intake = new UploadIntakeService(
      config,
      storage,
      fakeFileRepository(),
      new NoOpObserver(),
      new CleanScanner(),
    );

    // A real PNG (so sniffing + the png→webp conversion actually run) and a real PDF.
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).png().toBuffer();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

    const files = await intake.execute({
      folder: 'by-type',
      context: {
        userId: 'user-1',
        role: 'user',            // what an agency/agent/customer maps to
        ownerType: 'agency',
        ownerId: '507f1f77bcf86cd799439011',
        storageLimitBytes: 5 * 1024 * 1024 * 1024,
        currentUsageBytes: 0,    // keeps the quota check off the DB
      },
      files: [
        { buffer: png, originalName: 'magazin-logo.png', mimeType: 'image/png' },
        { buffer: pdf, originalName: 'policy.pdf', mimeType: 'application/pdf' },
      ],
    });

    assert(files.length === 2, 'agency-role batch upload succeeds (this is the reported 400)');
    assert(storage.puts.length === 2, 'both files reached storage');
    assert(storage.puts[0].folder === 'images', 'the png (converted to webp) is stored under images/');
    assert(storage.puts[0].mimeType === 'image/webp', 'the png was converted, and the folder followed the final type');
    assert(storage.puts[1].folder === 'documents', 'the pdf is stored under documents/, not products/');
    assert(
      storage.puts.every((p) => p.folder !== 'products'),
      'nothing in a general upload is filed as product media',
    );
    assert(files.every((f) => f.ownerType === 'agency'), 'the uploader is still stamped as the owner');
  }

  // ─── A purpose folder still overrides the whole request ─────────────────────

  {
    const storage = new RecordingStorageProvider();
    const intake = new UploadIntakeService(
      getDefaultUploadConfig(),
      storage,
      fakeFileRepository(),
      new NoOpObserver(),
      new CleanScanner(),
    );

    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().toBuffer();

    await intake.execute({
      folder: 'products',
      context: {
        userId: 'user-1',
        role: 'vendor',
        vendorId: '507f1f77bcf86cd799439012',
        ownerType: 'vendor',
        ownerId: '507f1f77bcf86cd799439012',
        currentUsageBytes: 0,
      },
      files: [{ buffer: png, originalName: 'front.png', mimeType: 'image/png' }],
    });

    assert(storage.puts[0].folder === 'products', "an explicit purpose folder is not overridden by the file's type");
  }

  // ─── Result ─────────────────────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
