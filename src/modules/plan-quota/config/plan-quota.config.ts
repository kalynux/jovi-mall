/**
 * Plan-quota enforcement configuration.
 *
 * Two knobs only. Everything else about the feature — which items survive, in what
 * order — is derived from the plan and is deliberately not tunable: an operator-adjusted
 * cut-off rule would mean two deployments disagreeing about what a plan entitles you to.
 */
export const PLAN_QUOTA_CONFIG = {
    /**
     * Cadence of the drift sweep. Runs after the plan-expiry worker (`0 3`) and the
     * agency shipment-cap monitor (`30 3`), because expiry is one of the things that
     * changes an owner's plan and this should see the result of the same night's run
     * rather than the previous one's.
     *
     * ⚠ This is a **backstop, not the mechanism.** Enforcement normally happens within
     * a second of the plan change, via the `plan.activated` consumer. The sweep exists
     * because that consumer rides the lossy in-memory event bus; it is what turns "an
     * event was probably delivered" into "the state is correct by tomorrow morning".
     */
    RECONCILE_CRON: process.env.PLAN_QUOTA_RECONCILE_CRON || '45 3 * * *',

    /**
     * Kill switch for the sweep. Off does NOT disable enforcement — the event-driven
     * path still runs — it disables only the drift correction, which is what you would
     * want while investigating an incident rather than during normal operation.
     */
    RECONCILE_ENABLED: process.env.PLAN_QUOTA_RECONCILE_ENABLED !== 'false',
} as const;
