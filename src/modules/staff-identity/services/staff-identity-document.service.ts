import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { getAdminIdentityDocumentUploadConfig } from '../../../core/uploads/upload-config';
import { UploadIntakeService } from '../../../core/uploads/upload-intake.service';
import { IUploadObserver } from '../../../core/uploads/upload-policy.types';
import { resolveVirusScanner } from '../../../core/uploads/scanners';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { toFileDetail } from '../../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';

export interface StaffIdentityFileInput {
    buffer: Buffer;
    originalName?: string;
    size: number;
    mimeType: string;
}

class NoOpUploadObserver implements IUploadObserver { }

/**
 * The storage tree every byte on this path lands in. `private` in
 * `core/storage/storage-trees.ts`, which is the ENTIRE privacy mechanism: `express.static`
 * does not serve it, `toFileDetail` answers `url: null, access: 'authorized'` for anything
 * under it, and the R2 provider routes it to the private bucket.
 */
const STAFF_IDENTITY_FOLDER = 'admin-identity';

/**
 * The one `file_references.field` this module writes — and it is deliberately ONE.
 *
 * ── Why the slot is not in this name ──────────────────────────────────────────
 * The applicant-side KYC module writes `kyc_<slot>` because it owns the slot vocabulary AND
 * the record that consumes it. Here the record lives in wi-admin's private database and this
 * service owns neither. Encoding the slot here would mean a second copy of that vocabulary in
 * a second repository, kept in step by nothing, for no gain: a reference row exists to answer
 * *"is this file in use"* — which the orphan sweep asks and nobody else — and that question
 * does not need to know whether the picture is an identity card or a front door.
 *
 * So this service learns exactly two facts about a staff member: that they uploaded a file,
 * and which administrator id it belongs to. What the file DEPICTS is wi-admin's, along with
 * their name, their identity number, their parents and their salary. That asymmetry is the
 * design — see `admin/docs/ADR-023-ADMINISTRATOR-EMPLOYEE-RECORD.md` D-4.
 */
const STAFF_IDENTITY_REFERENCE_FIELD = 'admin_identity_document';

/**
 * ─── StaffIdentityDocumentService ────────────────────────────────────────────
 *
 * The bytes half of an administrator's employment identity evidence: an identity card, the
 * selfie holding it, a photograph of their front door, a sketch of how to reach it.
 *
 * ── ⚠ THIS SERVICE HOLDS NO PERSONAL DATA, AND THAT IS THE POINT ─────────────
 * It writes a `File` row (`ownerType: 'admin'`, `ownerId` = a `wi_admin.admin_accounts._id`
 * this database can never dereference) and one `file_references` row. It stores no name, no
 * date of birth, no identity number, no address, no salary and no slot. Every one of those
 * lives in wi-admin's PRIVATE database, behind a tier-1 permission.
 *
 * The reason to split it this way rather than keep the whole record here: jovi-mall's
 * database is the SHARED one. Every vendor read, every agency read and every order read runs
 * against it, and an employee's salary sitting in it would be one bad projection away from a
 * screen it has no business on. The bytes have to be here because the storage provider is
 * here; nothing else does.
 *
 * ── The reference row is all that stands between a staff ID card and the sweep ──
 * `GET /api/internal/admin/files/orphans` lists files nothing references, and
 * `DELETE /:id/permanent` removes one unrecoverably. Without the row written below, every
 * staff identity document on the platform would appear on that list the moment it was
 * uploaded — and an administrator tidying the media library would be shown a national
 * identity card labelled "unused". Writing it is not bookkeeping; it is what stops that.
 *
 * ── Scoped by the CALLER, not by a path parameter ────────────────────────────
 * Every method takes the administrator id from `X-Actor-Id`, never from the request. There is
 * no `:adminId` anywhere on this surface and there must not be one: the only writer is the
 * administrator themselves (wi-admin's routes are self-service — a tier 1 reviewer reads this
 * evidence and never uploads it), so a path parameter would add an authorization decision
 * that has no caller and cannot be got right for free. Same rule, same reason, as the
 * applicant KYC routes.
 */
export class StaffIdentityDocumentService {
    private readonly fileRepository = new FileRepositoryMongo();
    private readonly fileReferenceRepository = new FileReferenceRepositoryMongo();
    private readonly fileReferenceService = new FileReferenceService(
        this.fileRepository,
        this.fileReferenceRepository,
    );

    private get storageProvider(): IStorageProvider {
        return getStorageProvider();
    }

    /**
     * Store one or more documents for `adminId` and return them as `FileDetail`s.
     *
     * Every returned `url` is `null` and every `access` is `'authorized'`, by construction —
     * `admin-identity` is a private tree. The caller reads the bytes back through
     * `GET /api/internal/admin/files/:id/content`, which already streams any file including a
     * private one, and which wi-admin already fronts with an audited, permissioned route.
     */
    async upload(adminId: string, files: StaffIdentityFileInput[]): Promise<FileDetail[]> {
        if (files.length === 0) {
            throw createAppError(
                ERROR_CODES.VALIDATION_ERROR,
                400,
                'Attach at least one file under the field name "documents"',
            );
        }

        const config = getAdminIdentityDocumentUploadConfig();
        const intake = new UploadIntakeService(
            config,
            this.storageProvider,
            this.fileRepository,
            new NoOpUploadObserver(),
            resolveVirusScanner(config),
        );

        const uploaded = await intake.execute({
            folder: STAFF_IDENTITY_FOLDER,
            context: {
                userId: adminId,
                /**
                 * ⚠ The pipeline's own `UserRole` is `admin | vendor | user`, and this is the
                 * one path on the platform where `'admin'` is literally true. Nothing in the
                 * pipeline reads it today (`getUserRole()` has no consumer); ownership travels
                 * on `ownerType`/`ownerId`, which is what stamps the File.
                 */
                role: 'admin',
                ownerType: 'admin',
                ownerId: adminId,
                /**
                 * Zero and zero, and never consulted: `userQuotas.enabled` is false in this
                 * config because an administrator holds no plan to charge. Passing a
                 * fabricated ceiling instead would be a number nobody chose, enforced.
                 */
                storageLimitBytes: 0,
                currentUsageBytes: 0,
            },
            files: files.map((f) => ({
                buffer: f.buffer,
                originalName: f.originalName,
                mimeType: f.mimeType,
            })),
        });

        /**
         * One reference row per file, so the orphan sweep never offers a staff identity
         * document for deletion. `previousFileIds: []` because this is always an ADD — a
         * replacement is wi-admin calling `detach` and then uploading, rather than one
         * reconcile spanning both, since only wi-admin knows which slot is being replaced and
         * whether it is single- or multi-valued.
         */
        await this.fileReferenceService.reconcile({
            previousFileIds: [],
            nextFileIds: uploaded.map((f) => f.id),
            actor: { type: 'admin', id: adminId },
            entityType: 'admin',
            entityId: adminId,
            field: STAFF_IDENTITY_REFERENCE_FIELD,
        });

        return uploaded.map((f) => toFileDetail(f, this.storageProvider));
    }

    /**
     * Drop one document: remove its reference row and soft-delete the file.
     *
     * ── Ownership is checked HERE, against the File itself ───────────────────
     * `fileId` arrives from wi-admin, which has already scoped it to the caller's own record —
     * but this service is reached by a full-privilege service token, so "the caller already
     * checked" is not a control this side may rely on. The `ownerId` comparison below is what
     * makes `DELETE /identity-documents/<somebody else's file id>` a 404 rather than a
     * deletion of another staff member's evidence.
     *
     * ⚠ **404, not 403.** A 403 would confirm the id names a real staff document belonging to
     * somebody else, which is exactly the fact this surface must not disclose.
     *
     * Soft delete, not hard: an identity document is evidence, the sweep has a grace period,
     * and the one genuinely unrecoverable route on this platform (`DELETE /:id/permanent`) is
     * tier-1 and deliberate. An administrator correcting a bad photograph should not be able
     * to destroy the record irrecoverably by doing so.
     */
    async detach(adminId: string, fileId: string): Promise<void> {
        const [file] = await this.fileRepository.findManyByIds([fileId]);
        if (!file || file.ownerType !== 'admin' || file.ownerId !== adminId) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
        }

        await this.fileReferenceService.reconcile({
            previousFileIds: [fileId],
            nextFileIds: [],
            actor: { type: 'admin', id: adminId },
            entityType: 'admin',
            entityId: adminId,
            field: STAFF_IDENTITY_REFERENCE_FIELD,
        });

        await this.fileRepository.softDelete(fileId);
    }
}

export const staffIdentityDocumentService = new StaffIdentityDocumentService();
