import fs from 'fs/promises';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { getGeocodingProviderType, geocodingConfig } from '../../../core/geocoding';
import { getStorageProviderType, storageConfig } from '../../../core/storage';
import { isFcmConfigured } from '../../../config/fcm.config';
import { vectoriserConfig } from '../../../config/vectoriser.config';
import { internalAdminApiEnabled } from '../../../config/internal-admin.config';
import {
    TRACKING_INTEGRATION_CONFIG,
    trackingIntegrationEnabled,
} from '../../tracking-integration/config/tracking-integration.config';
import { ConnectedCalendarAccount } from '../../integrations/calendar/google/connected-account.model';
import { SYSTEM_CONFIG } from '../config/system.config';
import {
    INTEGRATION_CATALOG,
    IntegrationKey,
    IntegrationSpec,
} from '../domain/integration-catalog';
import { lastOutcomeFor } from '../domain/integration-observations';

/**
 * `GET /api/internal/admin/system/integrations`.
 *
 * The policy — which providers may be touched and why — is `domain/integration-catalog.ts`.
 * This file only executes it. If you are about to add a probe, read that file's header first;
 * the answer to "why don't we just call the API to check" is written there for every provider
 * that refuses one.
 */

export interface IntegrationReport {
    key: IntegrationKey;
    label: string;
    impact: string;
    /** A pure config predicate. Free, and never confused with reachability. */
    configured: boolean;
    /** Provider name, key mode, or anything else safe and useful. Never a secret. */
    detail: Record<string, string | number | boolean | null>;
    reachability: {
        mode: IntegrationSpec['reachability'];
        note: string;
        /** null means "not checked", NEVER "down". The mode says which. */
        status: 'ok' | 'error' | 'timeout' | null;
        checkedAt: string | null;
        latencyMs: number | null;
        error: string | null;
    };
}

export interface IntegrationProbeOptions {
    /** Which `on_demand` probes to actually run this request. */
    probe?: IntegrationKey[];
}

export async function describeIntegrations(
    options: IntegrationProbeOptions = {},
): Promise<IntegrationReport[]> {
    const requested = new Set(options.probe ?? []);

    const reports = await Promise.all(
        INTEGRATION_CATALOG.map((spec) => describeOne(spec, requested)),
    );
    return reports;
}

async function describeOne(
    spec: IntegrationSpec,
    requested: Set<IntegrationKey>,
): Promise<IntegrationReport> {
    const { configured, detail } = configurationOf(spec.key);

    const base: IntegrationReport = {
        key: spec.key,
        label: spec.label,
        impact: spec.impact,
        configured,
        detail,
        reachability: {
            mode: spec.reachability,
            note: spec.reachabilityNote,
            status: null,
            checkedAt: null,
            latencyMs: null,
            error: null,
        },
    };

    // An unconfigured integration is not unreachable — it is switched off. Probing it would
    // produce a scary red row for a deliberate local default (`GEO_TRACKER_BASE_URL` unset is
    // the intended development state).
    if (!configured) return base;

    if (spec.reachability === 'passive') {
        const observed = lastOutcomeFor(spec.key);
        if (!observed) return base;
        return {
            ...base,
            reachability: {
                ...base.reachability,
                status: observed.outcome,
                checkedAt: observed.at,
                latencyMs: observed.latencyMs,
                error: observed.error,
            },
        };
    }

    const shouldProbe =
        spec.reachability === 'probed'
        || (spec.reachability === 'on_demand' && requested.has(spec.key));

    if (!shouldProbe) {
        // `never`, or an `on_demand` nobody asked for. Fall back to what traffic already knows.
        const observed = lastOutcomeFor(spec.key);
        if (!observed) return base;
        return {
            ...base,
            reachability: {
                ...base.reachability,
                status: observed.outcome,
                checkedAt: observed.at,
                latencyMs: observed.latencyMs,
                error: observed.error,
            },
        };
    }

    const result = await runProbe(spec.key);
    return { ...base, reachability: { ...base.reachability, ...result } };
}

// ─── Configuration predicates ─────────────────────────────────────────────────
//
// Six of these already existed and were on no route anywhere. This is their first surface.

function configurationOf(key: IntegrationKey): {
    configured: boolean;
    detail: Record<string, string | number | boolean | null>;
} {
    switch (key) {
        case 'geo_tracker':
        case 'geo_tracker_routing':
            return {
                configured: trackingIntegrationEnabled(),
                detail: {
                    baseUrl: TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL || null,
                    // The webhook secret's PRESENCE, never its value. A dispatcher configured
                    // with a base URL and no secret fails every delivery with a 401, which is
                    // otherwise a genuinely confusing thing to debug.
                    webhookSecretSet: Boolean(TRACKING_INTEGRATION_CONFIG.WEBHOOK_HMAC_SECRET),
                    maxAttempts: TRACKING_INTEGRATION_CONFIG.MAX_ATTEMPTS,
                },
            };

        case 'geocoding':
            return {
                configured: true,
                detail: {
                    provider: getGeocodingProviderType(),
                    baseUrl: geocodingConfig.nominatim?.baseUrl ?? null,
                },
            };

        case 'vectoriser':
            return {
                configured: Boolean(vectoriserConfig.baseUrl),
                detail: {
                    baseUrl: vectoriserConfig.baseUrl || null,
                    apiKeySet: Boolean(vectoriserConfig.apiKey),
                },
            };

        case 'storage':
            return {
                configured: true,
                detail: { provider: getStorageProviderType() },
            };

        case 'smtp': {
            const provider = process.env.MAIL_PROVIDER || 'console';
            return {
                configured: provider !== 'console' && Boolean(process.env.SMTP_HOST),
                detail: {
                    provider,
                    host: process.env.SMTP_HOST || null,
                    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null,
                },
            };
        }

        case 'telegram':
            return {
                configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
                detail: { botName: process.env.TELEGRAM_BOT_NAME || null },
            };

        case 'whatsapp':
            return {
                configured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
                detail: {
                    apiUrl: process.env.WHATSAPP_API_URL || null,
                    phoneNumberIdSet: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
                },
            };

        case 'fcm':
            return {
                configured: isFcmConfigured(),
                detail: { projectId: process.env.FCM_PROJECT_ID || null },
            };

        case 'stripe': {
            const key = process.env.STRIPE_SECRET_KEY || '';
            return {
                configured: Boolean(key),
                detail: {
                    // The one genuinely load-bearing fact a probe could not have told us, and
                    // the reason `never` costs nothing here: whether this deploy is pointed at
                    // a live merchant account or a test one.
                    mode: key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : null,
                    webhookSecretSet: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
                },
            };
        }

        /**
         * `configured: false` even with a key present, and that is not a bug.
         *
         * Both gateways are placeholders — see `integration-catalog.ts`. "Configured" here has
         * to mean "this payment path works", because that is what an operator reads it as. A
         * green row next to an API key, for a gateway whose HTTP call is commented out and whose
         * method ends in a throw, is exactly the kind of confidently wrong signal this whole
         * surface exists to eliminate.
         */
        case 'notchpay':
            return {
                configured: false,
                detail: {
                    implemented: false,
                    apiKeySet: Boolean(process.env.NOTCHPAY_API_KEY),
                    baseUrl: process.env.NOTCHPAY_BASE_URL || null,
                    webhookSecretSet: Boolean(process.env.NOTCHPAY_WEBHOOK_SECRET),
                },
            };

        case 'mycoolpay':
            return {
                configured: false,
                detail: {
                    implemented: false,
                    apiKeySet: Boolean(process.env.MYCOOLPAY_API_KEY),
                    baseUrl: process.env.MYCOOLPAY_BASE_URL || null,
                    webhookSecretSet: Boolean(process.env.MYCOOLPAY_WEBHOOK_SECRET),
                },
            };

        case 'google_calendar':
            return {
                configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
                detail: { tokenEncryptionKeySet: Boolean(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY) },
            };

        case 'wi_admin':
            return {
                configured: internalAdminApiEnabled(),
                detail: {},
            };
    }
}

// ─── Probes ───────────────────────────────────────────────────────────────────

interface ProbeResult {
    status: 'ok' | 'error' | 'timeout';
    checkedAt: string;
    latencyMs: number;
    error: string | null;
}

/**
 * A probe failure, as an `AppError` rather than a bare `Error`.
 *
 * These never reach the global error handler — `runProbe` catches every one and turns it into a
 * row on the response, because "SMTP is unreachable" is an *answer* from this endpoint, not a
 * failure of it. The status code is therefore inert; `createAppError` is used because it is the
 * house Error type and the ESLint rule that enforces that is right to have no exception for
 * "but I catch it".
 */
function probeFailure(message: string): Error {
    return createAppError(ERROR_CODES.INTEGRATION_PROBE_FAILED, 502, message);
}

async function runProbe(key: IntegrationKey): Promise<ProbeResult> {
    const startedAt = Date.now();
    try {
        switch (key) {
            case 'geo_tracker':
            case 'geo_tracker_routing':
                await probeGeoTracker();
                break;
            case 'storage':
                await probeStorage();
                break;
            case 'smtp':
                await probeSmtp();
                break;
            case 'telegram':
                await probeTelegram();
                break;
            default:
                // Unreachable: `runProbe` is only called for `probed` / requested `on_demand`.
                throw probeFailure(`no probe defined for ${key}`);
        }
        return {
            status: 'ok',
            checkedAt: new Date().toISOString(),
            latencyMs: Date.now() - startedAt,
            error: null,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: /timeout|abort/i.test(message) ? 'timeout' : 'error',
            checkedAt: new Date().toISOString(),
            latencyMs: Date.now() - startedAt,
            error: message,
        };
    }
}

async function probeGeoTracker(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYSTEM_CONFIG.INTEGRATION_PROBE_TIMEOUT_MS);
    try {
        const base = TRACKING_INTEGRATION_CONFIG.GEO_TRACKER_BASE_URL.replace(/\/+$/, '');
        const response = await fetch(`${base}/healthz`, { signal: controller.signal });
        if (!response.ok) throw probeFailure(`/healthz returned ${response.status}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Local storage only, and a READ-only check: can this process write into the root, and how much
 * room is left. It creates no file — `fs.access` asks the kernel rather than trying.
 */
async function probeStorage(): Promise<void> {
    if (getStorageProviderType() !== 'local') {
        throw probeFailure('only the local provider is probed; remote providers are configuration-only');
    }
    const root = (storageConfig as { local?: { basePath?: string } }).local?.basePath;
    if (!root) throw probeFailure('local storage has no configured base path');
    await fs.access(root, fs.constants.W_OK);
}

/**
 * `transporter.verify()` — EHLO and AUTH, and nothing sent.
 *
 * Notable because it is called **nowhere else in this repo**: the mail service has always
 * discovered a broken SMTP config on the first real send, which is to say on a customer's
 * verification email.
 *
 * ── This probe did not work until Phase 15 ────────────────────────────────────
 * It used to duck-type for `verify` through an `unknown` cast against a method no provider
 * defined, so it threw `the mail provider exposes no verify()` on **every** call — while the
 * api-doc advertised it as the one genuinely safe probe. The duck-type WAS the bug: it turned
 * a missing method into a runtime failure instead of a compile error. `verify()` is now part
 * of `IMailProvider`, so a provider added later cannot repeat this.
 */
async function probeSmtp(): Promise<void> {
    const { MailService } = await import('../../mail/mail.service');
    await new MailService().verify();
}

async function probeTelegram(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYSTEM_CONFIG.INTEGRATION_PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
        if (!response.ok) throw probeFailure(`getMe returned ${response.status}`);
    } finally {
        clearTimeout(timer);
    }
}

// ─── Google Calendar: counts, not a probe ─────────────────────────────────────

export interface CalendarConnectionSummary {
    connectedVendors: number;
    failingRefresh: number;
}

/**
 * The two facts about Google Calendar an operator can actually act on.
 *
 * There is no service-level probe — authorization is per vendor — so a reachability check would
 * be meaningless even if it were free. These counts are a Mongo query against a collection this
 * service owns, and they answer the real question: is anybody connected, and is anybody's token
 * silently failing to refresh.
 */
export async function calendarConnectionSummary(): Promise<CalendarConnectionSummary> {
    const [connectedVendors, failingRefresh] = await Promise.all([
        ConnectedCalendarAccount.countDocuments({ deletedAt: null }),
        ConnectedCalendarAccount.countDocuments({ deletedAt: null, last_sync_error: { $ne: null } }),
    ]);
    return { connectedVendors, failingRefresh };
}
