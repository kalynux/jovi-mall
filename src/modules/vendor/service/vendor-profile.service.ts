import mongoose from 'mongoose';
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
import { withGeoAddress } from '../../../core/types/geo-address.types';
import { assertGeoInCountry, geoAddressEquals } from '../../../core/validation/address-country.helper';
import { StoreProvisioningService } from '../../store/service/store-provisioning.service';
import { StoreRepository } from '../../store/repositories/store.repository';
import { IStore } from '../../store/models/store.model';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { DeliveryAgencyRepository, AgencyListQueryParams } from '../../delivery/delivery-agency.repository';
import { IDeliveryAgency } from '../../delivery/delivery-agency.model';
import { TransactionManager, transactionManager } from '../../../core/database/transaction.manager';
import { ProductDeliveryAgencySuspensionService } from '../../catalog/domain/services/ProductDeliveryAgencySuspensionService';
import { ProductStatus } from '../../catalog/models/product.model';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { resolveFileDetail, resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { VendorOrderService } from '../../orders/vendor-order.service';
import { ConnectionService } from '../../agency-connections/connection.service';
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
  private txManager: TransactionManager;
  private suspensionService: ProductDeliveryAgencySuspensionService;
  private vendorOrderService: VendorOrderService;
  private connectionService: ConnectionService;
  private productRepo: ProductRepositoryMongo;
  private fileRepository: FileRepositoryMongo;
  private fileReferenceService: FileReferenceService;
  private storageProvider: IStorageProvider;
  private storeProvisioningService: StoreProvisioningService;
  private storeRepo: StoreRepository;
  private magazinRepo: MagazinRepository;

  constructor() {
    this.vendorRepo = new VendorRepository();
    this.txManager = transactionManager;
    this.suspensionService = new ProductDeliveryAgencySuspensionService();
    this.vendorOrderService = new VendorOrderService();
    this.connectionService = new ConnectionService();
    this.productRepo = new ProductRepositoryMongo();
    this.fileRepository = new FileRepositoryMongo();
    this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
    this.storageProvider = getStorageProvider();
    this.storeProvisioningService = new StoreProvisioningService();
    this.storeRepo = new StoreRepository();
    this.magazinRepo = new MagazinRepository();
  }

  /**
   * Apply an onboarding branding change (logo/cover) to the vendor's STORE — the
   * business branding's single source of truth. Get-or-create the store,
   * reconcile the logo (→ store.logo) and cover (→ store.banner) file references,
   * then persist. The vendor profile no longer holds any branding. Runs the
   * reconcile before the write so an unauthorized file reference is rejected
   * before it is persisted. A slot is only touched when its field is present.
   */
  private async applyBrandingToStore(
    vendorId: string,
    branding: { logo_file_id?: string | null; cover_image_file_id?: string | null },
  ): Promise<void> {
    const store = await this.storeProvisioningService.ensureStoreForVendor(vendorId);
    const updates: Partial<IStore> = {};

    if (branding.logo_file_id !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: store.logo_file_id ? [store.logo_file_id.toString()] : [],
        nextFileIds: branding.logo_file_id ? [branding.logo_file_id] : [],
        actor: { type: 'vendor', id: vendorId },
        entityType: 'store',
        entityId: store._id.toString(),
        field: 'logo',
      });
      updates.logo_file_id = branding.logo_file_id ? new mongoose.Types.ObjectId(branding.logo_file_id) : null;
    }

    if (branding.cover_image_file_id !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: store.banner_file_id ? [store.banner_file_id.toString()] : [],
        nextFileIds: branding.cover_image_file_id ? [branding.cover_image_file_id] : [],
        actor: { type: 'vendor', id: vendorId },
        entityType: 'store',
        entityId: store._id.toString(),
        field: 'banner',
      });
      updates.banner_file_id = branding.cover_image_file_id ? new mongoose.Types.ObjectId(branding.cover_image_file_id) : null;
    }

    if (Object.keys(updates).length > 0) {
      await this.storeRepo.updateByVendorId(vendorId, store.version, updates);
    }
  }

  /**
   * Keep `file_references` in sync with the vendor's personal profile avatar
   * (a File reference distinct from the business logo/cover). Same reconcile
   * primitive as branding — authorizes the newly-attached file and detaches the
   * previous one — under `entityType: 'vendor', field: 'avatar'`.
   */
  private async reconcileAvatarFileReference(
    vendorId: string,
    previous: IVendor['avatar_file_id'] | undefined,
    next: string | null | undefined,
  ): Promise<void> {
    await this.fileReferenceService.reconcile({
      previousFileIds: previous ? [previous.toString()] : [],
      nextFileIds: next ? [next] : [],
      actor: { type: 'vendor', id: vendorId },
      entityType: 'vendor',
      entityId: vendorId,
      field: 'avatar',
    });
  }

  /**
   * Blocks removing a business address that's still set as a physical
   * product's pickup location — otherwise the delivery agency is left with a
   * dangling address reference. `newAddresses` is the raw (pre-persistence)
   * request payload: entries being edited carry their existing `_id`, new
   * entries don't have one yet — either way, any previous id absent from this
   * set is being removed.
   */
  private async assertRemovedAddressesNotInUse(
    vendorId: string,
    previousAddresses: IVendor['business_addresses'] | undefined,
    newAddresses: Array<{ _id?: string }> | undefined,
  ): Promise<void> {
    const newIds = new Set((newAddresses ?? []).map(a => a._id).filter((id): id is string => !!id));
    const removedAddresses = (previousAddresses ?? []).filter(a => !newIds.has(a._id.toString()));
    if (removedAddresses.length === 0) return;

    const productCounts = await this.productRepo.countPhysicalByVendorAndPickupAddresses(
      vendorId,
      removedAddresses.map(a => a._id.toString()),
    );

    const blockedAddresses = removedAddresses
      .map(a => ({
        addressId: a._id.toString(),
        label: a.label,
        productCount: productCounts[a._id.toString()] ?? 0,
      }))
      .filter(a => a.productCount > 0);

    if (blockedAddresses.length > 0) {
      throw createAppError(
        ERROR_CODES.VENDOR_BUSINESS_ADDRESS_IN_USE,
        409,
        'One or more business addresses you removed are still set as a pickup location on a product. Reassign or remove that pickup location first.',
        { blockedAddresses },
      );
    }
  }

  /**
   * Business addresses are the vendor's physical store locations (and pickup
   * points), so each must be geolocatable and inside the vendor's registered
   * country. Every NEW or EDITED entry in this full-replace array must carry a
   * geocoded `geo` whose country matches; entries echoed back byte-identical to
   * what is stored (same loose fields, same geo) are grandfathered — legacy
   * plain-text addresses keep working until the vendor next touches them.
   */
  private assertBusinessAddressesInCountry(
    country: string | null | undefined,
    incoming: NonNullable<UpdateVendorProfileInput['business_addresses']>,
    existing: IVendor['business_addresses'] | undefined,
  ): void {
    const previous = existing ?? [];
    incoming.forEach((entry, index) => {
      const match = entry._id
        ? previous.find((p) => p._id.toString() === entry._id)
        : undefined;
      const unchanged =
        !!match &&
        entry.label === match.label &&
        entry.address_line1 === match.address_line1 &&
        (entry.address_line2 ?? null) === (match.address_line2 ?? null) &&
        entry.city === match.city &&
        (entry.state ?? null) === (match.state ?? null) &&
        geoAddressEquals(entry.geo, match.geo);
      if (unchanged) return;

      assertGeoInCountry(entry.geo, country ?? null, { index, label: entry.label ?? null });
    });
  }

  /**
   * Country anchors the address policy above, so it is SET-ONCE: choose it in
   * onboarding Step 1, never change it after. Changing it while addresses
   * already resolve elsewhere would silently orphan them.
   */
  private assertCountryUnchangedOrFirstSet(vendor: IVendor, incomingCountry: string | undefined): void {
    if (incomingCountry === undefined) return;
    if (vendor.country && incomingCountry !== vendor.country) {
      throw createAppError(
        ERROR_CODES.PROFILE_COUNTRY_IMMUTABLE,
        403,
        'Country cannot be changed once set. It was fixed during onboarding for tax, shipping and address policy.',
        { currentCountry: vendor.country },
      );
    }
  }

  /**
   * Guard for the rare case where the country is (re)set while geocoded
   * business addresses already exist — every one of them must resolve inside
   * the new country, or the change is rejected. Addresses without a geo are
   * unverifiable legacy entries and don't block.
   */
  private assertExistingAddressesMatchCountry(vendor: IVendor, newCountry: string): void {
    const mismatched = (vendor.business_addresses ?? [])
      .filter((a) => a.geo?.components?.country_code && a.geo.components.country_code.toUpperCase() !== newCountry.toUpperCase())
      .map((a) => ({ addressId: a._id.toString(), label: a.label, countryCode: a.geo!.components.country_code }));

    if (mismatched.length > 0) {
      throw createAppError(
        ERROR_CODES.ADDRESS_COUNTRY_MISMATCH,
        400,
        `You already have business addresses located outside ${newCountry.toUpperCase()}. Remove or re-pick them before changing your country.`,
        { mismatchedAddresses: mismatched, requiredCountry: newCountry.toUpperCase() },
      );
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  async getProfile(vendorId: string): Promise<GetVendorProfileResponseDto> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');
    return VendorProfileMapper.toResponseDto(vendor, this.fileRepository, this.storageProvider);
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

    // POLICY: Feature flags for notification preferences.
    // WhatsApp is available on ALL plans — usage is metered via credits at send
    // time (see CreditWalletService), not gated here. Phone/SMS remains disabled
    // platform-wide (no SMS provider integrated yet).
    if (input.notificationPreferences) {
      if (
        input.notificationPreferences.phone &&
        !VendorConfig.ENABLE_PHONE_NOTIFICATIONS
      ) {
        throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Phone notifications are not available on your current plan.');
      }
    }

    // POLICY: Country is set-once (onboarding Step 1) — reject changes, allow
    // an idempotent echo of the current value or a first set on legacy rows.
    this.assertCountryUnchangedOrFirstSet(vendor, input.country);
    if (input.country !== undefined && !vendor.country) {
      // First set on a legacy profile — existing geocoded addresses must fit.
      this.assertExistingAddressesMatchCountry(vendor, input.country);
    }

    if (input.business_addresses !== undefined) {
      await this.assertRemovedAddressesNotInUse(vendorId, vendor.business_addresses, input.business_addresses);
      this.assertBusinessAddressesInCountry(
        input.country ?? vendor.country ?? null,
        input.business_addresses,
        vendor.business_addresses,
      );
    }

    if (input.avatarFileId !== undefined) {
      await this.reconcileAvatarFileReference(vendorId, vendor.avatar_file_id, input.avatarFileId);
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

    // Policies just changed value — bump the policy-change counter and pause any
    // active agency connections so the agency is prompted to reapprove. Only pays
    // the transaction cost when a change is actually detected.
    if (JSON.stringify(updated.policies) !== JSON.stringify(vendor.policies)) {
      await this.txManager.runInTransaction(async (session) => {
        await this.vendorRepo.incrementPolicyVersion(vendorId, session);
        await this.connectionService.pauseConnectionsForPolicyChange('vendor', vendorId, session);
      });
    }

    await this.emitUpdateEvent(vendor, updated, vendorId);
    return VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider);
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

    // Country may still be corrected while onboarding is in progress (it locks
    // at completion), but never in a way that orphans geocoded addresses the
    // vendor already added in Step 3.
    if (input.country !== vendor.country) {
      this.assertExistingAddressesMatchCountry(vendor, input.country);
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
        profile: await VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
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

    // Provision the vendor's storefront record. Best-effort: the store module
    // also get-or-creates on first access, so a failure here must not fail
    // onboarding.
    void this.storeProvisioningService.ensureStoreForVendor(vendorId).catch((err) => {
      console.error(`[VendorProfileService] store provisioning failed for vendor ${vendorId}:`, err);
    });

    await this.auditOnboardingStep(vendorId, 'BASIC_SETUP', 1, newStep);
    return {
      profile: await VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  /**
   * Step 2: Delivery Linking (Optional/Skippable).
   *
   * Pure step-advance — no agency data is written here. Vendors search for and
   * request agencies via the agency-connections endpoints (independent of
   * onboarding-step completion, since approval is async and can't gate it); the
   * vendor's default_delivery_agency_id is set automatically the moment their
   * FIRST connection is approved (see ConnectionService.finalizeApproval). See
   * setDefaultDeliveryAgency() for how a vendor changes their default later.
   *
   * Behaviour:
   * - First time (step === 2): advances step to 3 (BRANDING).
   * - Re-edit (step > 2, not COMPLETED): no-op, returns current state.
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

    // Re-edit mode: already past step 2 (on step 3) — nothing to save anymore.
    if (vendor.onboarding_step > VendorOnboardingStep.DELIVERY_LINKING) {
      await this.auditOnboardingStep(vendorId, 'DELIVERY_LINKING_DATA_UPDATED', 2, vendor.onboarding_step);
      return {
        profile: await VendorProfileMapper.toResponseDto(vendor, this.fileRepository, this.storageProvider),
        completionStatus: this.buildCompletionStatus(vendor),
      };
    }

    // First-time completion: advance to BRANDING.
    const newStep = VendorOnboardingStep.BRANDING;
    const updated = await this.vendorRepo.atomicOnboardingUpdate(vendorId, { onboarding_step: newStep }, expectedVersion);
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);

    await this.auditOnboardingStep(vendorId, 'DELIVERY_LINKING', 2, newStep);
    return {
      profile: await VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
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
      if (input.branding) {
        // Business branding (logo/cover) lives on the Store, not the vendor.
        await this.applyBrandingToStore(vendorId, input.branding);
      }
      if (input.business_addresses) {
        await this.assertRemovedAddressesNotInUse(vendorId, vendor.business_addresses, input.business_addresses);
        this.assertBusinessAddressesInCountry(vendor.country ?? null, input.business_addresses, vendor.business_addresses);
        // `_id` (when provided) is a hex string here — Mongoose casts it to
        // ObjectId on write, preserving identity instead of minting a new one.
        // `withGeoAddress` normalises each entry's selected geo result into a
        // persistable GeoAddress (assigns resolved_at, null-fills components).
        brandingData.business_addresses = input.business_addresses.map(withGeoAddress) as unknown as IVendor['business_addresses'];
      }
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
        profile: await VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
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
      profile: await VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
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
        documents: input.documents ?? [],
      };
      if (policies.return_policy || policies.cancellation_policy || policies.support_policy || (policies.documents?.length ?? 0) > 0) {
        updates.policies = policies;
      }
    }

    const updated = await this.vendorRepo.atomicOnboardingUpdate(vendorId, updates, expectedVersion);
    if (!updated) throw createAppError(ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION, 409);

    // Same policy-change hook as updateProfile() — a no-op if no connections
    // exist yet, which is the common case for a first-time onboarding submit.
    if (updates.policies) {
      await this.txManager.runInTransaction(async (session) => {
        await this.vendorRepo.incrementPolicyVersion(vendorId, session);
        await this.connectionService.pauseConnectionsForPolicyChange('vendor', vendorId, session);
      });
    }

    await this.auditOnboardingStep(vendorId, 'POLICY_SETUP', 4, VendorOnboardingStep.COMPLETED);
    return {
      profile: await VendorProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
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
      !!vendor.payout_details?.length;

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
    if (!vendor.payout_details?.length) missing.push('payout_details');
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

    return this.toVendorAgencyDto(agency);
  }

  /** Map one agency to the vendor-facing DTO, resolving its business name + logo from the Magazin. */
  private async toVendorAgencyDto(agency: IDeliveryAgency): Promise<VendorAgencyListItemDto> {
    const magazin = await this.magazinRepo.findByAgencyIdOrNull(agency._id.toString());
    const logo = await resolveFileDetail(magazin?.logo_file_id?.toString(), this.fileRepository, this.storageProvider);
    return VendorAgencyMapper.toListItemDto(agency, magazin, logo);
  }

  /**
   * Set the vendor's default delivery agency. The agency must exist, be active,
   * and have completed its own onboarding — matching the rules already enforced
   * in the onboarding flow.
   *
   * Vendors can only change their default, never clear it to null — the only way
   * a default becomes unset is a system cascade (see AdminAgencyService.deactivate).
   *
   * If the newly-set agency is active, restores any of the vendor's physical products
   * that were suspended for 'default_delivery_agency_removed', each back to its own
   * saved previous status. A pending_verification agency is a valid choice but doesn't
   * satisfy the activation gate, so no restore fires until it becomes active.
   *
   * Also auto-reassigns any of the vendor's still-pending/assigned order items that
   * were riding on the OLD default agency over to the new one (skipping items whose
   * product has its own explicit agency override — see
   * VendorOrderService.reassignItemsFromDefaultAgency). This runs AFTER the
   * transaction commits — shipment/order writes in that flow aren't session-aware,
   * matching their existing non-transactional behavior — so it's best-effort and its
   * outcome is reported back rather than rolled into the atomic vendor/product update.
   */
  async setDefaultDeliveryAgency(
    vendorId: string,
    agencyId: string,
  ): Promise<{
    agency: VendorAgencyListItemDto;
    restoredProducts: { productId: string; status: ProductStatus }[];
    reassignedOrders: { reassignedCount: number; skipped: { orderId: string; itemId: string; reason: string }[] };
  }> {
    let previousAgencyId: string | null = null;

    const { agency, restoredProducts } = await this.txManager.runInTransaction(async (session) => {
      const vendor = await this.vendorRepo.findById(vendorId);
      if (!vendor) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 404, 'Vendor profile not found');
      previousAgencyId = vendor.default_delivery_agency_id?.toString() ?? null;

      const agencyRepo = new DeliveryAgencyRepository();
      const agency = await agencyRepo.findById(agencyId, session);
      if (!agency) {
        throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'The selected delivery agency does not exist.');
      }
      if (agency.status === 'inactive') {
        throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 400, 'The selected delivery agency is inactive.');
      }
      if (agency.onboarding_step !== 0) {
        throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 400, 'The selected delivery agency has not completed its onboarding.');
      }

      const connection = await this.connectionService.findByVendorAndAgency(vendorId, agencyId);
      if (!connection || connection.status !== 'active') {
        throw createAppError(
          ERROR_CODES.CONNECTION_NOT_ACTIVE,
          422,
          'You need an active, approved connection with this agency before setting it as your default. Send or check your connection request first.',
        );
      }

      await this.vendorRepo.updateProfile(vendorId, {
        default_delivery_agency_id: agencyId as unknown as IVendor['default_delivery_agency_id'],
      }, session);

      const restoredProducts = agency.status === 'active'
        ? await this.suspensionService.restoreForVendor(vendorId, { session })
        : [];

      return { agency: await this.toVendorAgencyDto(agency), restoredProducts };
    });

    const reassignedOrders = (previousAgencyId && previousAgencyId !== agencyId)
      ? await this.vendorOrderService.reassignItemsFromDefaultAgency(vendorId, previousAgencyId, agencyId)
      : { reassignedCount: 0, skipped: [] };

    return { agency, restoredProducts, reassignedOrders };
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

    // Business name/logo come from the joined Magazin. Batch-resolve logos.
    const detailByFileId = await resolveFileDetails(
      agencies.map(a => a.magazin?.logo_file_id?.toString() ?? null),
      this.fileRepository,
      this.storageProvider,
    );

    return {
      agencies: agencies.map(a => {
        const fileId = a.magazin?.logo_file_id?.toString();
        return VendorAgencyMapper.toListItemDto(
          a,
          a.magazin ?? null,
          fileId ? detailByFileId.get(fileId) ?? null : null,
        );
      }),
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
