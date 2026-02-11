import { VendorRepository } from '../../vendors/vendor.repository';
import { VendorProfileMapper, GetVendorProfileResponseDto, UpdateVendorProfileInputDto } from '../dto/vendor-profile.dto';
import { VendorConfig } from '../config/vendor.config';
import { NotFoundError, ForbiddenError, ConflictError } from '../../../core/errors';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';

/**
 * Vendor Profile Service
 * 
 * Core business logic for vendor profile management.
 * 
 * ARCHITECTURE:
 * - Zod validates SHAPE (in controller/validator layer)
 * - Service enforces POLICY (email lock, feature flags, business rules)
 * - Repository handles persistence
 * 
 * ENTERPRISE PATTERNS:
 * - Optimistic locking for concurrent update safety
 * - Domain events for integration/webhooks
 * - Audit logging for compliance
 * - Explicit field mapping to prevent mass assignment
 */
export class VendorProfileService {
  private vendorRepo: VendorRepository;

  constructor() {
    this.vendorRepo = new VendorRepository();
  }

  /**
   * Get vendor profile
   * 
   * Returns sanitized profile safe for API responses.
   * 
   * @param vendorId - Vendor ID
   * @returns Sanitized vendor profile
   * @throws NotFoundError if vendor not found
   */
  async getProfile(vendorId: string): Promise<GetVendorProfileResponseDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    
    if (!vendor) {
      throw new NotFoundError('Vendor profile not found');
    }

    return VendorProfileMapper.toResponseDto(vendor);
  }

  /**
   * Update vendor profile
   * 
   * BUSINESS RULES ENFORCED:
   * 1. Optimistic locking - prevents concurrent update conflicts
   * 2. Email change lock - enforced via config flag
   * 3. Feature flag enforcement - whatsapp/phone notifications
   * 4. No mass assignment - explicit field mapping only
   * 
   * SIDE EFFECTS:
   * - Emits domain event: vendor.profile.updated
   * - Logs audit trail
   * 
   * @param vendorId - Vendor ID
   * @param input - Update input DTO (already validated by Zod)
   * @returns Updated sanitized profile
   * @throws NotFoundError if vendor not found
   * @throws ForbiddenError if business rule violated
   * @throws ConflictError if optimistic locking fails
   */
  async updateProfile(
    vendorId: string,
    input: UpdateVendorProfileInputDto
  ): Promise<GetVendorProfileResponseDto> {
    // 1. Load current vendor
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) {
      throw new NotFoundError('Vendor profile not found');
    }

    // 2. BUSINESS POLICY: Email change lock
    if (input.email && input.email !== vendor.email) {
      if (!VendorConfig.ALLOW_EMAIL_CHANGE) {
        throw new ForbiddenError(
          'Email changes are not allowed. Please contact support if you need to update your email address.'
        );
      }
    }

    // 3. BUSINESS POLICY: Feature flag enforcement for notification preferences
    if (input.notificationPreferences) {
      // WhatsApp notifications feature flag
      if (input.notificationPreferences.whatsapp && input.notificationPreferences.whatsapp !== vendor.notification_preferences.whatsapp) {
        if (!VendorConfig.ENABLE_WHATSAPP_NOTIFICATIONS) {
          throw new ForbiddenError(
            'WhatsApp notifications are not available on your current plan. Please upgrade to enable this feature.'
          );
        }
      }

      // Phone notifications feature flag
      if (input.notificationPreferences.phone && input.notificationPreferences.phone !== vendor.notification_preferences.phone) {
        if (!VendorConfig.ENABLE_PHONE_NOTIFICATIONS) {
          throw new ForbiddenError(
            'Phone notifications are not available on your current plan. Please upgrade to enable this feature.'
          );
        }
      }
    }

    // 4. Map input to update payload (explicit field mapping, no mass assignment)
    const updatePayload = VendorProfileMapper.toUpdatePayload(input);

    // 5. OPTIMISTIC LOCKING: Update with version check
    const updated = await this.vendorRepo.updateProfileWithVersion(
      vendorId,
      input.version,
      updatePayload
    );

    if (!updated) {
      throw new ConflictError(
        'Profile was modified by another request. Please refresh the page and try again.'
      );
    }

    // 6. Calculate changes for event/audit (simple diff)
    const changes = this.calculateChanges(vendor, updated);

    // 7. DOMAIN EVENT: vendor.profile.updated
    await eventBus.publish('vendor.profile.updated', {
      eventType: 'vendor.profile.updated',
      aggregateId: vendorId,
      payload: {
        vendorId,
        changes,
      },
      occurredAt: new Date(),
    });

    // 8. AUDIT LOG
    await auditLogger.log({
      actor: {
        userId: vendor.user_id.toString(),
        role: 'vendor',
      },
      action: 'VENDOR_PROFILE_UPDATED',
      resource: {
        type: 'Vendor',
        id: vendorId,
      },
      changes,
      timestamp: new Date(),
    });

    // 9. Return sanitized profile
    return VendorProfileMapper.toResponseDto(updated);
  }

  /**
   * Calculate changes between old and new vendor
   * 
   * Simple diff for audit logging and events.
   * Only tracks fields that can be updated via API.
   * 
   * @param oldVendor - Vendor before update
   * @param newVendor - Vendor after update
   * @returns Object with changed fields
   */
  private calculateChanges(oldVendor: any, newVendor: any): Record<string, any> {
    const changes: Record<string, any> = {};

    if (oldVendor.display_name !== newVendor.display_name) {
      changes.displayName = { from: oldVendor.display_name, to: newVendor.display_name };
    }

    if (oldVendor.email !== newVendor.email) {
      changes.email = { from: oldVendor.email, to: newVendor.email };
    }

    if (oldVendor.phone !== newVendor.phone) {
      changes.phone = { from: oldVendor.phone, to: newVendor.phone };
    }

    // Check notification preferences
    const oldPrefs = oldVendor.notification_preferences;
    const newPrefs = newVendor.notification_preferences;
    
    if (JSON.stringify(oldPrefs) !== JSON.stringify(newPrefs)) {
      changes.notificationPreferences = { from: oldPrefs, to: newPrefs };
    }

    return changes;
  }
}
