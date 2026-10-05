import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { treeOfKey } from '../../../core/storage/storage-trees';
import { getRefundProofUploadConfig } from '../../../core/uploads/upload-config';
import { UploadIntakeService } from '../../../core/uploads/upload-intake.service';
import { IUploadObserver } from '../../../core/uploads/upload-policy.types';
import { resolveVirusScanner } from '../../../core/uploads/scanners';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';

/**
 * RefundProofService — the bytes behind a refund's two pictures (REFUND-FLOW-PLAN § 7, R-7, R-7b):
 * the customer's message giving the number a TYPED refund is sent to, and the receipt of a refund
 * paid OUTSIDE the platform. Both carry a phone number and a personal conversation.
 *
 * ── ⚠ The tree IS the privacy mechanism ───────────────────────────────────────
 * Every byte lands in `refund-proofs/`, PRIVATE in `core/storage/storage-trees.ts`: off
 * `express.static`, `url: null` from `toFileDetail`, routed to the private bucket by the R2
 * provider. This is deliberately NOT `POST /api/files/upload` (or the admin `/files/upload`
 * twin): those write `by-type`, whose six trees are all PUBLIC. The two gateways differ in one
 * string, and that string is the whole mechanism — `test:refund-admin-api` pins it.
 *
 * ── The read is TREE-SCOPED ───────────────────────────────────────────────────
 * `stream` answers 404 for any file that is not in `refund-proofs/`, so this door cannot be
 * turned into a second, un-audited copy of `GET /api/internal/admin/files/:id/content` reaching a
 * KYC scan or a digital product. 404 rather than 403: the id names nothing this surface serves.
 *
 * ── The reference row is written at UPLOAD ────────────────────────────────────
 * `refund_requests.destination_proof_file_id` / `external_settlement.proof_file_id` are not
 * `file_references` rows, and the orphan sweep deletes an unreferenced File. So — the
 * policy-document and staff-identity precedent — one reference row is written when the file is
 * stored (`entityType: 'admin'`, the uploading administrator, field `refund_proof`). The accepted
 * cost is the same as theirs: a proof uploaded and never used on a request is retained rather
 * than swept. Losing a proof that a completed refund points at is the worse failure.
 */

export interface RefundProofFileInput {
  buffer: Buffer;
  originalName?: string;
  size: number;
  mimeType: string;
}

/** The ONE storage tree this service writes and reads. */
export const REFUND_PROOF_FOLDER = 'refund-proofs';
/** The `file_references.field` written at upload. */
export const REFUND_PROOF_REFERENCE_FIELD = 'refund_proof';

class NoOpUploadObserver implements IUploadObserver {}

export class RefundProofService {
  private readonly fileRepository = new FileRepositoryMongo();
  private readonly fileReferenceService = new FileReferenceService(
    this.fileRepository,
    new FileReferenceRepositoryMongo()
  );

  private get storageProvider(): IStorageProvider {
    return getStorageProvider();
  }

  /** Store ONE proof for the calling administrator. Returns the new File's id. */
  async upload(adminId: string, file: RefundProofFileInput): Promise<{ fileId: string }> {
    const config = getRefundProofUploadConfig();
    const intake = new UploadIntakeService(
      config,
      this.storageProvider,
      this.fileRepository,
      new NoOpUploadObserver(),
      resolveVirusScanner(config)
    );

    const [uploaded] = await intake.execute({
      folder: REFUND_PROOF_FOLDER,
      context: {
        userId: adminId,
        role: 'admin',
        ownerType: 'admin',
        ownerId: adminId,
        // Quotas are OFF in this config — an administrator holds no plan to charge.
        storageLimitBytes: 0,
        currentUsageBytes: 0,
      },
      files: [{ buffer: file.buffer, originalName: file.originalName, mimeType: file.mimeType }],
    });

    await this.fileReferenceService.reconcile({
      previousFileIds: [],
      nextFileIds: [uploaded.id],
      actor: { type: 'admin', id: adminId },
      entityType: 'admin',
      entityId: adminId,
      field: REFUND_PROOF_REFERENCE_FIELD,
    });

    return { fileId: uploaded.id };
  }

  /** Is `fileId` a live file in the `refund-proofs/` tree? */
  async isRefundProof(fileId: string | null | undefined): Promise<boolean> {
    if (!fileId) return false;
    const [file] = await this.fileRepository.findManyByIds([fileId]);
    return Boolean(file && isRefundProofKey(file.key));
  }

  /**
   * The proof's BYTES. ⚠ Refuses (404) any file outside `refund-proofs/` — see the header.
   * Asks the provider whether it can stream BEFORE the lookup, like `/files/:id/content`.
   */
  async stream(fileId: string): Promise<{
    stream: NodeJS.ReadableStream;
    mimeType: string;
    size: number;
    filename: string;
  }> {
    const storage = this.storageProvider;
    if (!storage.supportsDownloadStream()) {
      throw createAppError(
        ERROR_CODES.STORAGE_DOWNLOAD_NOT_SUPPORTED,
        409,
        `The configured storage provider (${storage.getProviderType()}) cannot serve file contents`,
        { provider: storage.getProviderType() }
      );
    }
    const [file] = await this.fileRepository.findManyByIds([fileId]);
    if (!file || !isRefundProofKey(file.key)) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'Refund proof not found');
    }
    return {
      stream: await storage.getDownloadStream(file.key),
      mimeType: file.mimeType,
      size: file.size,
      filename: file.originalName ?? 'refund-proof',
    };
  }
}

/** Pure: does this storage key belong to the `refund-proofs/` tree? (Windows keys included.) */
export function isRefundProofKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && treeOfKey(key) === REFUND_PROOF_FOLDER;
}

export const refundProofService = new RefundProofService();
