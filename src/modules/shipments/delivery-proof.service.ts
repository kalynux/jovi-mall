import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { ShipmentRepository } from './shipment.repository';
import { ShipmentStatus } from './shipment.model';
import { getDeliveryProofUploadConfig } from '../../core/uploads/upload-config';
import { UploadIntakeService } from '../../core/uploads/upload-intake.service';
import { IUploadObserver } from '../../core/uploads/upload-policy.types';
import { resolveVirusScanner } from '../../core/uploads/scanners';
import { getStorageProvider, IStorageProvider } from '../../core/storage';
import { FileRepositoryMongo } from '../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../catalog/domain/services/media/FileReferenceService';
import { resolveFileDetail } from '../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../catalog/read-models/product-detail.read-model';
import { mediaStorageService } from '../catalog/domain/services/media/MediaStorageService';
import { entitlementService } from '../billing/services/entitlement.service';

/**
 * Statuses at/after which an agent may attach a delivery proof — i.e. the
 * shipment has reached a delivery outcome. Attaching earlier is rejected: a proof
 * is evidence of the delivery, so it only makes sense once one has been claimed
 * (`agent_delivered`), confirmed (`delivered`) or has failed (`failed`).
 */
const DELIVERY_PROOF_STATUSES: ShipmentStatus[] = ['agent_delivered', 'delivered', 'failed'];

export interface DeliveryProofFileInput {
    buffer: Buffer;
    originalName?: string;
    size: number;
    mimeType: string;
}

// Minimal no-op observer (the general upload controller uses the same).
class NoOpUploadObserver implements IUploadObserver {}

/*
 * The `NoOpVirusScanner` that used to sit here was a SECOND definition of the same class as
 * the one in `api/controllers/file-upload.controller.ts` — which is how the sweep for it in
 * ADR-A01 D-1 found two and missed a third. Both are gone; `resolveVirusScanner(config)` is
 * the only construction path now (S-2 / F-25, closed 2026-08-19).
 *
 * Worth knowing for this tree specifically: a proof photo is not an internal artefact. It
 * reaches the agency, the vendor AND the customer through their own shipment reads, so an
 * infected file uploaded here is a file the platform hands to three other parties.
 */

/**
 * DeliveryProofService
 *
 * An agent may attach ONE optional image as proof of a delivery. The image is
 * uploaded and owned by the shipment's **agency** (so it counts against the
 * agency's media-storage cap, not the agent's), attached to the shipment via
 * file_references (`entityType: 'shipment'`, `field: 'delivery_proof'`), and its
 * id mirrored onto `shipment.delivery_proof_file_id`.
 *
 * The agent uploads bytes through the dedicated endpoint — there is no `fileId`
 * input, so there is no attach-by-id surface. Access is scoped to the agent's own
 * shipment (`findByIdAndAgent`), and re-upload replaces the previous proof.
 */
export class DeliveryProofService {
    private readonly fileReferenceService: FileReferenceService;

    constructor(
        private readonly shipmentRepo: ShipmentRepository = new ShipmentRepository(),
        private readonly fileRepository: FileRepositoryMongo = new FileRepositoryMongo(),
        private readonly fileReferenceRepository: FileReferenceRepositoryMongo = new FileReferenceRepositoryMongo(),
        private readonly storageProvider: IStorageProvider = getStorageProvider(),
    ) {
        this.fileReferenceService = new FileReferenceService(
            this.fileRepository,
            this.fileReferenceRepository,
        );
    }

    /**
     * Attach (or replace) the agent's delivery-proof image for a shipment they
     * hold. Charged to the shipment's agency storage. Returns the new proof's
     * FileDetail.
     */
    async attach(agentId: string, shipmentId: string, file: DeliveryProofFileInput): Promise<FileDetail> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, 'Shipment not found');
        }
        if (!DELIVERY_PROOF_STATUSES.includes(shipment.status)) {
            throw createAppError(
                ERROR_CODES.SHIPMENT_PROOF_NOT_ALLOWED,
                409,
                'A delivery proof can only be attached once the delivery has been marked delivered or failed',
                { status: shipment.status, allowed: DELIVERY_PROOF_STATUSES },
            );
        }

        const agencyId = shipment.agency_id.toString();
        const previousFileId = shipment.delivery_proof_file_id?.toString() ?? null;

        // Upload as the AGENCY (owner-stamped), quota-checked against the agency cap.
        const [storageLimitBytes, currentUsageBytes] = await Promise.all([
            entitlementService.resolveMaxStorageBytes('agency', agencyId),
            mediaStorageService.getUsedBytes('agency', agencyId),
        ]);

        const proofUploadConfig = getDeliveryProofUploadConfig();
        const uploadIntakeService = new UploadIntakeService(
            proofUploadConfig,
            this.storageProvider,
            this.fileRepository,
            new NoOpUploadObserver(),
            resolveVirusScanner(proofUploadConfig),
        );

        const [uploaded] = await uploadIntakeService.execute({
            folder: 'shipments',
            context: {
                userId: agentId,
                role: 'user',
                ownerType: 'agency',
                ownerId: agencyId,
                storageLimitBytes,
                currentUsageBytes,
            },
            files: [{
                buffer: file.buffer,
                originalName: file.originalName,
                mimeType: file.mimeType,
            }],
        });

        // Attach the new proof (and detach any previous one) as the agency actor —
        // the file is agency-owned, so assertAttachable passes.
        await this.fileReferenceService.reconcile({
            previousFileIds: previousFileId ? [previousFileId] : [],
            nextFileIds: [uploaded.id],
            actor: { type: 'agency', id: agencyId },
            entityType: 'shipment',
            entityId: shipmentId,
            field: 'delivery_proof',
        });

        await this.shipmentRepo.setDeliveryProof(shipmentId, uploaded.id);

        // On replace, soft-delete the now-detached previous File so the agency's
        // usage drops immediately (rather than waiting for the lonely-file sweep).
        if (previousFileId && previousFileId !== uploaded.id) {
            await this.fileRepository.softDelete(previousFileId);
        }

        return resolveFileDetail(uploaded.id, this.fileRepository, this.storageProvider) as Promise<FileDetail>;
    }

    /** The current delivery proof for a shipment the agent holds, or null. */
    async get(agentId: string, shipmentId: string): Promise<FileDetail | null> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, 'Shipment not found');
        }
        return resolveFileDetail(
            shipment.delivery_proof_file_id?.toString(),
            this.fileRepository,
            this.storageProvider,
        );
    }

    /** Remove the delivery proof (detach + soft-delete the agency-owned File). */
    async remove(agentId: string, shipmentId: string): Promise<void> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, 'Shipment not found');
        }
        const fileId = shipment.delivery_proof_file_id?.toString();
        if (!fileId) {
            throw createAppError(ERROR_CODES.SHIPMENT_PROOF_NOT_FOUND, 404, 'No delivery proof to remove');
        }

        await this.fileReferenceService.reconcile({
            previousFileIds: [fileId],
            nextFileIds: [],
            actor: { type: 'agency', id: shipment.agency_id.toString() },
            entityType: 'shipment',
            entityId: shipmentId,
            field: 'delivery_proof',
        });
        await this.shipmentRepo.setDeliveryProof(shipmentId, null);
        await this.fileRepository.softDelete(fileId);
    }

    /**
     * Stream the proof's BYTES to an authorized viewer — the door that replaces the public
     * URL (ADR-A01 D-2).
     *
     * ── The authorization is the SHIPMENT's, deliberately re-used and not re-derived ───────
     * `storage/shipments/` left `express.static`, so a proof photo is no longer fetchable by
     * anyone holding the URL — which mattered because that URL is a delivery address and a
     * timestamped location, and it worked forever once seen.
     *
     * The viewer discriminant selects between the SAME two ownership predicates the shipment
     * reads already use (`findByIdAndAgent` / `findByIdAndAgency`), so "may this person see
     * this shipment" has exactly one answer on the platform. Writing a fresh rule here — even
     * a correct one today — is how a file route and its entity drift apart, which is the
     * class of defect ADR-A01 D-2 exists to close rather than to relocate.
     *
     * 404 and never 403, matching the reads: an unrelated agent must not learn that a
     * shipment exists.
     *
     * Only these two roles because only these two are ever shown the proof — `_buildDetail`
     * is reached by `getDetailForAgency` and `getDetailForAgent` and by nothing else. The
     * customer and vendor cases named in ADR-A01's map do not exist in the code; adding one
     * means adding its read first, and then its branch here.
     */
    async streamTo(
        viewer: { role: 'agent' | 'agency'; id: string },
        shipmentId: string,
    ): Promise<{ stream: NodeJS.ReadableStream; mimeType: string; size: number; filename: string }> {
        const shipment = viewer.role === 'agent'
            ? await this.shipmentRepo.findByIdAndAgent(shipmentId, viewer.id)
            : await this.shipmentRepo.findByIdAndAgency(shipmentId, viewer.id);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, 'Shipment not found');
        }

        const fileId = shipment.delivery_proof_file_id?.toString();
        if (!fileId) {
            throw createAppError(ERROR_CODES.SHIPMENT_PROOF_NOT_FOUND, 404, 'No delivery proof');
        }

        const [file] = await this.fileRepository.findManyByIds([fileId]);
        if (!file) {
            // The reference outlived the file (soft-deleted, or reclaimed). Same answer as no
            // proof at all: there is nothing to serve and the shipment is not the problem.
            throw createAppError(ERROR_CODES.SHIPMENT_PROOF_NOT_FOUND, 404, 'No delivery proof');
        }

        return {
            stream: await this.storageProvider.getDownloadStream(file.key),
            mimeType: file.mimeType,
            size: file.size,
            filename: file.originalName ?? 'delivery-proof',
        };
    }
}

export const deliveryProofService = new DeliveryProofService();
