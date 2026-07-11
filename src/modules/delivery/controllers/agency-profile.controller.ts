import { Request, Response } from 'express';
import multer from 'multer';
import { AgencyProfileService } from '../services/agency-profile.service';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import {
    UpdateAgencyProfileSchema,
    AgencyOnboardingStep1Schema,
    AgencyOnboardingStep2Schema,
    AgencyOnboardingStep3Schema,
    AgencyOnboardingStep4Schema,
    CreateAgencySchema,
} from '../validators/agency-onboarding.validator';
import { getStorageProvider } from '../../../core/storage';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

const agencyProfileService = new AgencyProfileService();

// Policy documents (pricing/returns/damage addenda) are a standalone upload path —
// deliberately separate from the product/ticket media pipeline in `core/uploads`.
// Max 2 files, 5MB each, PDF only.
const POLICY_DOCUMENT_MAX_FILES = 2;
const POLICY_DOCUMENT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

export const uploadAgencyPolicyDocuments = multer({
    storage: multer.memoryStorage(),
    limits: {
        files: POLICY_DOCUMENT_MAX_FILES,
        fileSize: POLICY_DOCUMENT_MAX_SIZE_BYTES,
    },
}).array('documents', POLICY_DOCUMENT_MAX_FILES);

/**
 * Agency Profile Controller
 *
 * All handlers use asyncHandler — errors flow to the global error handler.
 * No inline error handling in controller methods.
 */
export class AgencyProfileController {

    // ─── Agency Creation ──────────────────────────────────────────────────────

    /**
     * POST /api/agency
     * Initialize agency onboarding by setting agency_name on the existing doc
     * (created during add-role flow).
     */
    static createAgency = asyncHandler(async (req: Request, res: Response) => {
        const userId = req.auth!.user._id.toString();
        const agencyId = req.auth!.role_entity._id.toString();
        const input = CreateAgencySchema.parse(req.body);
        const result = await agencyProfileService.createAgency(userId, agencyId, input);
        res.status(201).json({ success: true, data: result, message: 'Agency initialized successfully' });
    });

    // ─── Profile ──────────────────────────────────────────────────────────────

    static getProfile = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id.toString();
        const profile = await agencyProfileService.getProfile(agencyId);
        res.json({ success: true, data: profile });
    });

    static updateProfile = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id.toString();
        const input = UpdateAgencyProfileSchema.parse(req.body);
        const profile = await agencyProfileService.updateProfile(agencyId, input);
        res.json({ success: true, data: profile, message: 'Profile updated successfully' });
    });

    // ─── Onboarding Status ────────────────────────────────────────────────────

    static getOnboardingStatus = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id.toString();
        const status = await agencyProfileService.getOnboardingStatus(agencyId);
        res.json({ success: true, data: status });
    });

    static getCompletionStatus = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id.toString();
        const status = await agencyProfileService.getCompletionStatus(agencyId);
        res.json({ success: true, data: status });
    });

    // ─── Onboarding Step Handlers ─────────────────────────────────────────────

    /**
     * PUT /api/agency/onboarding/logistics
     * Step 1: coverage_areas + headquarters_addresses
     */
    static completeLogisticsSetup = asyncHandler(async (req: Request, res: Response) => {
        const userId = req.auth!.user._id.toString();
        const agencyId = req.auth!.role_entity._id.toString();
        const input = AgencyOnboardingStep1Schema.parse(req.body);
        const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;

        const result = await agencyProfileService.completeStep1(agencyId, userId, input, expectedVersion);
        res.json({ success: true, data: result, message: 'Logistics setup completed' });
    });

    /**
     * PUT /api/agency/onboarding/payout
     * Step 2: payout_details
     */
    static completePayoutSetup = asyncHandler(async (req: Request, res: Response) => {
        const userId = req.auth!.user._id.toString();
        const agencyId = req.auth!.role_entity._id.toString();
        const input = AgencyOnboardingStep2Schema.parse(req.body);
        const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;

        const result = await agencyProfileService.completeStep2(agencyId, userId, input, expectedVersion);
        res.json({ success: true, data: result, message: 'Payout setup completed' });
    });

    /**
     * PUT /api/agency/onboarding/branding
     * Step 3: Branding (optional / skippable)
     */
    static completeBrandingSetup = asyncHandler(async (req: Request, res: Response) => {
        const userId = req.auth!.user._id.toString();
        const agencyId = req.auth!.role_entity._id.toString();
        const input = AgencyOnboardingStep3Schema.parse(req.body);
        const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;

        const result = await agencyProfileService.completeStep3(agencyId, userId, input, expectedVersion);
        res.json({ success: true, data: result, message: 'Branding setup completed' });
    });

    /**
     * PUT /api/agency/onboarding/policies
     * Step 4: Policy Setup (pricing, returns, damage)
     */
    static completePolicySetup = asyncHandler(async (req: Request, res: Response) => {
        const userId = req.auth!.user._id.toString();
        const agencyId = req.auth!.role_entity._id.toString();
        const input = AgencyOnboardingStep4Schema.parse(req.body);
        const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;

        const result = await agencyProfileService.completePolicySetup(agencyId, userId, input, expectedVersion);
        res.json({ success: true, data: result, message: 'Policy setup completed' });
    });

    /**
     * POST /api/agency/profile/policy-documents
     * Upload 1-2 supporting PDF documents (max 5MB each) for `policies.documents`.
     * Standalone upload — not part of the product/ticket media pipeline. Returns
     * public URLs to submit back via the policy-setup / profile-update endpoints.
     */
    static uploadPolicyDocuments = asyncHandler(async (req: Request, res: Response) => {
        if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
            throw createAppError(
                ERROR_CODES.DELIVERY_POLICY_DOCUMENT_MISSING, 400,
                'At least one document is required (field name "documents")',
            );
        }

        for (const file of req.files) {
            if (file.mimetype !== 'application/pdf') {
                throw createAppError(
                    ERROR_CODES.DELIVERY_POLICY_DOCUMENT_TYPE_INVALID, 400,
                    `File "${file.originalname}" must be a PDF`,
                );
            }
        }

        const storageProvider = getStorageProvider();
        const urls: string[] = [];
        for (const file of req.files) {
            const result = await storageProvider.put(file.buffer, {
                mimeType: file.mimetype,
                folder: 'agency-policy-documents',
                filename: file.originalname,
            });
            urls.push(storageProvider.getPublicUrl(result.key));
        }

        res.status(201).json({ success: true, data: { urls }, message: `Uploaded ${urls.length} document(s)` });
    });
}
