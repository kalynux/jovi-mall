import { StoreRepository } from '../repositories/store.repository';
import { StoreProvisioningService } from './store-provisioning.service';
import {
  StoreProfileMapper,
  GetStoreProfileResponseDto,
  UpdateStoreProfileInputDto,
  UpdateStoreStatusInputDto,
} from '../dto/store-profile.dto';
import { VendorRepository } from '../../vendors/vendor.repository';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { IStore } from '../models/store.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';

/**
 * Store Profile Service
 * 
 * Core business logic for store profile management.
 * 
 * ARCHITECTURE:
 * - Zod validates SHAPE (in controller/validator layer)
 * - Service enforces POLICY (immutability, vendor ownership, business rules)
 * - Repository handles persistence (vendor-ID-only access)
 * 
 * ENTERPRISE PATTERNS:
 * - Optimistic locking for concurrent update safety
 * - Domain events for integration/webhooks
 * - Audit logging for compliance
 * - Explicit field mapping to prevent mass assignment
 * - Vendor-ID-only access (no storeId in vendor API)
 */
export class StoreProfileService {
  private storeRepo: StoreRepository;
  private provisioningService: StoreProvisioningService;
  private vendorRepo: VendorRepository;
  private fileRepository: FileRepositoryMongo;
  private fileReferenceService: FileReferenceService;
  private storageProvider: IStorageProvider;

  constructor() {
    this.storeRepo = new StoreRepository();
    this.provisioningService = new StoreProvisioningService();
    this.vendorRepo = new VendorRepository();
    this.fileRepository = new FileRepositoryMongo();
    this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
    this.storageProvider = getStorageProvider();
  }

  /**
   * Keep `file_references` in sync with the store's branding slots (logo, banner)
   * whenever they change. Mirrors the vendor-profile reconciliation: authorizes
   * every newly-attached file and detaches the previous one. Runs before the store
   * write so an unauthorized file reference is rejected before it is persisted.
   * A slot is only touched when its input field is present (PATCH semantics).
   */
  private async reconcileStoreBrandingReferences(
    vendorId: string,
    storeId: string,
    current: IStore,
    input: UpdateStoreProfileInputDto,
  ): Promise<void> {
    if (input.logoFileId !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: current.logo_file_id ? [current.logo_file_id.toString()] : [],
        nextFileIds: input.logoFileId ? [input.logoFileId] : [],
        actor: { type: 'vendor', id: vendorId },
        entityType: 'store',
        entityId: storeId,
        field: 'logo',
      });
    }
    if (input.bannerFileId !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: current.banner_file_id ? [current.banner_file_id.toString()] : [],
        nextFileIds: input.bannerFileId ? [input.bannerFileId] : [],
        actor: { type: 'vendor', id: vendorId },
        entityType: 'store',
        entityId: storeId,
        field: 'banner',
      });
    }
  }

  /**
   * The store's `country` is not stored on the store — it is the vendor
   * profile's set-once country, served read-only here.
   */
  private async getVendorCountry(vendorId: string): Promise<string | null> {
    const vendor = await this.vendorRepo.findById(vendorId);
    return vendor?.country ?? null;
  }

  /**
   * Get store profile
   *
   * Get-or-create: a vendor without a store row (pre-provisioning accounts)
   * gets one created on first access.
   *
   * @param vendorId - Vendor ID
   * @returns Sanitized store profile with publicUrl
   */
  async getStore(vendorId: string): Promise<GetStoreProfileResponseDto> {
    const store = await this.provisioningService.ensureStoreForVendor(vendorId);

    return StoreProfileMapper.toResponseDto(
      store,
      await this.getVendorCountry(vendorId),
      this.fileRepository,
      this.storageProvider,
    );
  }

  /**
   * Update store profile
   * 
   * BUSINESS RULES ENFORCED:
   * 1. Optimistic locking - prevents concurrent update conflicts
   * 2. Slug immutability - slug cannot be changed in vendor API
   * 3. Country immutability - country cannot be changed by vendor
   * 4. No mass assignment - explicit field mapping only
   * 
   * SIDE EFFECTS:
   * - Emits domain event: store.profile.updated
   * - Logs audit trail
   * 
   * @param vendorId - Vendor ID
   * @param input - Update input DTO (already validated by Zod)
   * @returns Updated sanitized profile
   * @throws ConflictError if optimistic locking fails
   * @throws ForbiddenError if immutable fields modified
   */
  async updateStore(
    vendorId: string,
    input: UpdateStoreProfileInputDto
  ): Promise<GetStoreProfileResponseDto> {
    // 1. Load current store (created on the fly for pre-provisioning vendors)
    const currentStore = await this.provisioningService.ensureStoreForVendor(vendorId);

    // 2. BUSINESS POLICY: Reject attempts to modify immutable fields
    // Note: This is defensive. The DTO mapper already ignores these fields,
    // but we throw explicit errors to make the policy clear.
    const rawInput = input as any;
    if (rawInput.slug !== undefined) {
      throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Slug cannot be modified. Contact support if you need to change your store URL.');
    }
    if (rawInput.country !== undefined) {
      throw createAppError(ERROR_CODES.PROFILE_COUNTRY_IMMUTABLE, 403, 'Country is not stored on the store. It lives on your vendor profile and is set once during onboarding.');
    }

    // 3. Map input to update payload (explicit field mapping, no mass assignment)
    const updatePayload = StoreProfileMapper.toUpdatePayload(input);

    // 3b. Keep file references in sync BEFORE the write, so an unauthorized file
    // reference is rejected before anything is persisted (mirrors vendor branding).
    await this.reconcileStoreBrandingReferences(
      vendorId,
      currentStore._id.toString(),
      currentStore,
      input,
    );

    // 4. OPTIMISTIC LOCKING: Update with version check
    const updated = await this.storeRepo.updateByVendorId(
      vendorId,
      input.version,
      updatePayload
    );

    if (!updated) {
      throw createAppError(ERROR_CODES.STORE_SLUG_TAKEN, 409, 'Store was modified by another request. Please refresh and try again.');
    }

    // 5. Calculate changes for event/audit (simple diff)
    const changes = this.calculateChanges(currentStore, updated);

    // 6. DOMAIN EVENT: store.profile.updated
    await eventBus.publish('store.profile.updated', {
      eventType: 'store.profile.updated',
      aggregateId: updated._id.toString(),
      payload: {
        vendorId,
        storeId: updated._id.toString(),
        changes,
      },
      occurredAt: new Date(),
    });

    // 7. AUDIT LOG
    await auditLogger.log({
      actor: {
        userId: vendorId, // vendorId acts as userId for vendor actions
        role: 'vendor',
      },
      action: 'STORE_PROFILE_UPDATED',
      resource: {
        type: 'Store',
        id: updated._id.toString(),
      },
      changes,
      timestamp: new Date(),
    });

    // 8. Return sanitized profile
    return StoreProfileMapper.toResponseDto(
      updated,
      await this.getVendorCountry(vendorId),
      this.fileRepository,
      this.storageProvider,
    );
  }

  /**
   * Update store status (vacation mode)
   * 
   * BUSINESS RULES ENFORCED:
   * 1. Optimistic locking - prevents concurrent update conflicts
   * 
   * SIDE EFFECTS:
   * - Emits domain event: store.status.changed
   * - Logs audit trail
   * 
   * @param vendorId - Vendor ID
   * @param input - Status input DTO
   * @returns Updated sanitized profile
   * @throws ConflictError if optimistic locking fails
   */
  async updateStoreStatus(
    vendorId: string,
    input: UpdateStoreStatusInputDto
  ): Promise<GetStoreProfileResponseDto> {
    // 0. Ensure the store exists (created on the fly for pre-provisioning vendors)
    await this.provisioningService.ensureStoreForVendor(vendorId);

    // 1. OPTIMISTIC LOCKING: Update status with version check
    const updated = await this.storeRepo.updateStatusByVendorId(
      vendorId,
      input.version,
      input.isOpen
    );

    if (!updated) {
      throw createAppError(ERROR_CODES.STORE_SLUG_TAKEN, 409, 'Store was modified by another request. Please refresh and try again.');
    }

    // 2. DOMAIN EVENT: store.status.changed
    await eventBus.publish('store.status.changed', {
      eventType: 'store.status.changed',
      aggregateId: updated._id.toString(),
      payload: {
        vendorId,
        storeId: updated._id.toString(),
        isOpen: input.isOpen,
        reason: input.isOpen ? 'opened' : 'vacation_mode',
      },
      occurredAt: new Date(),
    });

    // 3. AUDIT LOG
    await auditLogger.log({
      actor: {
        userId: vendorId,
        role: 'vendor',
      },
      action: input.isOpen ? 'STORE_OPENED' : 'STORE_CLOSED_VACATION',
      resource: {
        type: 'Store',
        id: updated._id.toString(),
      },
      metadata: {
        isOpen: input.isOpen,
      },
      timestamp: new Date(),
    });

    // 4. Return sanitized profile
    return StoreProfileMapper.toResponseDto(
      updated,
      await this.getVendorCountry(vendorId),
      this.fileRepository,
      this.storageProvider,
    );
  }

  /**
   * Calculate changes between old and new store
   * 
   * Simple diff for audit logging and events.
   * Only tracks fields that can be updated via vendor API.
   * 
   * @param oldStore - Store before update
   * @param newStore - Store after update
   * @returns Object with changed fields
   */
  private calculateChanges(oldStore: any, newStore: any): Record<string, any> {
    const changes: Record<string, any> = {};

    // Track updateable fields
    const fields = [
      'name',
      'logo_file_id',
      'banner_file_id',
      'description',
      'support_email',
      'support_phone',
      'support_whatsapp',
    ];

    // Normalise so ObjectId slots (logo/banner file ids) compare by value, not by
    // reference — otherwise every update would report them as changed.
    const norm = (v: any): string | null => (v == null ? null : v.toString());

    for (const field of fields) {
      if (norm(oldStore[field]) !== norm(newStore[field])) {
        changes[field] = { from: norm(oldStore[field]), to: norm(newStore[field]) };
      }
    }

    return changes;
  }
}
