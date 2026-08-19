/**
 * Agency Onboarding Domain Events
 *
 * Event type constants and handler registration for the agency onboarding flow.
 * Published via the central EventBus singleton.
 */
import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { logger } from '../../../core/logging';

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
    eventBus.subscribe(
        AGENCY_ONBOARDING_EVENTS.STEP_COMPLETED,
        (event: DomainEvent) => {
            logger().info(
                {
                    agencyId: event.aggregateId,
                    stepCompleted: event.payload.stepCompleted,
                    newStep: event.payload.newStep,
                },
                'agency onboarding: step completed',
            );
            // Future: send notification to agency admin, update analytics, etc.
        },
        'AgencyOnboarding.onStepCompleted',
    );

    eventBus.subscribe(
        AGENCY_ONBOARDING_EVENTS.COMPLETED,
        (event: DomainEvent) => {
            logger().info(
                { agencyId: event.aggregateId, agencyName: event.payload.agencyName },
                'agency onboarding: completed',
            );
            // Future: send congratulations email, trigger KYC review workflow, etc.
        },
        'AgencyOnboarding.onCompleted',
    );

    eventBus.subscribe(
        AGENCY_ONBOARDING_EVENTS.AGENCY_INITIALIZED,
        (event: DomainEvent) => {
            logger().info(
                { agencyId: event.aggregateId, agencyName: event.payload.agencyName },
                'agency onboarding: agency initialized',
            );
            // Future: send welcome email, create default config entries, etc.
        },
        'AgencyOnboarding.onAgencyInitialized',
    );
}
