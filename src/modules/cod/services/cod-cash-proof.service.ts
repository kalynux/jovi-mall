import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getCodCashProofUploadConfig } from '../../../core/uploads/upload-config';
import { UploadIntakeService } from '../../../core/uploads/upload-intake.service';
import { IUploadObserver } from '../../../core/uploads/upload-policy.types';
import { resolveVirusScanner } from '../../../core/uploads/scanners';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { resolveFileDetail, resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

export interface CodCashProofFileInput {
  buffer: Buffer;
  originalName?: string;
  mimeType: string;
}

/** Who is handing the cash on — and therefore who owns the proof image. */
export interface CodCashProofOwner {
  type: 'agent' | 'agency';
  id: string;
}

/** The record the proof is evidence for. One slot each. */
export type CodCashProofSubject = 'agent_deposit' | 'agency_remittance';

const PROOF_FIELD = 'cash_proof';

class NoOpUploadObserver implements IUploadObserver {}

/**
 * CodCashProofService — the one image a party attaches when it declares it has handed COD
 * cash on: an agent's deposit (to the agency or the platform) or an agency's remittance.
 *
 * The receiving side confirms a declaration by looking at money it holds; the proof is what
 * lets it look at the claim too. It is REQUIRED on a declaration and absent on a one-step
 * record, where the receiving party is recording cash already in its hand.
 *
 * ── Two steps, in this order, and the order is the point ───────────────────────
 * `store` uploads the bytes BEFORE the record exists, so a declaration that is later refused
 * leaves a File nobody references. The callers therefore validate everything they can first,
 * and `discard` the upload if the record write still fails. `attach` writes the
 * `file_references` row inside the caller's transaction, so a record and its reference commit
 * together — an unreferenced File is permanently deleted by the lonely-file sweep.
 *
 * The bytes live in the PRIVATE `cod-proofs/` tree (a receipt carries account numbers and
 * names), so `FileDetail.url` is null and the image is read through `stream`, behind the
 * owning record's own scoping.
 */
export class CodCashProofService {
  private readonly fileReferenceService: FileReferenceService;

  constructor(
    private readonly fileRepository: FileRepositoryMongo = new FileRepositoryMongo(),
    fileReferenceRepository: FileReferenceRepositoryMongo = new FileReferenceRepositoryMongo(),
    private readonly storageProvider: IStorageProvider = getStorageProvider()
  ) {
    this.fileReferenceService = new FileReferenceService(this.fileRepository, fileReferenceRepository);
  }

  /** Upload the proof image, owner-stamped. Returns the new File's id. */
  async store(file: CodCashProofFileInput, owner: CodCashProofOwner, uploaderUserId: string): Promise<string> {
    const config = getCodCashProofUploadConfig();
    const intake = new UploadIntakeService(
      config,
      this.storageProvider,
      this.fileRepository,
      new NoOpUploadObserver(),
      resolveVirusScanner(config)
    );

    const [uploaded] = await intake.execute({
      folder: 'cod-proofs',
      context: {
        userId: uploaderUserId,
        // The pipeline's role vocabulary is admin | vendor | user; ownerType carries the rest.
        role: 'user',
        ownerType: owner.type,
        ownerId: owner.id,
      },
      files: [{ buffer: file.buffer, originalName: file.originalName, mimeType: file.mimeType }],
    });

    return uploaded.id;
  }

  /** Record that `subject` uses the proof. Run inside the transaction that creates it. */
  async attach(
    fileId: string,
    owner: CodCashProofOwner,
    subject: CodCashProofSubject,
    subjectId: string,
    session?: ClientSession
  ): Promise<void> {
    await this.fileReferenceService.reconcile(
      {
        previousFileIds: [],
        nextFileIds: [fileId],
        actor: owner,
        entityType: subject,
        entityId: subjectId,
        field: PROOF_FIELD,
      },
      { session }
    );
  }

  /** The record was never written — drop the upload so it does not count against its owner. */
  async discard(fileId: string): Promise<void> {
    try {
      await this.fileRepository.softDelete(fileId);
    } catch (error) {
      console.error('[CodCashProofService] Failed to discard an unused proof upload:', error);
    }
  }

  async resolve(fileId: string | null | undefined): Promise<FileDetail | null> {
    return resolveFileDetail(fileId, this.fileRepository, this.storageProvider);
  }

  async resolveMany(fileIds: Array<string | null | undefined>): Promise<Map<string, FileDetail>> {
    return resolveFileDetails(fileIds, this.fileRepository, this.storageProvider);
  }

  /**
   * The proof's BYTES. The caller has already scoped the record to the viewer — this only
   * turns a file id into a stream, and answers 404 when there is nothing to show.
   */
  async stream(
    fileId: string | null | undefined
  ): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; size: number; filename: string }> {
    const [file] = fileId ? await this.fileRepository.findManyByIds([fileId]) : [];
    if (!file) {
      throw createAppError(ERROR_CODES.COD_PROOF_NOT_FOUND, 404);
    }
    return {
      stream: await this.storageProvider.getDownloadStream(file.key),
      mimeType: file.mimeType,
      size: file.size,
      filename: file.originalName ?? 'cash-proof',
    };
  }
}

export const codCashProofService = new CodCashProofService();
