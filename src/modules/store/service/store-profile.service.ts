import { StoreRepository } from '../repositories/store.repository';
import {
  StoreProfileMapper,
  GetStoreProfileResponseDto,
  UpdateStoreProfileInputDto,
  UpdateStoreStatusInputDto,
} from '../dto/store-profile.dto';
import { ConflictError, ForbiddenError } from '../../../core/errors';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';

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

  constructor() {
    this.storeRepo = new StoreRepository();
  }

  /**
   * Get store profile
   * 
   * FAILS LOUDLY if store not found (system bug).
   * 
   * @param vendorId - Vendor ID
   * @returns Sanitized store profile with publicUrl
   * @throws NotFoundError if store not found
   */
  async getStore(vendorId: string): Promise<GetStoreProfileResponseDto> {
    // Repository throws NotFoundError if not found
    const store = await this.storeRepo.findByVendorId(vendorId);
    
    return StoreProfileMapper.toResponseDto(store);
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
    // 1. Load current store (fail-fast if not found)
    const currentStore = await this.storeRepo.findByVendorId(vendorId);

    // 2. BUSINESS POLICY: Reject attempts to modify immutable fields
    // Note: This is defensive. The DTO mapper already ignores these fields,
    // but we throw explicit errors to make the policy clear.
    const rawInput = input as any;
    if (rawInput.slug !== undefined) {
      throw new ForbiddenError(
        'Slug cannot be modified. Contact support if you need to change your store URL.'
      );
    }
    if (rawInput.country !== undefined) {
      throw new ForbiddenError(
        'Country cannot be modified. This is locked for tax and shipping compliance.'
      );
    }

    // 3. Map input to update payload (explicit field mapping, no mass assignment)
    const updatePayload = StoreProfileMapper.toUpdatePayload(input);

    // 4. OPTIMISTIC LOCKING: Update with version check
    const updated = await this.storeRepo.updateByVendorId(
      vendorId,
      input.version,
      updatePayload
    );

    if (!updated) {
      throw new ConflictError(
        'Store was modified by another request. Please refresh and try again.'
      );
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
    return StoreProfileMapper.toResponseDto(updated);
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
    // 1. OPTIMISTIC LOCKING: Update status with version check
    const updated = await this.storeRepo.updateStatusByVendorId(
      vendorId,
      input.version,
      input.isOpen
    );

    if (!updated) {
      throw new ConflictError(
        'Store was modified by another request. Please refresh and try again.'
      );
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
    return StoreProfileMapper.toResponseDto(updated);
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
      'logo_url',
      'banner_url',
      'description',
      'address',
      'city',
      'support_email',
      'support_phone',
      'support_whatsapp',
    ];

    for (const field of fields) {
      if (oldStore[field] !== newStore[field]) {
        changes[field] = { from: oldStore[field], to: newStore[field] };
      }
    }

    return changes;
  }
}
