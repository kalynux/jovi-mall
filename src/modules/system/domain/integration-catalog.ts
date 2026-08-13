/**
 * Every outbound integration, and — separately — whether it is safe to touch one to find out
 * if it is up.
 *
 * ═══ THE RULE ═════════════════════════════════════════════════════════════════
 *
 *   A diagnostics read may never cause a side effect a customer would see, cost money, or
 *   consume a quota that a real request needs.
 *
 * That rule is why this file exists as a catalog rather than as a loop over base URLs. The
 * naive "health check" for most of these providers is an authenticated API call, and for two of
 * them it is literally sending a message to a person. An operations page that quietly texts a
 * customer every time somebody opens it is not an operations page.
 *
 * ═══ TWO COLUMNS, NEVER CONFLATED ═════════════════════════════════════════════
 *
 *   configured     a pure predicate over config. Free, always computed, always truthful.
 *   reachability   whether the far side answered — and, crucially, HOW we know.
 *
 * Conflating them produces the worst possible answer: "WhatsApp: unknown", which an operator
 * reads as "WhatsApp is broken" when it means "we chose not to ask". So `mode` travels with
 * every reachability verdict.
 *
 *   probed    checked on this request, against a real health path. Cheap and side-effect free.
 *   on_demand safe, but not free — only checked when explicitly asked (`?probe=smtp`).
 *   passive   never checked; reports what REAL traffic last learned, via
 *             `integration-observations.ts`. Honest without costing anything.
 *   never     no safe probe exists at all. Configuration only, and the catalog says why.
 */

export type ReachabilityMode = 'probed' | 'on_demand' | 'passive' | 'never';

export type IntegrationKey =
    | 'geo_tracker'
    | 'geo_tracker_routing'
    | 'geocoding'
    | 'vectoriser'
    | 'storage'
    | 'smtp'
    | 'telegram'
    | 'whatsapp'
    | 'fcm'
    | 'stripe'
    | 'notchpay'
    | 'mycoolpay'
    | 'google_calendar'
    | 'wi_admin';

export interface IntegrationSpec {
    key: IntegrationKey;
    label: string;
    /** What breaks when this is down. Operators triage by consequence, not by name. */
    impact: string;
    reachability: ReachabilityMode;
    /** Why the mode is what it is. Shown on the wire — an unexplained "never" invites a "fix". */
    reachabilityNote: string;
}

export const INTEGRATION_CATALOG: readonly IntegrationSpec[] = Object.freeze([
    {
        key: 'geo_tracker',
        label: 'geo-tracker (live tracking)',
        impact: 'Lifecycle events queue in the outbox; live tracking sessions do not open or close',
        reachability: 'probed',
        reachabilityNote: 'GET /healthz — unauthenticated and dependency-free on the far side',
    },
    {
        key: 'geo_tracker_routing',
        label: 'geo-tracker (routing matrix)',
        impact: 'Auto-assignment ranks by haversine fallback instead of road distance',
        reachability: 'probed',
        reachabilityNote: 'Same service, same /healthz',
    },
    {
        key: 'geocoding',
        label: 'Geocoding provider',
        impact: 'Address search and reverse geocoding fail; new addresses cannot be saved',
        reachability: 'passive',
        reachabilityNote:
            "Nominatim's usage policy is roughly one request per second with bans for abuse — an "
            + 'operator opening a dashboard must not spend that budget',
    },
    {
        key: 'vectoriser',
        label: 'Search vectoriser',
        impact: 'New and edited products are not searchable by vector similarity',
        reachability: 'passive',
        reachabilityNote: 'Third-party service with no documented health path',
    },
    {
        key: 'storage',
        label: 'File storage',
        impact: 'Uploads fail; existing files stay readable if served from a CDN',
        reachability: 'probed',
        reachabilityNote:
            'Local provider only: a read-only writability check on the root, which creates nothing. '
            + 'Cloudinary and Firebase are configuration-only',
    },
    {
        key: 'smtp',
        label: 'Email (SMTP)',
        impact: 'Verification links, receipts and alerts are not delivered',
        reachability: 'on_demand',
        reachabilityNote:
            'transporter.verify() opens a connection and does EHLO/AUTH without sending anything — '
            + 'the one genuinely safe probe here. Off the default read because it costs a TCP+TLS '
            + 'handshake and some providers rate-limit auth attempts',
    },
    {
        key: 'telegram',
        label: 'Telegram bot',
        impact: 'Telegram notifications and account linking stop',
        reachability: 'on_demand',
        reachabilityNote: 'getMe is cheap but authenticates the bot, which should not happen on every page-load',
    },
    {
        key: 'whatsapp',
        label: 'WhatsApp (Meta Cloud API)',
        impact: 'WhatsApp verification codes and notifications stop',
        reachability: 'never',
        reachabilityNote: 'Sending is a message to a real person and costs money; the debug-token call is authenticated and rate-limited',
    },
    {
        key: 'fcm',
        label: 'Firebase Cloud Messaging',
        impact: 'Push notifications stop; in-app records are still written',
        reachability: 'never',
        reachabilityNote: 'Any probe mints an OAuth token against Google',
    },
    {
        key: 'stripe',
        label: 'Stripe (cards)',
        impact: 'Card payments fail at checkout',
        reachability: 'never',
        reachabilityNote:
            'A probe is an authenticated call against a live merchant account — it consumes rate '
            + "limit and appears in the gateway's logs. The test/live key prefix is reported "
            + 'instead: the operationally useful fact, and it leaks nothing',
    },
    /**
     * ⚠ Both mobile-money gateways are **placeholders**, and that is the single most useful
     * thing this endpoint can say about them.
     *
     * `callNotchPayAPI` and `callMyCoolPayAPI` contain a commented-out `fetch` and end in a
     * throw ("API integration not implemented"). With no API key they return a MOCK success —
     * so a checkout appears to start, hands the customer a fake USSD code, and no money ever
     * moves. With a key, every call throws.
     *
     * The consequence for this surface is specific: they must NOT be wired to
     * `recordIntegrationCall`. Instrumenting a placeholder would report "NotchPay: ok, 30
     * seconds ago" on the strength of a mock, which is worse than reporting nothing — it is
     * the operations surface actively vouching for something that does not work.
     */
    {
        key: 'notchpay',
        label: 'NotchPay (mobile money)',
        impact: 'NOT IMPLEMENTED — the gateway is a placeholder; no mobile-money payment completes through it',
        reachability: 'never',
        reachabilityNote:
            'The gateway makes no HTTP call at all: unkeyed it returns a mock success, keyed it '
            + 'throws. Deliberately not instrumented — recording a mock as a successful call '
            + 'would make this page vouch for a payment path that does not exist.',
    },
    {
        key: 'mycoolpay',
        label: 'MyCoolPay (mobile money)',
        impact: 'NOT IMPLEMENTED — the gateway is a placeholder; no mobile-money payment completes through it',
        reachability: 'never',
        reachabilityNote:
            'Same shape as NotchPay: no HTTP call, a mock success when unkeyed, a throw when keyed.',
    },
    {
        key: 'google_calendar',
        label: 'Google Calendar',
        impact: 'Vendor external-calendar blocks go stale; booking rows still bound availability',
        reachability: 'never',
        reachabilityNote:
            'There is no service-level probe — authorization is per vendor, via OAuth. The useful '
            + 'facts here are free Mongo counts instead: how many vendors are connected, and how '
            + 'many last failed a token refresh',
    },
    {
        key: 'wi_admin',
        label: 'wi-admin (inbound)',
        impact: 'The administration dashboard cannot reach this service',
        reachability: 'never',
        reachabilityNote: 'Inbound only — this service is the server, so there is nothing to probe',
    },
]);

export function integrationSpec(key: IntegrationKey): IntegrationSpec {
    return INTEGRATION_CATALOG.find((spec) => spec.key === key)!;
}
