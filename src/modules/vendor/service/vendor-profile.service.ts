import { VendorRepository } from '../../vendors/vendor.repository';
import { VendorProfileMapper, GetVendorProfileResponseDto, VendorCompletionStatusDto } from '../dto/vendor-profile.dto';
import { VendorAgencyMapper, VendorAgencyListItemDto, AgencyListMeta } from '../dto/vendor-agency.dto';
import { VendorConfig } from '../config/vendor.config';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { VendorOnboardingStep, VendorOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import { IVendor } from '../../vendors/vendor.model';
import { DeliveryAgencyRepository, AgencyListQueryParams } from '../../delivery/delivery-agency.repository';
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
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');
    return VendorProfileMapper.toResponseDto(vendor);
  }

  async getCompletionStatus(vendorId: string): Promise<VendorCompletionStatusDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');
    return this.buildCompletionStatus(vendor);
  }

  // ─── Update (General) ─────────────────────────────────────────────────────

  async updateProfile(
    vendorId: string,
    input: UpdateVendorProfileInput
  ): Promise<GetVendorProfileResponseDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    // POLICY: Email change lock
    if (input.email && input.email !== vendor.email) {
      if (!VendorConfig.ALLOW_EMAIL_CHANGE) {
        throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Email changes are not allowed. Contact support to update your email.');
      }
    }

    // POLICY: Feature flags for notification preferences
    if (input.notificationPreferences) {
      if (
        input.notificationPreferences.whatsapp &&
        !VendorConfig.ENABLE_WHATSAPP_NOTIFICATIONS
      ) {
        throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'WhatsApp notifications are not available on your current plan.');
      }
      if (
        input.notificationPreferences.phone &&
        !VendorConfig.ENABLE_PHONE_NOTIFICATIONS
      ) {
        throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Phone notifications are not available on your current plan.');
      }
    }

    const updatePayload = VendorProfileMapper.toUpdatePayload(input);
    const updated = await this.vendorRepo.updateProfileWithVersion(
      vendorId,
      input.version,
      updatePayload
    );

    if (!updated) {
      throw createAppError(ERROR_CODES.VENDOR_FISCAL_CALENDAR_INVALID, 409, 'Profile was modified by another request. Please refresh and try again.');
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
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    const updated = await this.vendorRepo.updateProfile(vendorId, {
      country: input.country,
      timezone: input.timezone,
      payout_details: input.payout_details as IVendor['payout_details'],
    });
    if (!updated) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor not found after update');

    const newStep = this.recalculateOnboardingStep(updated);
    await this.vendorRepo.updateOnboardingStep(vendorId, newStep);
    updated.onboarding_step = newStep;

    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Complete Step 2: Delivery Linking (Optional/Skippable).
   * - If skip=true: advances to BRANDING without setting a delivery agency.
   * - If default_delivery_agency_id provided: validates the agency is eligible
   *   (exists, not inactive, onboarding completed) then saves it.
   */
  async completeStep2(
    vendorId: string,
    input: VendorOnboardingStep2Input
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    if (!input.skip && input.default_delivery_agency_id) {
      // Validate the selected agency is eligible
      const agencyRepo = new DeliveryAgencyRepository();
      const agency = await agencyRepo.findById(input.default_delivery_agency_id);
      if (!agency) {
        throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'The selected delivery agency does not exist.');
      }
      if (agency.status === 'inactive') {
        throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 400, 'The selected delivery agency is inactive.');
      }
      if (agency.onboarding_step !== 0) {
        throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 400, 'The selected delivery agency has not completed its onboarding.');
      }

      await this.vendorRepo.updateProfile(vendorId, {
        default_delivery_agency_id: input.default_delivery_agency_id as unknown as IVendor['default_delivery_agency_id'],
      });
    }
    // If skip=true: default_delivery_agency_id stays null — no update needed

    // Step 2 is optional — always advance to BRANDING
    await this.vendorRepo.updateOnboardingStep(vendorId, VendorOnboardingStep.BRANDING);
    const finalVendor = await this.vendorRepo.findById(vendorId);
    if (!finalVendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor not found after update');

    return {
      profile: VendorProfileMapper.toResponseDto(finalVendor),
      completionStatus: this.buildCompletionStatus(finalVendor),
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
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

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
    if (!finalVendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor not found');

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
    // Step 1 is required
    const step1Complete =
      !!vendor.country &&
      !!vendor.timezone &&
      !!vendor.payout_details;

    if (!step1Complete) return VendorOnboardingStep.BASIC_SETUP;

    // Step 2 is optional — if the vendor is still on this step, stay here
    // (they must call completeStep2 with skip or an ID to advance)
    if (vendor.onboarding_step === VendorOnboardingStep.DELIVERY_LINKING) {
      return VendorOnboardingStep.DELIVERY_LINKING;
    }

    // Step 3 is optional — if on BRANDING, stay here until completeStep3 is called
    if (vendor.onboarding_step === VendorOnboardingStep.BRANDING) {
      return VendorOnboardingStep.BRANDING;
    }

    return VendorOnboardingStep.COMPLETED;
  }

  private buildCompletionStatus(vendor: IVendor): VendorCompletionStatusDto {
    const missing: string[] = [];

    if (!vendor.country) missing.push('country');
    if (!vendor.payout_details) missing.push('payout_details');
    // default_delivery_agency_id is optional — not flagged as a missing required field

    const step = vendor.onboarding_step;
    const stepLabels: Record<number, string> = {
      0: 'Onboarding Complete',
      1: 'Basic Setup',
      2: 'Delivery Linking (Optional)',
      3: 'Branding (Optional)',
    };

    return {
      onboardingStep: step,
      isComplete: step === VendorOnboardingStep.COMPLETED,
      missingFields: missing,
      stepLabel: stepLabels[step] ?? `Step ${step}`,
    };
  }

  // ─── Agency Listing (Vendor-Facing) ───────────────────────────────────────

  /**
   * List delivery agencies available for vendor selection.
   * Delegates query + filtering to the agency repository.
   * Returns a vendor-safe DTO (no payout/KYC sensitive data).
   */
  async listAvailableAgencies(
    params: AgencyListQueryParams,
  ): Promise<{ agencies: VendorAgencyListItemDto[]; meta: AgencyListMeta }> {
    const agencyRepo = new DeliveryAgencyRepository();
    const { agencies, total } = await agencyRepo.findAvailableForVendors(params);

    return {
      agencies: agencies.map(VendorAgencyMapper.toListItemDto),
      meta: {
        total,
        page: params.page,
        limit: params.limit,
        totalPages: Math.ceil(total / params.limit),
      },
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
