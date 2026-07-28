/**
 * Onboarding Step Constants
 *
 * Named constants for each role's onboarding flow.
 *
 * DESIGN RULES:
 * - 0 always means COMPLETED — frontend routes to dashboard
 * - 1+ means the user must complete that step before accessing the product
 * - Steps are recalculated from field presence after every profile write
 *   (not directional; any write triggers a full re-evaluation)
 * - Optional/skippable steps: the service treats these as satisfiable by either
 *   providing the data OR explicitly skipping via the skip flag in the request
 *
 * EXTENSION GUIDE:
 * To add a new step:
 * 1. Add a new entry to the relevant constant below
 * 2. Update the corresponding service's `recalculateOnboardingStep` method
 * 3. Update the Zod validator for that step
 * 4. No other changes required — the step field is just a number
 */

// ─── Vendor Onboarding Steps ─────────────────────────────────────────────────

export const VendorOnboardingStep = {
    /** Onboarding fully completed. Frontend routes to vendor dashboard. */
    COMPLETED: 0,
    /** Step 1 (Required): country, timezone, payout_details */
    BASIC_SETUP: 1,
    /** Step 2 (Optional/Skippable): default_delivery_agency_id — skip if vendor sells services only */
    DELIVERY_LINKING: 2,
    /** Step 3 (Optional/Skippable): branding (logo, cover), business_addresses */
    BRANDING: 3,
    /** Step 4 (Optional/Skippable): return_policy, cancellation_policy, support_policy */
    POLICY_SETUP: 4,
} as const;

export type VendorOnboardingStepValue =
    (typeof VendorOnboardingStep)[keyof typeof VendorOnboardingStep];

// ─── Delivery Agency Onboarding Steps ────────────────────────────────────────

export const AgencyOnboardingStep = {
    /** Onboarding fully completed. Frontend routes to agency dashboard. */
    COMPLETED: 0,
    /**
     * Step 1 (Required): coverage_areas (min 1 region),
     * headquarters_addresses (min 1 entry; first entry is primary)
     */
    LOGISTICS_SETUP: 1,
    /** Step 2 (Required): payout_details */
    PAYOUT_SETUP: 2,
    /** Step 3 (Optional/Skippable): logo_file_id, timezone */
    BRANDING: 3,
    /** Step 4 (Required): pricing, returns, and damage policies */
    POLICY_SETUP: 4,
} as const;

export type AgencyOnboardingStepValue =
    (typeof AgencyOnboardingStep)[keyof typeof AgencyOnboardingStep];

// ─── Delivery Agent Onboarding Steps ─────────────────────────────────────────

export const AgentOnboardingStep = {
    /** Onboarding fully completed. Frontend routes to agent dashboard. */
    COMPLETED: 0,
    /** Step 1 (Required): vehicle_info (vehicle_type, color) */
    VEHICLE_SETUP: 1,
    /** Step 2 (Optional/Skippable): avatar_url, timezone */
    IDENTITY_SETUP: 2,
} as const;

export type AgentOnboardingStepValue =
    (typeof AgentOnboardingStep)[keyof typeof AgentOnboardingStep];

// ─── Roles without an onboarding flow ────────────────────────────────────────

/**
 * Customer and Admin onboarding steps.
 * These roles are always considered COMPLETED (step 0).
 * Stored as a constant for consistent reference in auth-me responses.
 */
export const FixedOnboardingStep = {
    COMPLETED: 0,
} as const;
