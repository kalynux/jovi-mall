import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { getKycDocumentUploadConfig } from '../../../core/uploads/upload-config';
import { UploadIntakeService } from '../../../core/uploads/upload-intake.service';
import { IUploadObserver } from '../../../core/uploads/upload-policy.types';
import { resolveVirusScanner } from '../../../core/uploads/scanners';
import { toGeoAddress } from '../../../core/types/geo-address.types';
import {
    KYC_DOCUMENT_SLOTS,
    KYC_MULTI_SLOT_MAX_FILES,
    KycDocumentSlot,
    kycReferenceField,
    kycSlotField,
} from '../../../core/types/kyc-documents.types';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { mediaStorageService } from '../../catalog/domain/services/media/MediaStorageService';
import { entitlementService } from '../../billing/services/entitlement.service';
import { AgencyMagazinModel } from '../../magazin/models/magazin.model';
import { KycRole, KycSubject, kycSubjectFor } from '../domain/kyc-subject';
import { UpdateKycDetailsInput } from '../validators/kyc.validator';
import {
    KycAddressDto,
    KycDocumentsDto,
    KycDto,
    KYC_LIMITS,
    toKycAddressDto,
} from '../dto/kyc.dto';

export interface KycFileInput {
    buffer: Buffer;
    originalName?: string;
    size: number;
    mimeType: string;
}

class NoOpUploadObserver implements IUploadObserver {}

/**
 * ─── KycSubmissionService ────────────────────────────────────────────────────
 *
 * The applicant's half of identity verification, for all three roles, through one
 * implementation. What each role has and where it keeps it is `domain/kyc-subject.ts`; this
 * service is otherwise role-blind.
 *
 * ── ⚠ IT GRADES NOTHING ──────────────────────────────────────────────────────
 * There is no completeness check anywhere in this file, and `submit()` in particular
 * accepts an entirely empty record. That is the decision, not an omission — the
 * required/optional split lives in the administration dashboard, which turns it into the
 * estimated-verdict badge and a pre-populated rejection reason. See
 * `core/types/kyc-documents.types.ts`.
 *
 * What it DOES enforce is two things a client cannot be trusted with:
 *
 *   **the lock** — a record under review or already verified refuses every write. The second
 *   half is the load-bearing one: without it an approved applicant swaps the identity card an
 *   administrator approved for somebody else's and keeps the verdict.
 *
 *   **the slot vocabulary** — an unknown slot is a 400 naming the role's own list, never a
 *   silent no-op. A write that reports success having stored nothing is the hardest failure
 *   there is to diagnose from a client.
 */
export class KycSubmissionService {
    private readonly fileReferenceService: FileReferenceService;

    constructor(
        private readonly fileRepository: FileRepositoryMongo = new FileRepositoryMongo(),
        fileReferenceRepository: FileReferenceRepositoryMongo = new FileReferenceRepositoryMongo(),
        private readonly storageProvider: IStorageProvider = getStorageProvider(),
    ) {
        this.fileReferenceService = new FileReferenceService(
            this.fileRepository,
            fileReferenceRepository,
        );
    }

    // ── Reads ─────────────────────────────────────────────────────────────────

    /** The applicant's own submission. */
    async get(role: KycRole, entityId: string): Promise<KycDto> {
        const subject = kycSubjectFor(role);
        const doc = await this.loadDocument(subject, entityId);
        return this.buildDto(subject, doc, { includeReview: false });
    }

    /**
     * The reviewer's copy — the same record plus the addresses already on the account and the
     * verdict's provenance.
     *
     * ⚠ **Exposed to wi-admin through a jovi-mall INTERNAL route rather than read directly**,
     * which is a deliberate exception to ADR-004 D-2's "read a record directly, delegate only
     * a verdict". Two things make it one: an agency's business addresses live on the
     * **Magazin**, a second collection wi-admin would have to learn to join, and every
     * document has to pass through `toFileDetail` so the private-tree rule is applied by the
     * service that owns the rule. A second copy of either is how a private file's URL gets
     * published — the failure `admin/src/infra/storage/storage-trees.ts` exists to prevent.
     */
    async getForReview(role: KycRole, entityId: string): Promise<KycDto> {
        const subject = kycSubjectFor(role);
        const doc = await this.loadDocument(subject, entityId);
        return this.buildDto(subject, doc, { includeReview: true });
    }

    // ── Writes ────────────────────────────────────────────────────────────────

    /** Set or clear the identity number and the geocoded home address. */
    async updateDetails(
        role: KycRole,
        entityId: string,
        input: UpdateKycDetailsInput,
    ): Promise<KycDto> {
        const subject = kycSubjectFor(role);
        const doc = await this.loadDocument(subject, entityId);
        this.assertUnlocked(subject, doc);

        const set: Record<string, unknown> = {};

        if (input.idNumber !== undefined) {
            set[subject.idNumberPath] = input.idNumber ?? null;
        }
        if (input.homeAddress !== undefined) {
            set[`${subject.path}.home_address`] =
                input.homeAddress ? toGeoAddress(input.homeAddress) : null;
        }

        if (Object.keys(set).length > 0) {
            await subject.model.updateOne({ _id: entityId }, { $set: set });
        }

        return this.get(role, entityId);
    }

    /**
     * Attach one or more documents to a slot.
     *
     * A **single** slot replaces: the previous file is detached and soft-deleted, so the
     * applicant's storage drops immediately rather than waiting for the lonely-file sweep,
     * and a reviewer is never shown two fronts of one identity card and asked which is
     * current. A **multi** slot appends, refusing at {@link KYC_MULTI_SLOT_MAX_FILES}.
     *
     * ⚠ The cap is checked against the CURRENT contents plus this request, before anything is
     * uploaded. Checking afterwards would leave the rejected bytes on disk, counted against
     * the applicant's quota, referenced by nothing, and reachable only by the lonely-file
     * sweep — a refusal that costs the person storage.
     */
    async attach(
        role: KycRole,
        entityId: string,
        slot: KycDocumentSlot,
        files: KycFileInput[],
    ): Promise<KycDto> {
        const subject = kycSubjectFor(role);
        this.assertSlotAllowed(subject, slot);

        const doc = await this.loadDocument(subject, entityId);
        this.assertUnlocked(subject, doc);

        const multi = KYC_DOCUMENT_SLOTS[slot] === 'multi';
        const previous = this.readSlot(subject, doc, slot);

        if (multi && previous.length + files.length > KYC_MULTI_SLOT_MAX_FILES) {
            throw createAppError(
                ERROR_CODES.KYC_SLOT_FULL,
                422,
                `This slot holds at most ${KYC_MULTI_SLOT_MAX_FILES} files`,
                { slot, max: KYC_MULTI_SLOT_MAX_FILES, current: previous.length, offered: files.length },
            );
        }
        if (!multi && files.length > 1) {
            throw createAppError(
                ERROR_CODES.KYC_SLOT_FULL,
                422,
                'This slot holds exactly one file',
                { slot, max: 1, current: previous.length, offered: files.length },
            );
        }

        const uploaded = await this.upload(subject, entityId, files);
        const uploadedIds = uploaded.map((f) => f.id);
        const next = multi ? [...previous, ...uploadedIds] : uploadedIds;

        await this.fileReferenceService.reconcile({
            previousFileIds: previous,
            nextFileIds: next,
            actor: { type: subject.ownerType as 'vendor' | 'agency' | 'agent', id: entityId },
            entityType: subject.entityType,
            entityId,
            field: kycReferenceField(slot),
        });

        await subject.model.updateOne(
            { _id: entityId },
            { $set: { [`${subject.path}.${kycSlotField(slot)}`]: multi ? next : next[0] ?? null } },
        );

        // Replacing a single-value slot: the displaced file is nobody's now, and an identity
        // document is not something to leave lying in the grace period.
        if (!multi) {
            for (const stale of previous.filter((id) => !next.includes(id))) {
                await this.fileRepository.softDelete(stale);
            }
        }

        return this.get(role, entityId);
    }

    /** Remove one document from a slot. */
    async detach(
        role: KycRole,
        entityId: string,
        slot: KycDocumentSlot,
        fileId: string,
    ): Promise<KycDto> {
        const subject = kycSubjectFor(role);
        this.assertSlotAllowed(subject, slot);

        const doc = await this.loadDocument(subject, entityId);
        this.assertUnlocked(subject, doc);

        const previous = this.readSlot(subject, doc, slot);
        if (!previous.includes(fileId)) {
            throw createAppError(
                ERROR_CODES.KYC_DOCUMENT_NOT_FOUND,
                404,
                'That document is not attached to this slot',
                { slot, fileId },
            );
        }

        const multi = KYC_DOCUMENT_SLOTS[slot] === 'multi';
        const next = previous.filter((id) => id !== fileId);

        await this.fileReferenceService.reconcile({
            previousFileIds: previous,
            nextFileIds: next,
            actor: { type: subject.ownerType as 'vendor' | 'agency' | 'agent', id: entityId },
            entityType: subject.entityType,
            entityId,
            field: kycReferenceField(slot),
        });

        await subject.model.updateOne(
            { _id: entityId },
            { $set: { [`${subject.path}.${kycSlotField(slot)}`]: multi ? next : null } },
        );
        await this.fileRepository.softDelete(fileId);

        return this.get(role, entityId);
    }

    /**
     * Hand the record to the reviewers.
     *
     * Stamps `submitted_at` and — for an agent, whose enum has a distinct draft value — moves
     * `unverified` to `pending`. A vendor and an agency are already `pending`, which is why
     * the timestamp rather than the status is what "under review" is read from everywhere.
     *
     * ⚠ **No completeness check**, deliberately (see the class header). ⚠ Nor does it re-open
     * a `verified` record: `assertUnlocked` refuses that, so re-verification is an
     * administrator's act rather than something an applicant can trigger by pressing a button
     * twice.
     */
    async submit(role: KycRole, entityId: string): Promise<KycDto> {
        const subject = kycSubjectFor(role);
        const doc = await this.loadDocument(subject, entityId);
        this.assertUnlocked(subject, doc);

        const set: Record<string, unknown> = { [`${subject.path}.submitted_at`]: new Date() };
        if (role === 'agent') {
            set[`${subject.path}.status`] = 'pending';
        }
        // A resubmission after a rejection: the old reason describes documents that have been
        // replaced, and leaving it would show the applicant a refusal of work they have
        // already redone. The VERDICT stays `rejected` until a reviewer moves it — this
        // service must not promote its own record.
        set[`${subject.path}.rejection_reason`] = null;

        await subject.model.updateOne({ _id: entityId }, { $set: set });
        return this.get(role, entityId);
    }

    /**
     * Stream one of the applicant's OWN documents back to them.
     *
     * The `kyc/` tree is off `express.static`, so `FileDetail.url` is null and this is the
     * only door the applicant has. The authorization is ownership of the record: the file id
     * must appear in one of this account's own slots, which is checked against the document
     * rather than against `File.ownerId` — the two agree today, and checking the slot means
     * the answer stays right if a file is ever uploaded on somebody's behalf.
     */
    async streamOwnDocument(
        role: KycRole,
        entityId: string,
        fileId: string,
    ): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; size: number; filename: string }> {
        const subject = kycSubjectFor(role);
        const doc = await this.loadDocument(subject, entityId);

        const owned = subject.slots.some((slot) => this.readSlot(subject, doc, slot).includes(fileId));
        if (!owned) {
            throw createAppError(
                ERROR_CODES.KYC_DOCUMENT_NOT_FOUND,
                404,
                'That document is not part of your verification record',
                { fileId },
            );
        }

        if (!this.storageProvider.supportsDownloadStream()) {
            throw createAppError(
                ERROR_CODES.STORAGE_DOWNLOAD_NOT_SUPPORTED,
                409,
                `The configured storage provider (${this.storageProvider.getProviderType()}) cannot serve file contents`,
                { provider: this.storageProvider.getProviderType() },
            );
        }

        const [file] = await this.fileRepository.findManyByIds([fileId]);
        if (!file) {
            // The reference outlived the file. Same answer as "not yours": there is nothing
            // to serve, and the distinction is not the applicant's to act on.
            throw createAppError(ERROR_CODES.KYC_DOCUMENT_NOT_FOUND, 404, 'Document not found', { fileId });
        }

        return {
            stream: await this.storageProvider.getDownloadStream(file.key),
            mimeType: file.mimeType,
            size: file.size,
            filename: file.originalName ?? 'document',
        };
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private async loadDocument(subject: KycSubject, entityId: string): Promise<any> {
        const doc = await subject.model.findById(entityId).lean();
        if (!doc) {
            throw createAppError(
                ERROR_CODES.KYC_SUBJECT_NOT_FOUND,
                404,
                'No verification record for this account',
                { role: subject.role },
            );
        }
        return doc;
    }

    private assertSlotAllowed(subject: KycSubject, slot: KycDocumentSlot): void {
        if (!subject.slots.includes(slot)) {
            throw createAppError(
                ERROR_CODES.KYC_SLOT_UNKNOWN,
                400,
                `A ${subject.role} does not provide this document`,
                { slot, allowed: [...subject.slots] },
            );
        }
    }

    /**
     * Refuse a write to a record that is under review or already decided in the affirmative.
     *
     * ⚠ `rejected` is deliberately NOT locked — a refusal the applicant cannot respond to is
     * a dead end, and re-submitting is the whole remedy. `submitted_at` survives a rejection,
     * so the unlock is keyed on the status rather than on clearing the stamp: clearing it
     * would lose "when did they first apply", which is the one thing a repeat-submission
     * pattern is visible in.
     */
    private assertUnlocked(subject: KycSubject, doc: any): void {
        const block = doc?.[subject.path] ?? {};
        if (!this.isLocked(block)) return;

        throw createAppError(
            ERROR_CODES.KYC_LOCKED,
            409,
            block.status === 'verified'
                ? 'Your account is verified; contact support to change these documents'
                : 'Your documents are being reviewed and cannot be changed right now',
            { status: block.status ?? null, submittedAt: block.submitted_at ?? null },
        );
    }

    private isLocked(block: any): boolean {
        if (block?.status === 'verified') return true;
        if (block?.status === 'rejected') return false;
        return Boolean(block?.submitted_at);
    }

    /** A slot's current file ids, as strings, whatever its cardinality. */
    private readSlot(subject: KycSubject, doc: any, slot: KycDocumentSlot): string[] {
        const raw = doc?.[subject.path]?.[kycSlotField(slot)];
        if (Array.isArray(raw)) return raw.filter(Boolean).map((id) => id.toString());
        return raw ? [raw.toString()] : [];
    }

    private async upload(subject: KycSubject, entityId: string, files: KycFileInput[]) {
        const [storageLimitBytes, currentUsageBytes] = await Promise.all([
            entitlementService.resolveMaxStorageBytes(
                subject.ownerType as 'vendor' | 'agency' | 'agent',
                entityId,
            ),
            mediaStorageService.getUsedBytes(subject.ownerType, entityId),
        ]);

        const config = getKycDocumentUploadConfig();
        const intake = new UploadIntakeService(
            config,
            this.storageProvider,
            this.fileRepository,
            new NoOpUploadObserver(),
            resolveVirusScanner(config),
        );

        return intake.execute({
            folder: 'kyc',
            context: {
                userId: entityId,
                // ⚠ The pipeline's own `UserRole` is `admin | vendor | user` — narrower than
                // the platform's five roles, and nothing in the pipeline reads it today
                // (`getUserRole()` has no consumer). `'user'` is what the delivery-proof path
                // passes for the same reason. Ownership travels on `ownerType`/`ownerId`,
                // which is what actually stamps the File and charges the right quota.
                role: 'user',
                ownerType: subject.ownerType,
                ownerId: entityId,
                storageLimitBytes,
                currentUsageBytes,
            },
            files: files.map((f) => ({
                buffer: f.buffer,
                originalName: f.originalName,
                mimeType: f.mimeType,
            })),
        });
    }

    private async buildDto(
        subject: KycSubject,
        doc: any,
        options: { includeReview: boolean },
    ): Promise<KycDto> {
        const block = doc?.[subject.path] ?? {};

        const ids = subject.slots.flatMap((slot) => this.readSlot(subject, doc, slot));
        const details = await resolveFileDetails(ids, this.fileRepository, this.storageProvider);

        const one = (slot: KycDocumentSlot): FileDetail | null =>
            subject.slots.includes(slot)
                ? details.get(this.readSlot(subject, doc, slot)[0] ?? '') ?? null
                : null;
        const many = (slot: KycDocumentSlot): FileDetail[] =>
            subject.slots.includes(slot)
                ? this.readSlot(subject, doc, slot)
                      .map((id) => details.get(id))
                      .filter((d): d is FileDetail => Boolean(d))
                : [];

        const documents: KycDocumentsDto = {
            idCardFront: one('id_card_front'),
            idCardBack: one('id_card_back'),
            selfieWithId: one('selfie_with_id'),
            vehicleWithAgent: one('vehicle_with_agent'),
            homeAddressSketches: many('home_address_sketch'),
            storeAddressSketches: many('store_address_sketch'),
        };

        const dto: KycDto = {
            role: subject.role,
            status: block.status ?? 'pending',
            submittedAt: toIso(block.submitted_at),
            locked: this.isLocked(block),
            rejectionReason: block.rejection_reason ?? null,
            verifiedAt: toIso(block.verified_at),
            idNumber: readPath(doc, subject.idNumberPath) ?? null,
            homeAddress: block.home_address ? toKycAddressDto(block.home_address, 'Home') : null,
            documents,
            limits: { ...KYC_LIMITS },
        };

        if (subject.role === 'agent') {
            dto.driversLicenseNumber = doc?.legal_identity?.drivers_license_number ?? null;
            dto.plateNumber = doc?.vehicle_info?.plate_number ?? null;
        }

        if (options.includeReview) {
            dto.storeAddresses = await this.readStoreAddresses(subject, doc);
            dto.review = {
                reviewedBy: buildActor(subject, block),
            };
        }

        return dto;
    }

    /**
     * The business addresses already on the account.
     *
     * ⚠ Two different collections, which is why this cannot be one projection. A vendor's are
     * embedded on the vendor document; an agency's live on its **Magazin**, because business
     * identity is not kept on the profile. An agent has none and gets no key at all.
     */
    private async readStoreAddresses(subject: KycSubject, doc: any): Promise<KycAddressDto[]> {
        if (subject.storeAddressSource === 'vendor.business_addresses') {
            return (doc.business_addresses ?? []).map((a: any) =>
                toKycAddressDto(a.geo, a.label ?? null, joinLoose(a.address_line1, a.city)),
            );
        }

        if (subject.storeAddressSource === 'magazin.headquarters_addresses') {
            const magazin = await AgencyMagazinModel.findOne({ agency_id: doc._id }).lean();
            return ((magazin as any)?.headquarters_addresses ?? []).map((a: any) =>
                toKycAddressDto(a.geo, a.label ?? null, a.address_description ?? null),
            );
        }

        return [];
    }
}

function toIso(value: Date | null | undefined): string | null {
    return value ? new Date(value).toISOString() : null;
}

/** `a.b.c` off a lean document. Used only for `idNumberPath`, which varies by role. */
function readPath(doc: any, path: string): any {
    return path.split('.').reduce((node, key) => (node == null ? node : node[key]), doc);
}

function joinLoose(...parts: Array<string | null | undefined>): string | null {
    const joined = parts.filter(Boolean).join(', ');
    return joined || null;
}

function buildActor(subject: KycSubject, block: any): KycDto['review'] extends infer R ? R extends { reviewedBy: infer A } ? A : never : never {
    // The vendor stamps `reviewed_by`; the agency and the agent stamp `verified_by`. One
    // prefix would have been nicer and renaming a persisted actor stamp is a migration.
    const prefix = subject.role === 'vendor' ? 'reviewed_by' : 'verified_by';
    const id = block[`${prefix}_user_id`];
    const status = block.status ?? 'pending';
    if (status === 'pending' || status === 'unverified') return null;

    return {
        id: id ? id.toString() : null,
        source: block[`${prefix}_source`] ?? 'platform',
        name: block[`${prefix}_name`] ?? null,
    };
}

export const kycSubmissionService = new KycSubmissionService();
