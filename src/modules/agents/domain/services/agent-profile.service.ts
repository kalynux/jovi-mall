import { AgentRepository, agentRepository } from '../../repositories/agent.repository';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IDeliveryAgent, IAgentVehicleInfo, IAgentEmergencyContact } from '../../models/agent.model';
import { AgentOnboardingStep, AgentOnboardingStepValue } from '../../../../core/constants/onboarding-steps';
import { AGENT_CONFIG } from '../../config/agent.config';
import {
  UpdateAgentProfileInput,
  AgentOnboardingStep1Input,
  AgentOnboardingStep2Input,
  UpdateAgentPreferencesInput,
  UpdateAgentSettingsInput,
} from '../../validators/agent.validator';
import { AgentProfileMapper, GetAgentProfileResponseDto, AgentCompletionStatusDto } from '../../dto/agent-profile.dto';

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
  constructor(private readonly agents: AgentRepository = agentRepository) {}

  async getProfile(agentId: string): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);
    return AgentProfileMapper.toResponseDto(agent);
  }

  async getCompletionStatus(agentId: string): Promise<AgentCompletionStatusDto> {
    const agent = await this.requireAgent(agentId);
    return this.buildCompletionStatus(agent);
  }

  async updateProfile(agentId: string, input: UpdateAgentProfileInput): Promise<GetAgentProfileResponseDto> {
    await this.requireAgent(agentId);

    const payload = AgentProfileMapper.toUpdatePayload(input);
    const updated = await this.agents.updateProfile(agentId, payload);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const newStep = this.recalculateOnboardingStep(updated);
    if (newStep !== updated.onboarding_step) {
      await this.agents.updateOnboardingStep(agentId, newStep);
      updated.onboarding_step = newStep;
    }

    return AgentProfileMapper.toResponseDto(updated);
  }

  // ─── Preferences & settings ───────────────────────────────────────────────

  async updatePreferences(
    agentId: string,
    input: UpdateAgentPreferencesInput
  ): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);

    const merged = { ...agent.preferences, ...stripUndefined(input) };
    const updated = await this.agents.updateProfile(agentId, {
      preferences: merged,
    } as Partial<IDeliveryAgent>);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    return AgentProfileMapper.toResponseDto(updated);
  }

  /**
   * Settings affect dispatch, so they are bounded rather than free.
   * An agent raising their own concurrency to 500 would silently defeat the
   * capacity rule; the platform ceiling is the backstop.
   */
  async updateSettings(agentId: string, input: UpdateAgentSettingsInput): Promise<GetAgentProfileResponseDto> {
    const agent = await this.requireAgent(agentId);

    const next = { ...agent.settings, ...stripUndefined(input) };
    if (next.max_concurrent_shipments !== undefined) {
      next.max_concurrent_shipments = Math.min(
        next.max_concurrent_shipments,
        AGENT_CONFIG.MAX_ACTIVE_SHIPMENTS_MAX
      );
    }

    const updated = await this.agents.updateProfile(agentId, { settings: next } as Partial<IDeliveryAgent>);
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    return AgentProfileMapper.toResponseDto(updated);
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────

  async completeStep1(
    agentId: string,
    input: AgentOnboardingStep1Input
  ): Promise<{ profile: GetAgentProfileResponseDto; completionStatus: AgentCompletionStatusDto }> {
    await this.requireAgent(agentId);

    const updated = await this.agents.updateProfile(agentId, {
      vehicle_info: input.vehicle_info as IAgentVehicleInfo,
    });
    if (!updated) throw createAppError(ERROR_CODES.AGENT_NOT_FOUND, 404);

    const newStep = this.recalculateOnboardingStep(updated);
    await this.agents.updateOnboardingStep(agentId, newStep);
    updated.onboarding_step = newStep;

    return {
      profile: AgentProfileMapper.toResponseDto(updated),
      completionStatus: this.buildCompletionStatus(updated),
    };
  }

  async completeStep2(
    agentId: string,
    input: AgentOnboardingStep2Input
  ): Promise<{ profile: GetAgentProfileResponseDto; completionStatus: AgentCompletionStatusDto }> {
    await this.requireAgent(agentId);

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
      profile: AgentProfileMapper.toResponseDto(finalAgent),
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
    return AgentProfileMapper.toResponseDto(updated);
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
