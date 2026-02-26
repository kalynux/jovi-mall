import { VendorRepository } from '../../vendors/vendor.repository';
import { VendorProfileMapper, GetVendorProfileResponseDto, VendorCompletionStatusDto } from '../dto/vendor-profile.dto';
import { VendorConfig } from '../config/vendor.config';
import { NotFoundError, ForbiddenError, ConflictError } from '../../../core/errors';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { VendorOnboardingStep, VendorOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import { IVendor } from '../../vendors/vendor.model';
import {
  UpdateVendorProfileInput,
  VendorOnboardingStep1Input,
  VendorOnboardingStep2Input,
  VendorOnboardingStep3Input,
} from '../validators/vendor-onboarding.validator';

/**
 * Vendor Profile Service
 *
 * ARCHITECTURE:
 * - Zod validates SHAPE (in validator layer)
 * - Service enforces POLICY (field presence rules, feature flags)
 * - Repository handles persistence
 *
 * ONBOARDING MODEL:
 * - Field-presence upsert: data is always applied, then step is recalculated
 * - No directional enforcement — any write triggers full re-evaluation
 * - Response includes `missing_fields[]` so frontend knows what to prompt for
 */
export class VendorProfileService {
  private vendorRepo: VendorRepository;

  constructor() {
    this.vendorRepo = new VendorRepository();
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  async getProfile(vendorId: string): Promise<GetVendorProfileResponseDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw new NotFoundError('Vendor profile not found');
    return VendorProfileMapper.toResponseDto(vendor);
  }

  async getCompletionStatus(vendorId: string): Promise<VendorCompletionStatusDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw new NotFoundError('Vendor profile not found');
    return this.buildCompletionStatus(vendor);
  }

  // ─── Update (General) ─────────────────────────────────────────────────────

  async updateProfile(
    vendorId: string,
    input: UpdateVendorProfileInput
  ): Promise<GetVendorProfileResponseDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw new NotFoundError('Vendor profile not found');

    // POLICY: Email change lock
    if (input.email && input.email !== vendor.email) {
      if (!VendorConfig.ALLOW_EMAIL_CHANGE) {
        throw new ForbiddenError(
          'Email changes are not allowed. Contact support to update your email.'
        );
      }
    }

    // POLICY: Feature flags for notification preferences
    if (input.notificationPreferences) {
      if (
        input.notificationPreferences.whatsapp &&
        !VendorConfig.ENABLE_WHATSAPP_NOTIFICATIONS
      ) {
        throw new ForbiddenError('WhatsApp notifications are not available on your current plan.');
      }
      if (
        input.notificationPreferences.phone &&
        !VendorConfig.ENABLE_PHONE_NOTIFICATIONS
      ) {
        throw new ForbiddenError('Phone notifications are not available on your current plan.');
      }
    }

    const updatePayload = VendorProfileMapper.toUpdatePayload(input);
    const updated = await this.vendorRepo.updateProfileWithVersion(
      vendorId,
      input.version,
      updatePayload
    );

    if (!updated) {
      throw new ConflictError(
        'Profile was modified by another request. Please refresh and try again.'
      );
    }

    // Recalculate onboarding step from field presence
    const newStep = this.recalculateOnboardingStep(updated);
    if (newStep !== updated.onboarding_step) {
      await this.vendorRepo.updateOnboardingStep(vendorId, newStep);
      updated.onboarding_step = newStep;
    }

    await this.emitUpdateEvent(vendor, updated, vendorId);
    return VendorProfileMapper.toResponseDto(updated);
  }

  // ─── Onboarding Steps ─────────────────────────────────────────────────────

  /**
   * Complete Step 1: Basic Setup (country, timezone, payout_details)
   * Always applied as an upsert. Step recalculated after write.
   */
  async completeStep1(
    vendorId: string,
    input: VendorOnboardingStep1Input
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw new NotFoundError('Vendor profile not found');

    const updated = await this.vendorRepo.updateProfile(vendorId, {
      country: input.country,
      timezone: input.timezone,
      payout_details: input.payout_details as IVendor['payout_details'],
    });
    if (!updated) throw new NotFoundError('Vendor not found after update');

    const newStep = this.recalculateOnboardingStep(updated);
    await this.vendorRepo.updateOnboardingStep(vendorId, newStep);
    updated.onboarding_step = newStep;

    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Complete Step 2: Delivery Linking (default_delivery_agency_id)
   */
  async completeStep2(
    vendorId: string,
    input: VendorOnboardingStep2Input
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw new NotFoundError('Vendor profile not found');

    const updated = await this.vendorRepo.updateProfile(vendorId, {
      default_delivery_agency_id: input.default_delivery_agency_id as unknown as IVendor['default_delivery_agency_id'],
    });
    if (!updated) throw new NotFoundError('Vendor not found after update');

    const newStep = this.recalculateOnboardingStep(updated);
    await this.vendorRepo.updateOnboardingStep(vendorId, newStep);
    updated.onboarding_step = newStep;

    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Complete Step 3: Branding (optional/skippable).
   * If skip=true, advances directly to COMPLETED.
   */
  async completeStep3(
    vendorId: string,
    input: VendorOnboardingStep3Input
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw new NotFoundError('Vendor profile not found');

    if (!input.skip) {
      const updates: Partial<IVendor> = {};
      if (input.branding) updates.branding = input.branding as IVendor['branding'];
      if (input.business_addresses)
        updates.business_addresses = input.business_addresses as IVendor['business_addresses'];
      if (Object.keys(updates).length > 0) {
        await this.vendorRepo.updateProfile(vendorId, updates);
      }
    }

    // Step 3 is always satisfiable (optional) — advance to COMPLETED
    await this.vendorRepo.updateOnboardingStep(vendorId, VendorOnboardingStep.COMPLETED);
    const finalVendor = await this.vendorRepo.findById(vendorId);
    if (!finalVendor) throw new NotFoundError('Vendor not found');

    return {
      profile: VendorProfileMapper.toResponseDto(finalVendor),
      completionStatus: this.buildCompletionStatus(finalVendor),
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Recalculate onboarding_step from field presence.
   * Returns the lowest incomplete required step, or 0 if all done.
   */
  private recalculateOnboardingStep(vendor: IVendor): VendorOnboardingStepValue {
    const step1Complete =
      !!vendor.country &&
      !!vendor.timezone &&
      !!vendor.payout_details;

    if (!step1Complete) return VendorOnboardingStep.BASIC_SETUP;

    const step2Complete = !!vendor.default_delivery_agency_id;
    if (!step2Complete) return VendorOnboardingStep.DELIVERY_LINKING;

    // Step 3 is optional — if step 1+2 are done and step is already > 2, just complete
    if (vendor.onboarding_step === VendorOnboardingStep.BRANDING) {
      return VendorOnboardingStep.BRANDING; // Let the controller call completeStep3 to finish
    }

    return VendorOnboardingStep.COMPLETED;
  }

  private buildCompletionStatus(vendor: IVendor): VendorCompletionStatusDto {
    const missing: string[] = [];

    if (!vendor.country) missing.push('country');
    if (!vendor.timezone || vendor.timezone === 'Africa/Douala') {
      // Only flag if explicitly not set (default is populated but still prompt to confirm)
    }
    if (!vendor.payout_details) missing.push('payout_details');
    if (!vendor.default_delivery_agency_id) missing.push('default_delivery_agency_id');

    const step = vendor.onboarding_step;
    const stepLabels: Record<number, string> = {
      0: 'Onboarding Complete',
      1: 'Basic Setup',
      2: 'Delivery Linking',
      3: 'Branding (Optional)',
    };

    return {
      onboardingStep: step,
      isComplete: step === VendorOnboardingStep.COMPLETED,
      missingFields: missing,
      stepLabel: stepLabels[step] ?? `Step ${step}`,
    };
  }

  private async emitUpdateEvent(
    oldVendor: IVendor,
    newVendor: IVendor,
    vendorId: string
  ): Promise<void> {
    const changes: Record<string, unknown> = {};
    if (oldVendor.display_name !== newVendor.display_name)
      changes.displayName = { from: oldVendor.display_name, to: newVendor.display_name };
    if (oldVendor.email !== newVendor.email)
      changes.email = { from: oldVendor.email, to: newVendor.email };
    if (oldVendor.phone !== newVendor.phone)
      changes.phone = { from: oldVendor.phone, to: newVendor.phone };

    await eventBus.publish('vendor.profile.updated', {
      eventType: 'vendor.profile.updated',
      aggregateId: vendorId,
      payload: { vendorId, changes },
      occurredAt: new Date(),
    });

    await auditLogger.log({
      actor: { userId: oldVendor.user_id.toString(), role: 'vendor' },
      action: 'VENDOR_PROFILE_UPDATED',
      resource: { type: 'Vendor', id: vendorId },
      changes,
      timestamp: new Date(),
    });
  }
}
