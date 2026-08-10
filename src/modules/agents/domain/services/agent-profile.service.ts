import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import {
  IDeliveryAgent,
  IAgentVehicleInfo,
  IAgentEmergencyContact,
  IAgentSettings,
  IAgentPreferences,
} from '../../models/agent.model';
import { AgentOnboardingStep, AgentOnboardingStepValue } from '../../../../core/constants/onboarding-steps';
import {
  UpdateAgentProfileInput,
  AgentOnboardingStep1Input,
  AgentOnboardingStep2Input,
  UpdateAgentPreferencesInput,
  UpdateAgentDispatchSettingsInput,
} from '../../validators/agent.validator';
import { AgentProfileMapper, GetAgentProfileResponseDto, AgentCompletionStatusDto } from '../../dto/agent-profile.dto';
import mongoose from 'mongoose';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../../catalog/domain/services/media/FileReferenceService';
import { getStorageProvider, IStorageProvider } from '../../../../core/storage';
import { resolveFileDetail } from '../../../catalog/read-models/file-detail.resolver';
import { mergeVehicleInfo, VehicleInfoPatch } from '../vehicle-info';

/**
 * AgentProfileService — the agent's own record: identity, vehicle, contacts,
 * preferences and settings.
 *
 * Scope boundary: nothing agency-specific lives here. Employment terms and COD
 * caps are per-agency and belong to AgentMembershipService; availability and
 * working state belong to AgentAvailabilityService; the tracking flag belongs
 * to AgentTrackingPolicyService. This service owns what is true about the
 * person regardless of who they work for.
 */
export class AgentProfileService {
  private readonly fileRepository: FileRepositoryMongo;
  private readonly fileReferenceService: FileReferenceService;
  private readonly storageProvider: IStorageProvider;

  constructor(private readonly agents: AgentRepository = agentRepository) {
    this.fileRepository = new FileRepositoryMongo();
    this.fileReferenceService = new FileReferenceService(this.fileRepository, new FileReferenceRepositoryMongo());
    this.storageProvider = getStorageProvider();
  }

  /**
   * Build the profile response with the agent's File references (avatar and
   * vehicle photo) resolved to public URLs. Every profile-returning method
   * funnels through here so the resolution happens in exactly one place.
   */
  private async present(agent: IDeliveryAgent): Promise<GetAgentProfileResponseDto> {
    const [avatar, vehiclePhoto] = await Promise.all([
      resolveFileDetail(agent.avatar_file_id?.toString(), this.fileRepository, this.storageProvider),
      resolveFileDetail(agent.vehicle_info?.photo_file_id?.toString(), this.fileRepository, this.storageProvider),
    ]);
    return AgentProfileMapper.toResponseDto(agent, new Date(), avatar, vehiclePhoto);
  }

  /**
   * Keep `file_references` in sync with the agent's avatar slot. Same reconcile
   * primitive branding uses: authorizes the newly-attached file (must be owned
   * by this agent or be a system file) and detaches the previous one, under
   * `entityType: 'agent', field: 'avatar'`.
   */
  private async reconcileAvatarFileReference(
    agentId: string,
    previous: IDeliveryAgent['avatar_file_id'] | undefined,
    next: string | null | undefined,
  ): Promise<void> {
    await this.fileReferenceService.reconcile({
      previousFileIds: previous ? [previous.toString()] : [],
      nextFileIds: next ? [next] : [],
      actor: { type: 'agent', id: agentId },
      entityType: 'agent',
      entityId: agentId,
      field: 'avatar',
    });
  }

  /**
   * The same reconcile for the vehicle photo, under its own field so the two
   * slots are counted independently. Without it, replacing a photo ten times
   * leaves ten undeletable files against the agent's storage quota — a
   * reference row is what makes `GET /api/files/:id` report the usage and what
   * releases the previous file when a new one is attached.
   */
  private async reconcileVehiclePhotoFileReference(
    agentId: string,
    previous: IDeliveryAgent['avatar_file_id'] | undefined,
    next: string | null | undefined,
  ): Promise<void> {
    await this.fileReferenceService.reconcile({
      previousFileIds: previous ? [previous.toString()] : [],
      nextFileIds: next ? [next] : [],
      actor: { type: 'agent', id: agentId },
      entityType: 'agent',
      entityId: agentId,
      field: 'vehicle_photo',
    });
  }

  /**
   * `POST /api/files/upload` accepts any allowed kind, so nothing stops a PDF's
   * id being sent as a vehicle photo. Ownership is checked by `reconcile`; the
   * media type is only checkable here, at attach time.
   */
  private async assertVehiclePhotoIsImage(fileId: string): Promise<void> {
    const [file] = await this.fileRepository.findManyByIds([fileId]);
    if (!file) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, `File not found: ${fileId}`);
    }
    if (!file.mimeType?.startsWith('image/')) {
      throw createAppError(
        ERROR_CODES.CATALOG_FILE_TYPE_INVALID,
        400,
        `A vehicle photo must be an image; file ${fileId} is ${file.mimeType}`,
      );
    }
  }

  /**
   * Validate and reference-count the photo slot of an incoming `vehicle_info`.
   * Shared by the profile PATCH and onboarding step 1 — both take the same
   * `VehicleInfoSchema`, so guarding only one of them is a hole in the other.
   * No-ops when the key is absent, which is what `clearable()` means.
   */
  private async settleVehiclePhoto(
    agentId: string,
    agent: IDeliveryAgent,
    patch: VehicleInfoPatch,
  ): Promise<void> {
    if (patch.photo_file_id === undefined) return;
    if (patch.photo_file_id) await this.assertVehiclePhotoIsImage(patch.photo_file_id);
    await this.reconcileVehiclePhotoFileReference(
      agentId,
      agent.vehicle_info?.photo_file_id ?? undefined,
      patch.photo_file_id,
    );
  }

  async getProfile(agentId: string): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);
    return this.present(agent);
  }

  async getCompletionStatus(agentId: string): Promise<AgentCompletionStatusDto> {
    const agent = await this.requireAgent(agentId);
    return this.buildCompletionStatus(agent);
  }

  async updateProfile(agentId: string, input: UpdateAgentProfileInput): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);

    if (input.avatar_file_id !== undefined) {
      await this.reconcileAvatarFileReference(agentId, agent.avatar_file_id, input.avatar_file_id);
    }
    if (input.vehicle_info !== undefined) {
      await this.settleVehiclePhoto(agentId, agent, input.vehicle_info);
    }

    // The stored vehicle is passed in so the sub-document is MERGED, not
    // replaced — see AgentProfileMapper.toUpdatePayload.
    const payload = AgentProfileMapper.toUpdatePayload(input, agent.vehicle_info);
    const updated = await this.agents.updateProfile(agentId, payload);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const newStep = this.recalculateOnboardingStep(updated);
    if (newStep !== updated.onboarding_step) {
      await this.agents.updateOnboardingStep(agentId, newStep);
      updated.onboarding_step = newStep;
    }

    return this.present(updated);
  }

  // ─── Preferences & settings ───────────────────────────────────────────────

  async updatePreferences(
    agentId: string,
    input: UpdateAgentPreferencesInput
  ): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);

    const merged: IAgentPreferences = { ...agent.preferences, ...stripUndefined(input) };
    const updated = await this.agents.updateProfile(agentId, { preferences: merged });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    return this.present(updated);
  }

  /**
   * Dispatch settings the agent controls.
   *
   * The concurrency ceiling is NOT one of them: `capacity.max_active_shipments`
   * comes from the agent's billing plan and is read-only here. This method used
   * to clamp a `max_concurrent_shipments` key that no schema declared, so the
   * strict cast dropped it on the way to Mongo and the caller got a 200 back
   * describing a write that never happened.
   */
  async updateDispatchSettings(
    agentId: string,
    input: UpdateAgentDispatchSettingsInput
  ): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);

    const next: IAgentSettings = { ...agent.settings, ...stripUndefined(input) };

    const updated = await this.agents.updateProfile(agentId, { settings: next });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    return this.present(updated);
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────

  async completeStep1(
    agentId: string,
    input: AgentOnboardingStep1Input
  ): Promise<{ profile: GetAgentProfileResponseDto; completionStatus: AgentCompletionStatusDto }> {
    const agent = await this.requireAgent(agentId);

    // Onboarding locks on completion: once COMPLETED, the steps reject writes and
    // the agent edits these fields through profile settings instead.
    if (agent.onboarding_step === AgentOnboardingStep.COMPLETED) {
      throw createAppError(ERROR_CODES.AGENT_ONBOARDING_ALREADY_COMPLETED, 409);
    }

    await this.settleVehiclePhoto(agentId, agent, input.vehicle_info);

    // Merged, not replaced: an agent stepping back through onboarding to change
    // their vehicle type must not lose the photo or plate they already saved.
    const updated = await this.agents.updateProfile(agentId, {
      vehicle_info: mergeVehicleInfo(agent.vehicle_info, input.vehicle_info),
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    // First-time completion advances to Identity Setup (step 2). Re-submitting
    // step 1 while already on step 2 saves the new data but keeps the agent
    // there — the "go back and edit while still onboarding" case.
    const newStep = agent.onboarding_step > AgentOnboardingStep.VEHICLE_SETUP
      ? (agent.onboarding_step as AgentOnboardingStepValue)
      : AgentOnboardingStep.IDENTITY_SETUP;
    await this.agents.updateOnboardingStep(agentId, newStep);
    updated.onboarding_step = newStep;

    return {
      profile: await this.present(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  async completeStep2(
    agentId: string,
    input: AgentOnboardingStep2Input
  ): Promise<{ profile: GetAgentProfileResponseDto; completionStatus: AgentCompletionStatusDto }> {
    const agent = await this.requireAgent(agentId);

    // Onboarding locks on completion: once COMPLETED, the steps reject writes and
    // the agent edits these fields through profile settings instead.
    if (agent.onboarding_step === AgentOnboardingStep.COMPLETED) {
      throw createAppError(ERROR_CODES.AGENT_ONBOARDING_ALREADY_COMPLETED, 409);
    }

    if (!input.skip) {
      const updates: Partial<IDeliveryAgent> = {};
      if (input.avatar_url !== undefined) updates.avatar_url = input.avatar_url as string | null;
      if (input.timezone !== undefined) updates.timezone = input.timezone;
      if (Object.keys(updates).length > 0) {
        await this.agents.updateProfile(agentId, updates);
      }
    }

    await this.agents.updateOnboardingStep(agentId, AgentOnboardingStep.COMPLETED);
    const finalAgent = await this.requireAgent(agentId);

    return {
      profile: await this.present(finalAgent),
      completionStatus: this.buildCompletionStatus(finalAgent),
    };
  }

  // ─── Account status (admin) ───────────────────────────────────────────────

  /**
   * Suspending an account does NOT touch memberships: the agent's roster
   * position survives so that reinstating them restores their relationships
   * intact. Eligibility already denies a non-active agent, so suspension is
   * fully effective without cascading.
   */
  async setStatus(
    agentId: string,
    status: IDeliveryAgent['status'],
    reason: string | null
  ): Promise<GetAgentProfileResponseDto> {
    await this.requireAgent(agentId);
    const updated = await this.agents.setStatus(agentId, status, reason);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return this.present(updated);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async requireAgent(agentId: string): Promise<IDeliveryAgent> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);
    return agent;
  }

  private recalculateOnboardingStep(agent: IDeliveryAgent): AgentOnboardingStepValue {
    const step1Complete = !!agent.vehicle_info;
    if (!step1Complete) return AgentOnboardingStep.VEHICLE_SETUP;
    if (agent.onboarding_step === AgentOnboardingStep.IDENTITY_SETUP) return AgentOnboardingStep.IDENTITY_SETUP;
    return AgentOnboardingStep.COMPLETED;
  }

  private buildCompletionStatus(agent: IDeliveryAgent): AgentCompletionStatusDto {
    const missing: string[] = [];
    if (!agent.vehicle_info) missing.push('vehicle_info (vehicle_type, color required)');

    const step = agent.onboarding_step;
    const stepLabels: Record<number, string> = {
      0: 'Onboarding Complete',
      1: 'Vehicle Setup',
      2: 'Identity Setup (Optional)',
    };

    return {
      onboardingStep: step,
      isComplete: step === AgentOnboardingStep.COMPLETED,
      missingFields: missing,
      stepLabel: stepLabels[step] ?? `Step ${step}`,
    };
  }
}

/** Drop undefined keys so a partial update never overwrites with undefined. */
function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const agentProfileService = new AgentProfileService();

// Re-exported for the emergency-contact type used by the mapper's payload shape.
export type { IAgentEmergencyContact };
