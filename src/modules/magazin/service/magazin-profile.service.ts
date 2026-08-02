import { MagazinRepository } from '../repositories/magazin.repository';
import { MagazinProvisioningService } from './magazin-provisioning.service';
import {
  MagazinProfileMapper,
  GetMagazinProfileResponseDto,
  UpdateMagazinProfileInputDto,
  toPersistableHeadquarters,
} from '../dto/magazin-profile.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { IAgencyMagazin } from '../models/magazin.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { normalizeCoverageAreasForCountry } from '../../../core/constants/locations.helper';
import { assertHeadquartersInCountry } from '../../../core/validation/address-country.helper';

/**
 * Magazin Profile Service
 *
 * Business logic for the agency's business surface — the Store-equivalent for
 * delivery agencies. Mirrors StoreProfileService:
 * - Zod validates SHAPE (controller/validator layer)
 * - Service enforces POLICY (optimistic locking, agency ownership)
 * - Repository handles persistence (agency-ID-only access)
 */
export class MagazinProfileService {
  private magazinRepo: MagazinRepository;
  private provisioningService: MagazinProvisioningService;
  private agencyRepo: DeliveryAgencyRepository;
  private fileRepository: FileRepositoryMongo;
  private fileReferenceService: FileReferenceService;
  private storageProvider: IStorageProvider;

  constructor() {
    this.magazinRepo = new MagazinRepository();
    this.provisioningService = new MagazinProvisioningService();
    this.agencyRepo = new DeliveryAgencyRepository();
    this.fileRepository = new FileRepositoryMongo();
    this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
    this.storageProvider = getStorageProvider();
  }

  /**
   * Keep `file_references` in sync with the magazin's logo slot whenever it
   * changes. Mirrors the store/vendor reconciliation: authorizes the newly-attached
   * file and detaches the previous one, BEFORE the write so an unauthorized file
   * reference is rejected before it is persisted. Only touched when the input
   * field is present (PATCH semantics).
   */
  private async reconcileMagazinLogoReference(
    agencyId: string,
    magazinId: string,
    current: IAgencyMagazin,
    input: UpdateMagazinProfileInputDto,
  ): Promise<void> {
    if (input.logoFileId !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: current.logo_file_id ? [current.logo_file_id.toString()] : [],
        nextFileIds: input.logoFileId ? [input.logoFileId] : [],
        actor: { type: 'agency', id: agencyId },
        entityType: 'agency_magazin',
        entityId: magazinId,
        field: 'logo',
      });
    }
  }

  /**
   * Get magazin profile (get-or-create: an agency without a magazin row gets one
   * created on first access).
   */
  async getMagazin(agencyId: string): Promise<GetMagazinProfileResponseDto> {
    const magazin = await this.provisioningService.ensureMagazinForAgency(agencyId);
    return MagazinProfileMapper.toResponseDto(magazin, this.fileRepository, this.storageProvider);
  }

  /**
   * Update magazin profile with optimistic locking.
   * Emits `magazin.profile.updated` and writes an audit trail.
   */
  async updateMagazin(
    agencyId: string,
    input: UpdateMagazinProfileInputDto,
  ): Promise<GetMagazinProfileResponseDto> {
    const currentMagazin = await this.provisioningService.ensureMagazinForAgency(agencyId);

    const updatePayload = MagazinProfileMapper.toUpdatePayload(input);

    // Coverage areas + HQ addresses are anchored to the agency's registered
    // country (set-once on the profile). Validate/normalise against it.
    if (input.coverage_areas !== undefined || input.headquarters_addresses !== undefined) {
      const agency = await this.agencyRepo.findById(agencyId);
      const country = agency?.country ?? null;

      if (input.coverage_areas !== undefined) {
        updatePayload.coverage_areas = normalizeCoverageAreasForCountry(input.coverage_areas, country);
      }
      if (input.headquarters_addresses !== undefined) {
        assertHeadquartersInCountry(input.headquarters_addresses, currentMagazin.headquarters_addresses, country);
        updatePayload.headquarters_addresses = toPersistableHeadquarters(input.headquarters_addresses);
      }
    }

    // Keep file references in sync BEFORE the write, so an unauthorized file
    // reference is rejected before anything is persisted.
    await this.reconcileMagazinLogoReference(
      agencyId,
      currentMagazin._id.toString(),
      currentMagazin,
      input,
    );

    const updated = await this.magazinRepo.updateByAgencyId(agencyId, input.version, updatePayload);

    if (!updated) {
      throw createAppError(ERROR_CODES.MAGAZIN_CONFLICT, 409, 'Magazin was modified by another request. Please refresh and try again.');
    }

    const changes = this.calculateChanges(currentMagazin, updated);

    await eventBus.publish('magazin.profile.updated', {
      eventType: 'magazin.profile.updated',
      aggregateId: updated._id.toString(),
      payload: {
        agencyId,
        magazinId: updated._id.toString(),
        changes,
      },
      occurredAt: new Date(),
    });

    await auditLogger.log({
      actor: { userId: agencyId, role: 'agency' },
      action: 'MAGAZIN_PROFILE_UPDATED',
      resource: { type: 'AgencyMagazin', id: updated._id.toString() },
      changes,
      timestamp: new Date(),
    });

    return MagazinProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider);
  }

  /** Simple diff over the vendor/agency-updatable fields, for audit/events. */
  private calculateChanges(oldMagazin: IAgencyMagazin, newMagazin: IAgencyMagazin): Record<string, { from: string | null; to: string | null }> {
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    const fields: Array<keyof IAgencyMagazin> = [
      'name',
      'logo_file_id',
      'description',
      'support_email',
      'support_phone',
      'support_whatsapp',
    ];
    const norm = (v: unknown): string | null => (v == null ? null : v.toString());
    for (const field of fields) {
      if (norm(oldMagazin[field]) !== norm(newMagazin[field])) {
        changes[field as string] = { from: norm(oldMagazin[field]), to: norm(newMagazin[field]) };
      }
    }
    return changes;
  }
}
