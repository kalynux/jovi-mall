import { VendorRepository } from '../../vendors/vendor.repository';
import { VendorProfileMapper, GetVendorProfileResponseDto, VendorCompletionStatusDto, VendorOnboardingStatusDto } from '../dto/vendor-profile.dto';
import { VendorAgencyMapper, VendorAgencyListItemDto, AgencyListMeta } from '../dto/vendor-agency.dto';
import { VendorConfig } from '../config/vendor.config';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { VendorOnboardingStep, VendorOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import { IVendor, IVendorPolicies, IVendorSupportChannel, IVendorSupportPolicy } from '../../vendors/vendor.model';
import { DeliveryAgencyRepository, AgencyListQueryParams } from '../../delivery/delivery-agency.repository';
import {
  UpdateVendorProfileInput,
  VendorOnboardingStep1Input,
  VendorOnboardingStep2Input,
  VendorOnboardingStep3Input,
  VendorOnboardingStep4Input,
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

  async getOnboardingStatus(vendorId: string): Promise<VendorOnboardingStatusDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');
    return VendorProfileMapper.toOnboardingStatusDto(vendor);
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
   * Step 1: Basic Setup (country, timezone, payout_details)
   *
   * Behaviour:
   * - First time (step === 1): saves data, advances step to 2 (DELIVERY_LINKING).
   * - Re-edit (step > 1, not COMPLETED): saves new data, keeps current step unchanged.
   * - Already COMPLETED: 409.
   */
  async completeStep1(
    vendorId: string,
    input: VendorOnboardingStep1Input,
    expectedVersion?: number,
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    if (vendor.onboarding_step === VendorOnboardingStep.COMPLETED) {
      throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_ALREADY_COMPLETED, 409);
    }

    const data = {
      country: input.country,
      timezone: input.timezone,
      payout_details: input.payout_details as IVendor['payout_details'],
    };

    // Re-edit mode: already past step 1 — save data, keep current step unchanged.
    if (vendor.onboarding_step > VendorOnboardingStep.BASIC_SETUP) {
      const updated = await this.vendorRepo.atomicOnboardingUpdate(
        vendorId,
        { ...data, onboarding_step: vendor.onboarding_step as VendorOnboardingStepValue },
        expectedVersion,
      );
      if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);
      await this.auditOnboardingStep(vendorId, 'BASIC_SETUP_DATA_UPDATED', 1, vendor.onboarding_step);
      return {
        profile: VendorProfileMapper.toResponseDto(updated),
        completionStatus: this.buildCompletionStatus(updated),
      };
    }

    // First-time completion: save data + advance to DELIVERY_LINKING.
    const newStep = VendorOnboardingStep.DELIVERY_LINKING;
    const updated = await this.vendorRepo.atomicOnboardingUpdate(
      vendorId,
      { ...data, onboarding_step: newStep },
      expectedVersion,
    );
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);

    await this.auditOnboardingStep(vendorId, 'BASIC_SETUP', 1, newStep);
    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Step 2: Delivery Linking (Optional/Skippable).
   *
   * Behaviour:
   * - First time (step === 2): saves agency ID (or skips), advances step to 3 (BRANDING).
   * - Re-edit (step > 2, not COMPLETED): saves new agency ID (or no-op if skip), keeps current step.
   * - Step 1 not done (step < 2): 400 STEP_INCOMPLETE.
   * - Already COMPLETED: 409.
   */
  async completeStep2(
    vendorId: string,
    input: VendorOnboardingStep2Input,
    expectedVersion?: number,
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    if (vendor.onboarding_step === VendorOnboardingStep.COMPLETED) {
      throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_ALREADY_COMPLETED, 409);
    }

    if (vendor.onboarding_step < VendorOnboardingStep.DELIVERY_LINKING) {
      throw createAppError(
        ERROR_CODES.VENDOR_ONBOARDING_STEP_INCOMPLETE, 400,
        'You must complete Basic Setup (step 1) before Delivery Linking',
      );
    }

    // Validate agency eligibility when an ID is provided (applies in both first-time and re-edit).
    if (!input.skip && input.default_delivery_agency_id) {
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
    }

    // Re-edit mode: already past step 2 (on step 3) — save data, keep current step.
    if (vendor.onboarding_step > VendorOnboardingStep.DELIVERY_LINKING) {
      if (!input.skip && input.default_delivery_agency_id) {
        const updated = await this.vendorRepo.atomicOnboardingUpdate(
          vendorId,
          {
            default_delivery_agency_id: input.default_delivery_agency_id as unknown as IVendor['default_delivery_agency_id'],
            onboarding_step: vendor.onboarding_step as VendorOnboardingStepValue,
          },
          expectedVersion,
        );
        if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);
        await this.auditOnboardingStep(vendorId, 'DELIVERY_LINKING_DATA_UPDATED', 2, vendor.onboarding_step);
        return {
          profile: VendorProfileMapper.toResponseDto(updated),
          completionStatus: this.buildCompletionStatus(updated),
        };
      }
      // skip=true in re-edit: no data to change, just return current state.
      await this.auditOnboardingStep(vendorId, 'DELIVERY_LINKING_DATA_UPDATED', 2, vendor.onboarding_step);
      return {
        profile: VendorProfileMapper.toResponseDto(vendor),
        completionStatus: this.buildCompletionStatus(vendor),
      };
    }

    // First-time completion: save agency ID (if provided) + advance to BRANDING.
    const newStep = VendorOnboardingStep.BRANDING;
    const updateData: Partial<IVendor> & { onboarding_step: VendorOnboardingStepValue } = { onboarding_step: newStep };
    if (!input.skip && input.default_delivery_agency_id) {
      updateData.default_delivery_agency_id = input.default_delivery_agency_id as unknown as IVendor['default_delivery_agency_id'];
    }

    const updated = await this.vendorRepo.atomicOnboardingUpdate(vendorId, updateData, expectedVersion);
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);

    await this.auditOnboardingStep(vendorId, 'DELIVERY_LINKING', 2, newStep);
    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Step 3: Branding (Optional/Skippable).
   *
   * Behaviour:
   * - First time (step === 3): saves branding/addresses (or skips), advances to POLICY_SETUP (4).
   * - Re-edit (step > 3, not COMPLETED): saves new data, keeps current step unchanged.
   * - Steps 1 or 2 not done (step < 3): 400 STEP_INCOMPLETE.
   * - Already COMPLETED: 409.
   */
  async completeStep3(
    vendorId: string,
    input: VendorOnboardingStep3Input,
    expectedVersion?: number,
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    if (vendor.onboarding_step === VendorOnboardingStep.COMPLETED) {
      throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_ALREADY_COMPLETED, 409);
    }

    if (vendor.onboarding_step < VendorOnboardingStep.BRANDING) {
      throw createAppError(
        ERROR_CODES.VENDOR_ONBOARDING_STEP_INCOMPLETE, 400,
        'You must complete Basic Setup and Delivery Linking before Branding',
      );
    }

    const brandingData: Partial<IVendor> = {};
    if (!input.skip) {
      if (input.branding) brandingData.branding = input.branding as IVendor['branding'];
      if (input.business_addresses)
        brandingData.business_addresses = input.business_addresses as IVendor['business_addresses'];
    }

    // Re-edit mode: already past step 3 (on step 4) — save data, keep current step.
    if (vendor.onboarding_step > VendorOnboardingStep.BRANDING) {
      const updated = await this.vendorRepo.atomicOnboardingUpdate(
        vendorId,
        { ...brandingData, onboarding_step: vendor.onboarding_step as VendorOnboardingStepValue },
        expectedVersion,
      );
      if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);
      await this.auditOnboardingStep(vendorId, 'BRANDING_DATA_UPDATED', 3, vendor.onboarding_step);
      return {
        profile: VendorProfileMapper.toResponseDto(updated),
        completionStatus: this.buildCompletionStatus(updated),
      };
    }

    // First-time completion: save data + advance to POLICY_SETUP.
    const newStep = VendorOnboardingStep.POLICY_SETUP;
    const updates: Partial<IVendor> & { onboarding_step: VendorOnboardingStepValue } = {
      ...brandingData,
      onboarding_step: newStep,
    };

    const updated = await this.vendorRepo.atomicOnboardingUpdate(vendorId, updates, expectedVersion);
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);

    await this.auditOnboardingStep(vendorId, 'BRANDING', 3, newStep);
    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Step 4: Policy Setup (Optional/Skippable).
   *
   * Behaviour:
   * - First time (step === 4): saves policies (or skips), advances to COMPLETED (0).
   * - Steps 1–3 not done (step < 4): 400 STEP_INCOMPLETE.
   * - Already COMPLETED: 409.
   */
  async completeStep4(
    vendorId: string,
    input: VendorOnboardingStep4Input,
    expectedVersion?: number,
  ): Promise<{ profile: GetVendorProfileResponseDto; completionStatus: VendorCompletionStatusDto }> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    if (vendor.onboarding_step === VendorOnboardingStep.COMPLETED) {
      throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_ALREADY_COMPLETED, 409);
    }

    if (vendor.onboarding_step < VendorOnboardingStep.POLICY_SETUP) {
      throw createAppError(
        ERROR_CODES.VENDOR_ONBOARDING_STEP_INCOMPLETE, 400,
        'You must complete Basic Setup, Delivery Linking, and Branding before Policy Setup',
      );
    }

    const updates: Partial<IVendor> & { onboarding_step: VendorOnboardingStepValue } = {
      onboarding_step: VendorOnboardingStep.COMPLETED,
    };

    if (!input.skip) {
      const policies: IVendorPolicies = {
        return_policy: input.return_policy
          ? {
            ...input.return_policy,
            return_condition_notes: input.return_policy.return_condition_notes ?? null,
            refund_percentage: input.return_policy.refund_percentage ?? null,
          }
          : null,
        cancellation_policy: input.cancellation_policy
          ? {
            cancellable: input.cancellation_policy.cancellable,
            cancellation_deadline: input.cancellation_policy.cancellation_deadline ?? null,
            cancellation_deadline_days: input.cancellation_policy.cancellation_deadline_days ?? null,
            cancellation_fee_type: input.cancellation_policy.cancellation_fee_type ?? null,
            cancellation_fee_value: input.cancellation_policy.cancellation_fee_value ?? null,
            late_cancellation_refund_type: input.cancellation_policy.late_cancellation_refund_type ?? null,
            late_cancellation_refund_value: input.cancellation_policy.late_cancellation_refund_value ?? null,
          }
          : null,
        support_policy: input.support_policy
          ? {
            channels: (input.support_policy.channels ?? []) as IVendorSupportChannel[],
            eligibility_notes: input.support_policy.eligibility_notes ?? null,
            required_info: (input.support_policy.required_info ?? []) as IVendorSupportPolicy['required_info'],
            availability: input.support_policy.availability ?? null,
            availability_description: input.support_policy.availability_description ?? null,
            languages: input.support_policy.languages ?? [],
          }
          : null,
      };
      if (policies.return_policy || policies.cancellation_policy || policies.support_policy) {
        updates.policies = policies;
      }
    }

    const updated = await this.vendorRepo.atomicOnboardingUpdate(vendorId, updates, expectedVersion);
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);

    await this.auditOnboardingStep(vendorId, 'POLICY_SETUP', 4, VendorOnboardingStep.COMPLETED);
    return {
      profile: VendorProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Recalculate onboarding_step from field presence.
   * Used only by general profile updates (updateProfile) — step handlers use
   * explicit step constants instead.
   */
  private recalculateOnboardingStep(vendor: IVendor): VendorOnboardingStepValue {
    const step1Complete =
      !!vendor.country &&
      !!vendor.timezone &&
      !!vendor.payout_details;

    if (!step1Complete) return VendorOnboardingStep.BASIC_SETUP;

    // Step 1 just became complete via a general profile update — advance to step 2.
    if (vendor.onboarding_step === VendorOnboardingStep.BASIC_SETUP) {
      return VendorOnboardingStep.DELIVERY_LINKING;
    }

    // Optional steps: stay on whatever step the vendor is currently on.
    if (vendor.onboarding_step === VendorOnboardingStep.DELIVERY_LINKING) {
      return VendorOnboardingStep.DELIVERY_LINKING;
    }
    if (vendor.onboarding_step === VendorOnboardingStep.BRANDING) {
      return VendorOnboardingStep.BRANDING;
    }
    if (vendor.onboarding_step === VendorOnboardingStep.POLICY_SETUP) {
      return VendorOnboardingStep.POLICY_SETUP;
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
      4: 'Policy Setup (Optional)',
    };

    return {
      onboardingStep: step,
      isComplete: step === VendorOnboardingStep.COMPLETED,
      missingFields: missing,
      stepLabel: stepLabels[step] ?? `Step ${step}`,
    };
  }

  private async auditOnboardingStep(
    vendorId: string,
    stepName: string,
    stepNumber: number,
    newStep: number,
  ): Promise<void> {
    await auditLogger.log({
      actor: { userId: vendorId, role: 'vendor' },
      action: 'VENDOR_ONBOARDING_STEP_COMPLETED',
      resource: { type: 'Vendor', id: vendorId },
      changes: { step: { name: stepName, number: stepNumber }, newOnboardingStep: newStep },
      timestamp: new Date(),
    });
  }

  // ─── Default Delivery Agency ──────────────────────────────────────────────

  /**
   * Return the vendor's currently-configured default delivery agency as a
   * vendor-safe DTO. Returns null when no default is set.
   *
   * Used by the frontend to display the agency in profile settings and to
   * preselect it on the product editor.
   */
  async getDefaultDeliveryAgency(vendorId: string): Promise<VendorAgencyListItemDto | null> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    if (!vendor.default_delivery_agency_id) return null;

    const agencyRepo = new DeliveryAgencyRepository();
    const agency = await agencyRepo.findById(vendor.default_delivery_agency_id.toString());
    if (!agency) return null;

    return VendorAgencyMapper.toListItemDto(agency);
  }

  /**
   * Set the vendor's default delivery agency. The agency must exist, be active,
   * and have completed its own onboarding — matching the rules already enforced
   * in the onboarding flow.
   */
  async setDefaultDeliveryAgency(
    vendorId: string,
    agencyId: string,
  ): Promise<VendorAgencyListItemDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    const agencyRepo = new DeliveryAgencyRepository();
    const agency = await agencyRepo.findById(agencyId);
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
      default_delivery_agency_id: agencyId as unknown as IVendor['default_delivery_agency_id'],
    });

    return VendorAgencyMapper.toListItemDto(agency);
  }

  /**
   * Clear the vendor's default delivery agency. Idempotent — succeeds even if
   * no default is currently set.
   */
  async clearDefaultDeliveryAgency(vendorId: string): Promise<void> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');

    await this.vendorRepo.updateProfile(vendorId, {
      default_delivery_agency_id: null as unknown as IVendor['default_delivery_agency_id'],
    });
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
