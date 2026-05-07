/**
 * Agency Onboarding Domain Events
 *
 * Event type constants and handler registration for the agency onboarding flow.
 * Published via the central EventBus singleton.
 */
import { eventBus, DomainEvent } from '../../../core/events/event-bus';

// ─── Event Type Constants ─────────────────────────────────────────────────────

export const AGENCY_ONBOARDING_EVENTS = {
    /** Fired when any onboarding step is completed (step 1, 2, or 3) */
    STEP_COMPLETED: 'agency.onboarding.step_completed',
    /** Fired when the entire onboarding flow is completed (all steps done) */
    COMPLETED: 'agency.onboarding.completed',
    /** Fired when an agency is initialized (POST /api/agency) */
    AGENCY_INITIALIZED: 'agency.onboarding.initialized',
} as const;

// ─── Event Payload Types ──────────────────────────────────────────────────────

export interface AgencyStepCompletedPayload {
    agencyId: string;
    userId: string;
    stepCompleted: number;
    newStep: number;
    timestamp: Date;
}

export interface AgencyOnboardingCompletedPayload {
    agencyId: string;
    userId: string;
    agencyName: string;
    timestamp: Date;
}

export interface AgencyInitializedPayload {
    agencyId: string;
    userId: string;
    agencyName: string;
    timestamp: Date;
}

// ─── Handler Registration ─────────────────────────────────────────────────────

/**
 * Register default event handlers for agency onboarding events.
 * Call this once during application bootstrap.
 */
export function registerAgencyOnboardingEventHandlers(): void {
    eventBus.subscribe(AGENCY_ONBOARDING_EVENTS.STEP_COMPLETED, (event: DomainEvent) => {
        console.log(`[AgencyOnboarding] Step completed for agency ${event.aggregateId}:`, {
            stepCompleted: event.payload.stepCompleted,
            newStep: event.payload.newStep,
        });
        // Future: send notification to agency admin, update analytics, etc.
    });

    eventBus.subscribe(AGENCY_ONBOARDING_EVENTS.COMPLETED, (event: DomainEvent) => {
        console.log(`[AgencyOnboarding] Onboarding completed for agency ${event.aggregateId}:`, {
            agencyName: event.payload.agencyName,
        });
        // Future: send congratulations email, trigger KYC review workflow, etc.
    });

    eventBus.subscribe(AGENCY_ONBOARDING_EVENTS.AGENCY_INITIALIZED, (event: DomainEvent) => {
        console.log(`[AgencyOnboarding] Agency initialized: ${event.aggregateId}`, {
            agencyName: event.payload.agencyName,
        });
        // Future: send welcome email, create default config entries, etc.
    });
}
