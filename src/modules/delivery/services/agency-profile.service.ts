import mongoose from 'mongoose';
import { DeliveryAgencyRepository } from '../delivery-agency.repository';
import {
    AgencyProfileMapper,
    GetAgencyProfileResponseDto,
    AgencyCompletionStatusDto,
    AgencyOnboardingStatusDto,
    CreateAgencyResponseDto,
} from '../dto/agency-profile.dto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { IDeliveryAgency, IAgencyPolicies } from '../delivery-agency.model';
import { IPayoutMethod } from '../../../core/types/payout.types';
import { assertHeadquartersInCountry } from '../../../core/validation/address-country.helper';
import { normalizeCoverageAreasForCountry } from '../../../core/constants/locations.helper';
import { toPersistableHeadquarters } from '../../magazin/dto/magazin-profile.dto';
import { AgencyOnboardingStep, AgencyOnboardingStepValue } from '../../../core/constants/onboarding-steps';
import { AGENCY_ONBOARDING_EVENTS } from '../events/agency-onboarding.events';
import { ConnectionService } from '../../agency-connections/connection.service';
import { transactionManager, TransactionManager } from '../../../core/database/transaction.manager';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../catalog/domain/services/media/FileReferenceService';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';
import { MagazinProvisioningService } from '../../magazin/service/magazin-provisioning.service';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import {
    UpdateAgencyProfileInput,
    AgencyOnboardingStep1Input,
    AgencyOnboardingStep2Input,
    AgencyOnboardingStep3Input,
    AgencyOnboardingStep4Input,
    CreateAgencyInput,
} from '../validators/agency-onboarding.validator';

/**
 * Agency Profile Service
 *
 * ARCHITECTURE:
 * - Zod validates SHAPE (in validator layer)
 * - Service enforces POLICY (step ordering, idempotency, concurrency)
 * - Repository handles persistence
 *
 * ONBOARDING MODEL:
 * - Step-enforced: each step verifies current `onboarding_step` matches prerequisite
 * - Idempotent: re-submitting a completed step returns success without re-writing
 * - Atomic: single findOneAndUpdate per step (data + step in one operation)
 * - Optimistic concurrency: version check rejects stale writes
 * - Events published via EventBus after successful mutations
 * - Audit logged via auditLogger
 */
export class AgencyProfileService {
    private agencyRepo: DeliveryAgencyRepository;
    private txManager: TransactionManager;
    private connectionService: ConnectionService;
    private fileRepository: FileRepositoryMongo;
    private fileReferenceService: FileReferenceService;
    private storageProvider: IStorageProvider;
    private magazinProvisioning: MagazinProvisioningService;
    private magazinRepo: MagazinRepository;

    constructor() {
        this.agencyRepo = new DeliveryAgencyRepository();
        this.txManager = transactionManager;
        this.connectionService = new ConnectionService();
        this.fileRepository = new FileRepositoryMongo();
        this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
        this.storageProvider = getStorageProvider();
        this.magazinProvisioning = new MagazinProvisioningService();
        this.magazinRepo = new MagazinRepository();
    }

    /**
     * Keep `file_references` in sync with the agency's personal AVATAR slot
     * whenever it changes, so the file is exempt from orphan garbage collection
     * while set. Mirrors the vendor avatar reconciliation. The business LOGO is a
     * Magazin concern, not handled here. Runs before the write so an unauthorized
     * file reference is rejected before persistence. Only touched when a value is
     * supplied (PATCH semantics).
     */
    private async reconcileAgencyAvatarReference(
        agencyId: string,
        current: IDeliveryAgency,
        nextAvatarFileId: string | null | undefined,
    ): Promise<void> {
        if (nextAvatarFileId === undefined) return;
        await this.fileReferenceService.reconcile({
            previousFileIds: current.avatar_file_id ? [current.avatar_file_id.toString()] : [],
            nextFileIds: nextAvatarFileId ? [nextAvatarFileId] : [],
            actor: { type: 'agency', id: agencyId },
            entityType: 'agency',
            entityId: agencyId,
            field: 'avatar',
        });
    }

    /**
     * Apply a business-logo change (from onboarding Step 3) to the agency's
     * Magazin — get-or-create it, reconcile the logo file reference, then persist
     * the new logo id. The business logo lives on the Magazin, never the agency.
     */
    private async applyBrandingLogoToMagazin(
        agencyId: string,
        nextLogoFileId: string | null | undefined,
    ): Promise<void> {
        if (nextLogoFileId === undefined) return;
        const magazin = await this.magazinProvisioning.ensureMagazinForAgency(agencyId);
        await this.fileReferenceService.reconcile({
            previousFileIds: magazin.logo_file_id ? [magazin.logo_file_id.toString()] : [],
            nextFileIds: nextLogoFileId ? [nextLogoFileId] : [],
            actor: { type: 'agency', id: agencyId },
            entityType: 'agency_magazin',
            entityId: magazin._id.toString(),
            field: 'logo',
        });
        await this.magazinRepo.updateByAgencyId(agencyId, magazin.version, {
            logo_file_id: nextLogoFileId ? new mongoose.Types.ObjectId(nextLogoFileId) : null,
        });
    }

    /**
     * Coverage/HQ live on the Magazin, but the agency's onboarding-step + completion
     * calculations depend on their presence — so load their counts from the Magazin.
     */
    private async magazinCounts(agencyId: string): Promise<{ coverageCount: number; hqCount: number }> {
        const magazin = await this.magazinRepo.findByAgencyIdOrNull(agencyId);
        return {
            coverageCount: magazin?.coverage_areas?.length ?? 0,
            hqCount: magazin?.headquarters_addresses?.length ?? 0,
        };
    }

    // ─── Read ─────────────────────────────────────────────────────────────────

    async getProfile(agencyId: string): Promise<GetAgencyProfileResponseDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);
        return AgencyProfileMapper.toResponseDto(agency, this.fileRepository, this.storageProvider);
    }

    async getCompletionStatus(agencyId: string): Promise<AgencyCompletionStatusDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);
        return this.buildCompletionStatus(agency);
    }

    async getOnboardingStatus(agencyId: string): Promise<AgencyOnboardingStatusDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);
        const { coverageCount, hqCount } = await this.magazinCounts(agencyId);
        return AgencyProfileMapper.toOnboardingStatusDto(agency, coverageCount, hqCount);
    }

    // ─── Agency Creation (Option A: sets agency_name on existing doc) ─────────

    async createAgency(
        userId: string,
        agencyId: string,
        input: CreateAgencyInput,
    ): Promise<CreateAgencyResponseDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        // The business name lives on the Magazin (source of truth). Get-or-create
        // it and set its name; idempotent when the name already matches.
        const magazin = await this.magazinProvisioning.ensureMagazinForAgency(agencyId, input.agency_name);
        const previousName = magazin.name;
        if (magazin.name !== input.agency_name) {
            await this.magazinRepo.updateByAgencyId(agencyId, magazin.version, { name: input.agency_name });
        }

        // Advance onboarding past initialization (idempotent — a no-op once past step 1).
        let updated = agency;
        if (agency.onboarding_step < AgencyOnboardingStep.LOGISTICS_SETUP || agency.onboarding_step === undefined) {
            const stepped = await this.agencyRepo.updateProfile(agencyId, {
                onboarding_step: AgencyOnboardingStep.LOGISTICS_SETUP,
            });
            if (!stepped) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);
            updated = stepped;
        }

        // Emit event
        await eventBus.publish(AGENCY_ONBOARDING_EVENTS.AGENCY_INITIALIZED, {
            eventType: AGENCY_ONBOARDING_EVENTS.AGENCY_INITIALIZED,
            aggregateId: agencyId,
            payload: { agencyId, userId, agencyName: input.agency_name },
            occurredAt: new Date(),
        });

        // Audit log
        await auditLogger.log({
            actor: { userId, role: 'agency' },
            action: 'AGENCY_INITIALIZED',
            resource: { type: 'DeliveryAgency', id: agencyId },
            changes: { agency_name: { from: previousName, to: input.agency_name } },
            timestamp: new Date(),
        });

        return AgencyProfileMapper.toCreateResponseDto(updated, input.agency_name);
    }

    // ─── General Profile Update ───────────────────────────────────────────────

    async updateProfile(agencyId: string, input: UpdateAgencyProfileInput): Promise<GetAgencyProfileResponseDto> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        // POLICY: Country is set-once (onboarding Step 1) — reject changes,
        // allow an idempotent echo of the current value or a first set on
        // legacy rows that predate the field.
        if (input.country !== undefined && agency.country && input.country !== agency.country) {
            throw createAppError(
                ERROR_CODES.PROFILE_COUNTRY_IMMUTABLE,
                403,
                'Country cannot be changed once set. It was fixed during onboarding for tax, shipping and address policy.',
                { currentCountry: agency.country },
            );
        }

        // Coverage areas + HQ addresses (and their country validation) live on the
        // Magazin now (PATCH /api/agency/magazin), not on this profile update.

        // Keep the personal-avatar file reference in sync before the write, so an
        // unauthorized file reference is rejected before anything is persisted.
        await this.reconcileAgencyAvatarReference(agencyId, agency, input.avatarFileId);

        const payload = AgencyProfileMapper.toUpdatePayload(input);

        // Preserve admin-controlled damage presets so a general profile update
        // cannot accidentally clear them via a full policies $set.
        if (payload.policies) {
            payload.policies.damage = {
                ...payload.policies.damage,
                inspector: agency.policies?.damage?.inspector ?? 'agency',
                investigation_fee: agency.policies?.damage?.investigation_fee ?? 1000,
            };
        }

        const updated = await this.agencyRepo.updateProfile(agencyId, payload);
        if (!updated) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        const newStep = await this.recalculateOnboardingStep(updated);
        if (newStep !== updated.onboarding_step) {
            await this.agencyRepo.updateOnboardingStep(agencyId, newStep);
            updated.onboarding_step = newStep;
        }

        // Policies just changed value (checked AFTER the admin-controlled damage
        // preset merge above, since that's the value actually persisted) — bump
        // the policy-change counter and pause any active vendor connections so
        // the vendor is prompted to reapprove. Only pays the transaction cost
        // when a change is actually detected.
        if (payload.policies && JSON.stringify(payload.policies) !== JSON.stringify(agency.policies)) {
            await this.txManager.runInTransaction(async (session) => {
                await this.agencyRepo.incrementPolicyVersion(agencyId, session);
                await this.connectionService.pauseConnectionsForPolicyChange('agency', agencyId, session);
            });
        }

        return AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider);
    }

    // ─── Onboarding Steps ─────────────────────────────────────────────────────

    /**
     * Step 1: Logistics Setup (coverage_areas, headquarters_addresses)
     *
     * Behaviour:
     * - First time (step === 1): saves data, advances step to 2.
     * - Re-edit (step > 1, not COMPLETED): saves new data, keeps current step unchanged.
     * - Already COMPLETED: 409.
     */
    async completeStep1(
        agencyId: string,
        userId: string,
        input: AgencyOnboardingStep1Input,
        expectedVersion?: number,
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        // Guard: fully completed — use the general profile update endpoint instead
        if (agency.onboarding_step === AgencyOnboardingStep.COMPLETED) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_ALREADY_COMPLETED, 409);
        }

        // Coverage areas + HQ addresses live on the Magazin; persist + validate
        // them there (against `input.country`). The country itself stays on the
        // profile (set-once).
        await this.persistLogisticsToMagazin(agencyId, agency.country, input);

        // Re-edit mode: step is already beyond step 1.
        // Save the country but keep the current onboarding_step intact.
        if (agency.onboarding_step > AgencyOnboardingStep.LOGISTICS_SETUP) {
            const updated = await this.agencyRepo.atomicOnboardingUpdate(
                agencyId,
                {
                    country: input.country,
                    onboarding_step: agency.onboarding_step as AgencyOnboardingStepValue,
                },
                expectedVersion,
            );

            if (!updated) {
                throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
            }

            await this.auditOnboardingStep(userId, agencyId, 'LOGISTICS_DATA_UPDATED', 1, agency.onboarding_step);

            return {
                profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
                completionStatus: await this.buildCompletionStatus(updated),
            };
        }

        // Step enforcement: must be on step 1
        if (agency.onboarding_step !== AgencyOnboardingStep.LOGISTICS_SETUP) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID, 400);
        }

        // First-time completion: save country + advance step
        const newStep = AgencyOnboardingStep.PAYOUT_SETUP;
        const updated = await this.agencyRepo.atomicOnboardingUpdate(
            agencyId,
            {
                country: input.country,
                onboarding_step: newStep,
            },
            expectedVersion,
        );

        if (!updated) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
        }

        await this.emitStepCompletedEvent(agencyId, userId, AgencyOnboardingStep.LOGISTICS_SETUP, newStep);
        await this.auditOnboardingStep(userId, agencyId, 'LOGISTICS_SETUP', 1, newStep);

        return {
            profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
            completionStatus: await this.buildCompletionStatus(updated),
        };
    }

    /**
     * Persist onboarding-Step-1 logistics (coverage areas + headquarters addresses)
     * to the agency's Magazin, validated against `input.country`. Coverage must be
     * regions of that country; every new/edited HQ must carry a geocoded `geo`
     * inside it. Unchanged HQ entries are grandfathered only when the country is
     * unchanged.
     */
    private async persistLogisticsToMagazin(
        agencyId: string,
        agencyCurrentCountry: string | null,
        input: AgencyOnboardingStep1Input,
    ): Promise<void> {
        const magazin = await this.magazinProvisioning.ensureMagazinForAgency(agencyId);
        const existingHq =
            agencyCurrentCountry && agencyCurrentCountry === input.country
                ? magazin.headquarters_addresses
                : [];
        assertHeadquartersInCountry(input.headquarters_addresses, existingHq, input.country);
        await this.magazinRepo.updateByAgencyId(agencyId, magazin.version, {
            coverage_areas: normalizeCoverageAreasForCountry(input.coverage_areas, input.country),
            headquarters_addresses: toPersistableHeadquarters(input.headquarters_addresses),
        });
    }

    /**
     * Step 2: Payout Setup (payout_details)
     *
     * Behaviour:
     * - First time (step === 2): saves data, advances step to 3.
     * - Re-edit (step > 2, not COMPLETED): saves new data, keeps current step unchanged.
     * - Already COMPLETED: 409.
     * - Step 1 not done: 400.
     */
    async completeStep2(
        agencyId: string,
        userId: string,
        input: AgencyOnboardingStep2Input,
        expectedVersion?: number,
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        // Guard: fully completed — use the general profile update endpoint instead
        if (agency.onboarding_step === AgencyOnboardingStep.COMPLETED) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_ALREADY_COMPLETED, 409);
        }

        // Re-edit mode: step is already beyond step 2.
        // Save the updated payout data but keep the current onboarding_step intact.
        if (agency.onboarding_step > AgencyOnboardingStep.PAYOUT_SETUP) {
            const updated = await this.agencyRepo.atomicOnboardingUpdate(
                agencyId,
                {
                    payout_details: input.payout_details as IPayoutMethod[],
                    onboarding_step: agency.onboarding_step as AgencyOnboardingStepValue,
                },
                expectedVersion,
            );

            if (!updated) {
                throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
            }

            await this.auditOnboardingStep(userId, agencyId, 'PAYOUT_DATA_UPDATED', 2, agency.onboarding_step);

            return {
                profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
                completionStatus: await this.buildCompletionStatus(updated),
            };
        }

        // Step enforcement: prerequisite step 1 must be done
        if (agency.onboarding_step < AgencyOnboardingStep.PAYOUT_SETUP) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INCOMPLETE, 400,
                'You must complete Logistics Setup (step 1) before Payout Setup');
        }

        if (agency.onboarding_step !== AgencyOnboardingStep.PAYOUT_SETUP) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID, 400);
        }

        // First-time completion: save data + advance step
        const newStep = AgencyOnboardingStep.BRANDING;
        const updated = await this.agencyRepo.atomicOnboardingUpdate(
            agencyId,
            {
                payout_details: input.payout_details as IPayoutMethod[],
                onboarding_step: newStep,
            },
            expectedVersion,
        );

        if (!updated) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
        }

        await this.emitStepCompletedEvent(agencyId, userId, AgencyOnboardingStep.PAYOUT_SETUP, newStep);
        await this.auditOnboardingStep(userId, agencyId, 'PAYOUT_SETUP', 2, newStep);

        return {
            profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
            completionStatus: await this.buildCompletionStatus(updated),
        };
    }

    /**
     * Step 3: Branding (optional / skippable)
     *
     * Behaviour:
     * - First time (step === 3): saves data, advances step to POLICY_SETUP (4).
     * - Re-edit (step > 3, not COMPLETED): saves new data, keeps current step unchanged.
     * - Already COMPLETED: 409.
     * - Prerequisites not met: 400.
     */
    async completeStep3(
        agencyId: string,
        userId: string,
        input: AgencyOnboardingStep3Input,
        expectedVersion?: number,
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        // Guard: already completed
        if (agency.onboarding_step === AgencyOnboardingStep.COMPLETED) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_ALREADY_COMPLETED, 409);
        }

        // Re-edit mode: step is already beyond step 3 (i.e., at POLICY_SETUP).
        // Save the updated branding data but keep the current step intact.
        if (agency.onboarding_step > AgencyOnboardingStep.BRANDING) {
            const updates: Partial<IDeliveryAgency> & { onboarding_step: AgencyOnboardingStepValue } = {
                onboarding_step: agency.onboarding_step as AgencyOnboardingStepValue,
            };
            if (!input.skip) {
                // Business logo lives on the Magazin; timezone stays on the profile.
                await this.applyBrandingLogoToMagazin(agencyId, input.logo_file_id);
                if (input.timezone !== undefined) updates.timezone = input.timezone;
            }
            const updated = await this.agencyRepo.atomicOnboardingUpdate(agencyId, updates, expectedVersion);
            if (!updated) throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
            await this.auditOnboardingStep(userId, agencyId, 'BRANDING_DATA_UPDATED', 3, agency.onboarding_step);
            return {
                profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
                completionStatus: await this.buildCompletionStatus(updated),
            };
        }

        // Step enforcement: prerequisite steps 1 & 2 must be done
        if (agency.onboarding_step < AgencyOnboardingStep.BRANDING) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INCOMPLETE, 400,
                'You must complete Logistics Setup and Payout Setup before Branding');
        }

        // First-time completion: save data + advance to POLICY_SETUP
        const updates: Partial<IDeliveryAgency> & { onboarding_step: AgencyOnboardingStepValue } = {
            onboarding_step: AgencyOnboardingStep.POLICY_SETUP,
        };

        if (!input.skip) {
            // Business logo lives on the Magazin; timezone stays on the profile.
            await this.applyBrandingLogoToMagazin(agencyId, input.logo_file_id);
            if (input.timezone !== undefined) updates.timezone = input.timezone;
        }

        const updated = await this.agencyRepo.atomicOnboardingUpdate(agencyId, updates, expectedVersion);

        if (!updated) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
        }

        await this.emitStepCompletedEvent(agencyId, userId, AgencyOnboardingStep.BRANDING, AgencyOnboardingStep.POLICY_SETUP);
        await this.auditOnboardingStep(userId, agencyId, 'BRANDING', 3, AgencyOnboardingStep.POLICY_SETUP);

        return {
            profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
            completionStatus: await this.buildCompletionStatus(updated),
        };
    }

    /**
     * Step 4: Policy Setup (pricing, returns, damage)
     *
     * Behaviour:
     * - First time (step === 4): saves data, advances step to COMPLETED.
     * - Re-edit (step 2 or 3 — policy submitted ahead of step 4): saves data, keeps current step.
     * - Step < 2: 400 (prerequisites not met).
     * - Already COMPLETED with same payload: idempotent success.
     * - Already COMPLETED with different payload: 409.
     */
    async completePolicySetup(
        agencyId: string,
        userId: string,
        input: AgencyOnboardingStep4Input,
        expectedVersion?: number,
    ): Promise<{ profile: GetAgencyProfileResponseDto; completionStatus: AgencyCompletionStatusDto }> {
        const agency = await this.agencyRepo.findById(agencyId);
        if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

        // Idempotency: already completed — return success if payload matches
        if (agency.onboarding_step === AgencyOnboardingStep.COMPLETED) {
            if (agency.policies && JSON.stringify(agency.policies) === JSON.stringify(input.policies)) {
                return {
                    profile: await AgencyProfileMapper.toResponseDto(agency, this.fileRepository, this.storageProvider),
                    completionStatus: await this.buildCompletionStatus(agency),
                };
            }
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_ALREADY_COMPLETED, 409);
        }

        // Step enforcement: step 1 (LOGISTICS_SETUP) is too early
        if (agency.onboarding_step < AgencyOnboardingStep.PAYOUT_SETUP) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_STEP_INCOMPLETE, 400,
                'You must complete at least Logistics Setup and Payout Setup before Policy Setup');
        }

        // Merge admin-controlled presets: preserve existing values if re-editing,
        // otherwise fall back to platform defaults.
        const policies: IAgencyPolicies = {
            ...input.policies,
            damage: {
                ...input.policies.damage,
                inspector: agency.policies?.damage?.inspector ?? 'agency',
                investigation_fee: agency.policies?.damage?.investigation_fee ?? 1000,
            },
        };
        const policiesChanged = JSON.stringify(agency.policies) !== JSON.stringify(policies);

        // Re-edit mode: on step 2 or 3 — save data, keep current step
        if (agency.onboarding_step < AgencyOnboardingStep.POLICY_SETUP) {
            const updated = await this.agencyRepo.atomicOnboardingUpdate(
                agencyId,
                {
                    policies,
                    onboarding_step: agency.onboarding_step as AgencyOnboardingStepValue,
                },
                expectedVersion,
            );
            if (!updated) throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
            if (policiesChanged) {
                await this.txManager.runInTransaction(async (session) => {
                    await this.agencyRepo.incrementPolicyVersion(agencyId, session);
                    await this.connectionService.pauseConnectionsForPolicyChange('agency', agencyId, session);
                });
            }
            await this.auditOnboardingStep(userId, agencyId, 'POLICY_DATA_UPDATED', 4, agency.onboarding_step);
            return {
                profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
                completionStatus: await this.buildCompletionStatus(updated),
            };
        }

        // First-time completion: step === POLICY_SETUP — save data + advance to COMPLETED
        const updated = await this.agencyRepo.atomicOnboardingUpdate(
            agencyId,
            {
                policies,
                onboarding_step: AgencyOnboardingStep.COMPLETED,
            },
            expectedVersion,
        );

        if (!updated) {
            throw createAppError(ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION, 409);
        }

        if (policiesChanged) {
            await this.txManager.runInTransaction(async (session) => {
                await this.agencyRepo.incrementPolicyVersion(agencyId, session);
                await this.connectionService.pauseConnectionsForPolicyChange('agency', agencyId, session);
            });
        }

        await this.emitStepCompletedEvent(agencyId, userId, AgencyOnboardingStep.POLICY_SETUP, AgencyOnboardingStep.COMPLETED);

        await eventBus.publish(AGENCY_ONBOARDING_EVENTS.COMPLETED, {
            eventType: AGENCY_ONBOARDING_EVENTS.COMPLETED,
            aggregateId: agencyId,
            payload: { agencyId, userId, agencyName: (await this.magazinRepo.findNameByAgencyId(agencyId)) ?? '' },
            occurredAt: new Date(),
        });

        await this.auditOnboardingStep(userId, agencyId, 'POLICY_SETUP', 4, AgencyOnboardingStep.COMPLETED);

        return {
            profile: await AgencyProfileMapper.toResponseDto(updated, this.fileRepository, this.storageProvider),
            completionStatus: await this.buildCompletionStatus(updated),
        };
    }

    // ─── Private Helpers ──────────────────────────────────────────────────────

    private async recalculateOnboardingStep(agency: IDeliveryAgency): Promise<AgencyOnboardingStepValue> {
        // Coverage + HQ (Step 1 completion signals) live on the Magazin.
        const { coverageCount, hqCount } = await this.magazinCounts(agency._id.toString());
        const step1Complete = coverageCount > 0 && hqCount > 0;
        if (!step1Complete) return AgencyOnboardingStep.LOGISTICS_SETUP;

        const step2Complete = (agency.payout_details?.length ?? 0) > 0;
        if (!step2Complete) return AgencyOnboardingStep.PAYOUT_SETUP;

        if (agency.onboarding_step === AgencyOnboardingStep.BRANDING) return AgencyOnboardingStep.BRANDING;
        if (agency.onboarding_step === AgencyOnboardingStep.POLICY_SETUP) return AgencyOnboardingStep.POLICY_SETUP;

        if (agency.policies !== null) return AgencyOnboardingStep.COMPLETED;
        return AgencyOnboardingStep.POLICY_SETUP;
    }

    private async buildCompletionStatus(agency: IDeliveryAgency): Promise<AgencyCompletionStatusDto> {
        // Coverage + HQ live on the Magazin.
        const { coverageCount, hqCount } = await this.magazinCounts(agency._id.toString());
        const missing: string[] = [];
        if (coverageCount === 0) missing.push('coverage_areas');
        if (hqCount === 0) missing.push('headquarters_addresses (min 1)');
        if ((agency.payout_details?.length ?? 0) === 0) missing.push('payout_details');
        if (!agency.policies) missing.push('policies');

        const step = agency.onboarding_step;
        const stepLabels: Record<number, string> = {
            0: 'Onboarding Complete',
            1: 'Logistics Setup',
            2: 'Payout Setup',
            3: 'Branding (Optional)',
            4: 'Policy Setup',
        };

        return {
            onboardingStep: step,
            isComplete: step === AgencyOnboardingStep.COMPLETED,
            missingFields: missing,
            stepLabel: stepLabels[step] ?? `Step ${step}`,
        };
    }

    private async emitStepCompletedEvent(
        agencyId: string,
        userId: string,
        stepCompleted: number,
        newStep: number,
    ): Promise<void> {
        await eventBus.publish(AGENCY_ONBOARDING_EVENTS.STEP_COMPLETED, {
            eventType: AGENCY_ONBOARDING_EVENTS.STEP_COMPLETED,
            aggregateId: agencyId,
            payload: { agencyId, userId, stepCompleted, newStep },
            occurredAt: new Date(),
        });
    }

    private async auditOnboardingStep(
        userId: string,
        agencyId: string,
        stepName: string,
        stepNumber: number,
        newStep: number,
    ): Promise<void> {
        await auditLogger.log({
            actor: { userId, role: 'agency' },
            action: `AGENCY_ONBOARDING_STEP_COMPLETED`,
            resource: { type: 'DeliveryAgency', id: agencyId },
            changes: { step: { name: stepName, number: stepNumber }, newOnboardingStep: newStep },
            timestamp: new Date(),
        });
    }
}
