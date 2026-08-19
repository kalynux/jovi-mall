import { UploadIntakeService } from '../../../../../core/uploads/upload-intake.service';
import { getPolicyDocumentUploadConfig } from '../../../../../core/uploads/upload-config';
import { resolveVirusScanner } from '../../../../../core/uploads/scanners';
import { NoopObserver } from '../../../../../core/uploads/observers/noop-observer';
import { getStorageProvider, IStorageProvider } from '../../../../../core/storage';
import { FileRepositoryMongo } from '../../../repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../../repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from './FileReferenceService';
import { MediaStorageService } from './MediaStorageService';
import { entitlementService } from '../../../../billing/services/entitlement.service';
import { toFileDetail } from '../../../read-models/file-detail.resolver';

export interface PolicyDocumentInput {
    buffer: Buffer;
    originalName?: string;
    mimeType: string;
}

/** The two roles that keep `policies.documents`. Both reach the identical pipeline. */
export type PolicyDocumentOwner = 'vendor' | 'agency';

/**
 * The shared upload path for vendor and agency **policy documents** — plan step 4.A.4c / 25.2.
 *
 * ── What this replaced, and why it was the last of S-2 ────────────────────────
 * Both `POST /api/{vendor,agency}/profile/policy-documents` called
 * `storageProvider.put(...)` **directly**. No virus scan, no magic-byte sniffing, no
 * fingerprint, no quota — the single gate was `file.mimetype !== 'application/pdf'`, and
 * `file.mimetype` is the **client-claimed** type. Anything at all, named `.pdf` and declared
 * `application/pdf`, was stored and handed back as a public URL that the owner then submits
 * into `policies.documents`, where their counterparties read it.
 *
 * Step 8's source scan could not see either endpoint: they construct no scanner because they
 * reach no pipeline. They were the last two of the five upload surfaces, and S-2 is not closed
 * without them.
 *
 * ── ⚠ THE TRAP: a File record without a reference is DELETED ──────────────────
 * This is why routing them through the pipeline is not a one-line change, and it is the part
 * worth reading before editing anything here.
 *
 * `UploadIntakeService` creates a `File` record. `LonelyFileDeletionService` **permanently
 * deletes** a File that has no live reference, and its own docstring is explicit that the
 * lonely clock "falls back to `createdAt` for files that were uploaded but never attached —
 * so this also reclaims abandoned uploads". Today's policy documents survive that sweep only
 * because they are *not* File records; they are loose bytes the sweep cannot see.
 *
 * So creating the record and stopping there would have traded an unscanned upload for **data
 * loss** — every vendor's policy PDFs vanishing a grace period after upload, with the URL in
 * `policies.documents` still pointing at them. Strictly worse than the defect.
 *
 * The reference is therefore written **here, at upload**, rather than when the owner submits
 * the URL back into their policies. Upload is the one moment that certainly happens; the
 * submit is a separate request the owner may never make.
 *
 * **The accepted cost, stated rather than discovered later:** a document uploaded and never
 * submitted is retained instead of reclaimed. That is a storage leak, not a loss, and it is
 * the correct direction to err. Closing it means reconciling references at policy-save time
 * (resolving each stored URL back to its File), which is a larger change than this step and
 * is not made harder by doing this first.
 */
export class PolicyDocumentUploadService {
    private readonly fileReferenceService: FileReferenceService;

    constructor(
        private readonly fileRepository: FileRepositoryMongo = new FileRepositoryMongo(),
        fileReferenceRepository: FileReferenceRepositoryMongo = new FileReferenceRepositoryMongo(),
        private readonly storageProvider: IStorageProvider = getStorageProvider(),
        private readonly mediaStorage: MediaStorageService = new MediaStorageService(),
    ) {
        this.fileReferenceService = new FileReferenceService(
            this.fileRepository,
            fileReferenceRepository,
        );
    }

    /**
     * Store 1–2 policy documents for one owner and return their public URLs.
     *
     * The return value is deliberately `string[]` — the same `{ urls }` payload both endpoints
     * have always answered with. Routing the bytes through the pipeline is invisible on the
     * wire, so no client moves for it.
     *
     * @param ownerType which profile keeps these documents. Selects the quota to meter against
     *   and the `file_reference` entity type; the pipeline itself is identical for both.
     */
    async upload(
        ownerType: PolicyDocumentOwner,
        ownerId: string,
        userId: string,
        files: PolicyDocumentInput[],
    ): Promise<string[]> {
        const config = getPolicyDocumentUploadConfig();

        // The owner's plan-driven cap and current usage, exactly as the general upload route
        // resolves them. Loaded before the pipeline because `UserQuotaValidator` reads them
        // from the request context.
        const [storageLimitBytes, currentUsageBytes] = await Promise.all([
            entitlementService.resolveMaxStorageBytes(ownerType, ownerId),
            this.mediaStorage.getUsedBytes(ownerType, ownerId),
        ]);

        const intake = new UploadIntakeService(
            config,
            this.storageProvider,
            this.fileRepository,
            new NoopObserver(),
            resolveVirusScanner(config),
        );

        const uploaded = await intake.execute({
            // A purpose folder, not `by-type`: these are policy documents, and they are public
            // by design (`core/storage/storage-trees.ts` classifies both as such, because the
            // endpoint's whole contract is handing back a URL the owner republishes).
            folder: ownerType === 'vendor' ? 'vendor-policy-documents' : 'agency-policy-documents',
            context: {
                userId,
                role: 'user',
                ownerType,
                ownerId,
                storageLimitBytes,
                currentUsageBytes,
            },
            files: files.map((file) => ({
                buffer: file.buffer,
                originalName: file.originalName,
                mimeType: file.mimeType,
            })),
        });

        // ⚠ Not optional — see the class note. Without this the sweep reclaims them as
        // abandoned uploads and the owner's policy links rot.
        await this.fileReferenceService.reconcile({
            previousFileIds: [],
            nextFileIds: uploaded.map((file) => file.id),
            actor: { type: ownerType, id: ownerId },
            entityType: ownerType,
            entityId: ownerId,
            field: 'policy_documents',
        });

        const stored = await this.fileRepository.findManyByIds(uploaded.map((file) => file.id));
        // Through `toFileDetail`, so the public/private decision is made in the one place that
        // makes it for every other file (ADR-A01 D-2). Both trees are public, so every URL is
        // a string here — the `??` is the compiler's due, not a real branch.
        return stored.map((file) => toFileDetail(file, this.storageProvider).url ?? '');
    }
}

export const policyDocumentUploadService = new PolicyDocumentUploadService();
