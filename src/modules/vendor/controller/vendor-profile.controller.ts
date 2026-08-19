import { Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { VendorProfileService } from '../service/vendor-profile.service';
import {
  UpdateVendorProfileSchema,
  VendorOnboardingStep1Schema,
  VendorOnboardingStep2Schema,
  VendorOnboardingStep3Schema,
  VendorOnboardingStep4Schema,
} from '../validators/vendor-onboarding.validator';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';
import { vectorisationService } from '../../catalog/domain/services/VectorisationService';
import { policyDocumentUploadService } from '../../catalog/domain/services/media/PolicyDocumentUploadService';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

// Policy documents (return/cancellation/support policy addenda) are a standalone
// upload path — deliberately separate from the product/ticket media pipeline in
// `core/uploads`. Max 2 files, 5MB each, PDF only.
const POLICY_DOCUMENT_MAX_FILES = 2;
const POLICY_DOCUMENT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

export const uploadVendorPolicyDocuments = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: POLICY_DOCUMENT_MAX_FILES,
    fileSize: POLICY_DOCUMENT_MAX_SIZE_BYTES,
  },
}).array('documents', POLICY_DOCUMENT_MAX_FILES);

const SetDefaultDeliveryAgencySchema = z.object({
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId'),
});

const AgencyIdParamSchema = z.object({
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId'),
});

const SetAutoRedirectOrdersSchema = z.object({
  enabled: z.boolean(),
  thresholdAmount: z.number().min(0).nullable().optional(),
});

const SetAutoCancelUnpaidDaysSchema = z.object({
  days: z.number().int().min(1).max(90),
});

const vendorProfileService = new VendorProfileService();
const vendorSettingsRepository = new VendorSettingsRepository();

export class VendorProfileController {
  // ─── Profile ──────────────────────────────────────────────────────────────

  static getProfile = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const profile = await vendorProfileService.getProfile(vendorId);
    res.json({ success: true, data: profile });
  });

  static updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = UpdateVendorProfileSchema.parse(req.body);
    const profile = await vendorProfileService.updateProfile(vendorId, input);
    res.json({ success: true, data: profile, message: 'Profile updated successfully' });
  });

  // Password change moved to the role-agnostic UserController (/api/me/password);
  // the vendor route keeps a deprecated alias pointing at that handler.

  static getCompletionStatus = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const status = await vendorProfileService.getCompletionStatus(vendorId);
    res.json({ success: true, data: status });
  });

  static getOnboardingStatus = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const status = await vendorProfileService.getOnboardingStatus(vendorId);
    res.json({ success: true, data: status });
  });

  static listDeliveryAgencies = asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    const search = (req.query.search as string | undefined)?.trim() || undefined;
    const region = (req.query.region as string | undefined)?.trim() || undefined;
    const hq_city = (req.query.hq_city as string | undefined)?.trim() || undefined;
    const storage_based = req.query.storage_based === 'true' ? true : undefined;
    const pickup_based = req.query.pickup_based === 'true' ? true : undefined;

    const returnsPayerRaw = req.query.returns_payer as string | undefined;
    const returns_payer = (['vendor', 'agency', 'customer'] as const).find(
      (v) => v === returnsPayerRaw,
    );

    const minClaimRaw = parseInt(req.query.min_claim_deadline_days as string);
    const min_claim_deadline_days = !isNaN(minClaimRaw) && minClaimRaw >= 0 ? minClaimRaw : undefined;

    const result = await vendorProfileService.listAvailableAgencies({
      page, limit, search, region, hq_city,
      storage_based, pickup_based, returns_payer, min_claim_deadline_days,
    });

    res.json({ success: true, data: result.agencies, meta: result.meta });
  });

  /**
   * GET /api/vendor/delivery-agencies/:agencyId/locations
   *
   * The agency's depots, for the product editor's "which warehouse holds this?"
   * picker. Unpaginated — an agency has a handful of locations, and a picker that
   * hides options behind a page boundary is worse than no picker.
   */
  static listAgencyLocations = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { agencyId } = AgencyIdParamSchema.parse(req.params);
    const locations = await vendorProfileService.listAgencyLocations(vendorId, agencyId);
    res.json({ success: true, data: locations });
  });

  // ─── Onboarding Step Handlers ─────────────────────────────────────────────

  static completeBasicSetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep1Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep1(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Basic setup completed' });
  });

  static completeDeliveryLinking = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep2Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep2(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Delivery linking completed' });
  });

  static completeBrandingSetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep3Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep3(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Branding setup completed' });
  });

  static completePolicySetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep4Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep4(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Policy setup completed' });
  });

  /**
   * POST /api/vendor/profile/policy-documents
   * Upload 1-2 supporting PDF documents (max 5MB each) for `policies.documents`.
   * Standalone upload — not part of the product/ticket media pipeline. Returns
   * public URLs to submit back via the policy-setup / profile-update endpoints.
   */
  static uploadPolicyDocuments = asyncHandler(async (req: Request, res: Response) => {
    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      throw createAppError(
        ERROR_CODES.VENDOR_POLICY_DOCUMENT_MISSING, 400,
        'At least one document is required (field name "documents")',
      );
    }

    /*
     * The claimed-type check stays, and it is now a CHEAP PRE-FILTER rather than the only
     * gate. It answers a wrong file type with this endpoint's own documented code before any
     * bytes are scanned or stored; the pipeline then re-checks against the **sniffed** type,
     * which is the check that actually decides. Keeping both is deliberate — dropping this
     * one would change a documented 400 into a generic UPLOAD_POLICY_VIOLATION for every
     * vendor who picks the wrong file.
     */
    for (const file of req.files) {
      if (file.mimetype !== 'application/pdf') {
        throw createAppError(
          ERROR_CODES.VENDOR_POLICY_DOCUMENT_TYPE_INVALID, 400,
          `File "${file.originalname}" must be a PDF`,
        );
      }
    }

    /*
     * ⚠ This used to call `storageProvider.put` DIRECTLY — no virus scan, no magic-byte
     * sniffing, no fingerprint, no quota (plan step 4.A.4c / 25.2, the last of S-2). The only
     * gate was the loop above, on a MIME type the client chose: anything named `.pdf` and
     * declared `application/pdf` was stored and handed back as a public URL that this vendor
     * then republishes to their counterparties.
     *
     * `{ urls }` is unchanged, so nothing on the wire moves.
     */
    const urls = await policyDocumentUploadService.upload(
      'vendor',
      req.auth!.role_entity._id.toString(),
      req.auth!.user._id.toString(),
      req.files.map((file) => ({
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
      })),
    );

    res.status(201).json({ success: true, data: { urls }, message: `Uploaded ${urls.length} document(s)` });
  });

  // ─── Default Delivery Agency ────────────────────────────────────────────

  static getDefaultDeliveryAgency = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const data = await vendorProfileService.getDefaultDeliveryAgency(vendorId);
    res.json({ success: true, data });
  });

  static setDefaultDeliveryAgency = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = SetDefaultDeliveryAgencySchema.parse(req.body);
    const { agency, restoredProducts, reassignedOrders } = await vendorProfileService.setDefaultDeliveryAgency(vendorId, input.agencyId);

    const message = reassignedOrders.reassignedCount > 0
      ? `Default delivery agency updated successfully. ${reassignedOrders.reassignedCount} pending order item(s) reassigned to the new agency.`
      : 'Default delivery agency updated successfully';

    res.json({
      success: true,
      data: agency,
      meta: { reassignedOrderItems: reassignedOrders.reassignedCount, skippedOrderItems: reassignedOrders.skipped },
      message,
    });

    for (const product of restoredProducts) {
      void vectorisationService.notifyStatusChange(product.productId, product.status);
    }
  });

  // ─── Auto-redirect Orders To Agency ─────────────────────────────────────

  static getAutoRedirectOrders = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const enabled = await vendorSettingsRepository.getAutoRedirectOrdersToAgency(vendorId);
    const thresholdAmount = await vendorSettingsRepository.getAutoRedirectThresholdAmount(vendorId);
    res.json({
      success: true,
      data: { autoRedirectOrdersToAgency: enabled, autoRedirectThresholdAmount: thresholdAmount },
    });
  });

  static setAutoRedirectOrders = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { enabled, thresholdAmount } = SetAutoRedirectOrdersSchema.parse(req.body);
    const updated = await vendorSettingsRepository.setAutoRedirectOrdersToAgency(vendorId, enabled);
    // Only touch the threshold when the caller explicitly provided it (including null to clear it).
    const threshold =
      thresholdAmount !== undefined
        ? await vendorSettingsRepository.setAutoRedirectThresholdAmount(vendorId, thresholdAmount)
        : await vendorSettingsRepository.getAutoRedirectThresholdAmount(vendorId);
    res.json({
      success: true,
      data: { autoRedirectOrdersToAgency: updated, autoRedirectThresholdAmount: threshold },
      message: 'Auto-redirect orders setting updated',
    });
  });

  // ─── Auto-cancel Unpaid Orders ──────────────────────────────────────────

  static getAutoCancelUnpaidDays = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const days = await vendorSettingsRepository.getAutoCancelUnpaidDays(vendorId);
    res.json({ success: true, data: { autoCancelUnpaidDays: days } });
  });

  static setAutoCancelUnpaidDays = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { days } = SetAutoCancelUnpaidDaysSchema.parse(req.body);
    const updated = await vendorSettingsRepository.setAutoCancelUnpaidDays(vendorId, days);
    res.json({
      success: true,
      data: { autoCancelUnpaidDays: updated },
      message: 'Auto-cancel unpaid orders setting updated',
    });
  });
}

