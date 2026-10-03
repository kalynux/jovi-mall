/**
 * Configuration for the payment gateways.
 *
 * Values and defaults live here; `config/env.ts` validates whether the
 * environment they are applied to makes sense. That split is the house
 * convention — see the header of `src/config/env.ts`.
 *
 * Two things about this file are deliberate:
 *
 * - **Keys are read here, once, at import.** The gateway *clients* are lazy
 *   (`getNotchPayClient()` / `getMyCoolPayClient()`, mirroring
 *   `getStripeClient()`), so a missing key is a typed refusal at call time
 *   rather than a `console.warn` at boot that nobody reads.
 * - **Every credential has exactly one home.** NotchPay carries three distinct
 *   keys with three distinct jobs and they are not interchangeable; the same
 *   value in the wrong variable fails in a way that looks like a network fault.
 */
import { gatewayWebhookPath } from '../gateways/gateway.interface';

/**
 * NotchPay — https://api.notchpay.co
 *
 * PUBLIC_KEY  → the `Authorization` header on every call (`pk_…`).
 * PRIVATE_KEY → the `X-Grant` header, required only on sensitive endpoints
 *               (refunds, balance, transfers) (`sk_…`).
 * WEBHOOK_SECRET → the dashboard's *Hash Key* (`hsk_…`), used for
 *               HMAC-SHA256 over the raw callback body. It is a third key,
 *               NOT the private key — signing with the wrong one produces a
 *               digest that never matches and looks like a forged callback.
 */
export const NOTCHPAY_CONFIG = Object.freeze({
  PUBLIC_KEY: process.env.NOTCHPAY_PUBLIC_KEY || '',
  PRIVATE_KEY: process.env.NOTCHPAY_PRIVATE_KEY || '',
  WEBHOOK_SECRET: process.env.NOTCHPAY_WEBHOOK_SECRET || '',
  BASE_URL: process.env.NOTCHPAY_BASE_URL || 'https://api.notchpay.co',
  REQUEST_TIMEOUT_MS: parseInt(process.env.NOTCHPAY_REQUEST_TIMEOUT_MS || '15000'),

  /**
   * Whether refunds are enabled **on the merchant account**.
   *
   * Defaults to FALSE because that is what the account actually does today:
   * verified 2026-08-18 against the live sandbox, `POST /refunds` answers a
   * bare 403 for every body shape while `GET /refunds` answers 200 with the
   * same credentials. The integration is built and correct; the account is not
   * permitted to use it.
   *
   * Defaulting to true would put a refund button in front of an administrator
   * that fails the moment it is pressed — precisely what
   * `AdminRefundService`'s up-front verdict exists to prevent. Flip this to
   * `true` once NotchPay enables refunds; no code changes with it.
   */
  REFUNDS_ENABLED: (process.env.NOTCHPAY_REFUNDS_ENABLED || 'false') === 'true',
  /**
   * Whether TRANSFERS (money out) are enabled for this deployment.
   *
   * ⚠ Default FALSE, and the default is doing two jobs. The first is ordinary: transfers
   * move real money, so a deployment opts in deliberately. The second is less obvious —
   * NotchPay IP-ALLOWLISTS transfer calls, so enabling this on a host whose egress address
   * has not been registered in the NotchPay dashboard produces a 403 on every attempt, which
   * reads like revoked credentials rather than a missing allowlist entry. Turning it on is a
   * deploy-time decision paired with an ops step, not a code change. See docs/RUNBOOK.md.
   *
   * It also makes NOTCHPAY_PRIVATE_KEY load-bearing — the X-Grant credential, which until
   * now was needed only for refunds and was correspondingly only a boot warning.
   */
  PAYOUTS_ENABLED: (process.env.NOTCHPAY_PAYOUTS_ENABLED || 'false') === 'true',
});

/**
 * My-CoolPay — https://my-coolpay.com/api/{public_key}
 *
 * PUBLIC_KEY  → goes in the URL **path**, not a header. It is also echoed back
 *               on every callback as `application` and must match.
 * PRIVATE_KEY → signs callbacks (MD5 over six concatenated fields) and
 *               authorises payout/balance via `X-PRIVATE-KEY`. There is no
 *               separate webhook secret; `MYCOOLPAY_WEBHOOK_SECRET` was
 *               documented for a while and read by nothing, because the
 *               provider has no such credential.
 * VERIFY_CALLBACK_IP → My-CoolPay's own SDK additionally pins the callback
 *               source to 15.236.140.89. Off by default: behind a proxy or a
 *               tunnel `req.ip` is not the origin, so enabling it without
 *               `trust proxy` configured for that hop refuses every genuine
 *               callback.
 */
export const MYCOOLPAY_CONFIG = Object.freeze({
  PUBLIC_KEY: process.env.MYCOOLPAY_PUBLIC_KEY || '',
  PRIVATE_KEY: process.env.MYCOOLPAY_PRIVATE_KEY || '',
  BASE_URL: process.env.MYCOOLPAY_BASE_URL || 'https://my-coolpay.com/api',
  REQUEST_TIMEOUT_MS: parseInt(process.env.MYCOOLPAY_REQUEST_TIMEOUT_MS || '15000'),
  VERIFY_CALLBACK_IP: (process.env.MYCOOLPAY_VERIFY_CALLBACK_IP || 'false') === 'true',
  /** The single source address My-CoolPay's own SDK accepts callbacks from. */
  CALLBACK_IP: '15.236.140.89',
  /**
   * Master switch for My-CoolPay PAYOUTS (ADR-A08). Default OFF, like NotchPay's and Campay's.
   *
   * ⚠ My-CoolPay FIREWALLS every private-key call (payout AND balance) to at most three server
   * IPs registered by email with its support. From an unregistered address the call does not
   * answer 403: measured 2026-09-30, it HANGS until our timeout. The adapter pre-flights with
   * `GET /balance` so that shows up as an honest refusal, but turning this on is still a
   * deploy-time decision paired with registering the egress IP. See docs/RUNBOOK.md.
   *
   * ⛔ Keep it OFF in production until a stuck `processing` payout has a way out (a sweep over
   * `checkStatus`, and a manual exit for a send that never returned a reference). My-CoolPay
   * sends each callback ONCE and never retries.
   */
  PAYOUTS_ENABLED: (process.env.MYCOOLPAY_PAYOUTS_ENABLED || 'false') === 'true',
});

/** Campay's demo host. Named once: the default below and the production boot warning both read it. */
export const CAMPAY_DEMO_BASE_URL = 'https://demo.campay.net/api';

/**
 * Campay — https://www.campay.net/api (live) · https://demo.campay.net/api (demo)
 *
 * USERNAME / PASSWORD → the application's API credentials, exchanged at `POST /token/` for
 *               a JWT that lives `expires_in` seconds (3600 today). The auth scheme is
 *               `Authorization: Token <jwt>`, NOT `Bearer`.
 * PERMANENT_TOKEN → the app's non-expiring token (APP KEYS). Used ONLY when no
 *               username is set. It never expires, so a leak of it lasts until someone
 *               regenerates it by hand; the username/password pair is preferred.
 * WEBHOOK_KEY → verifies the HS256 JWT in a callback's `signature` field. It authenticates
 *               the sender and NOT the body, which is why every Campay callback is
 *               re-read from `GET /transaction/{ref}/` before anything acts on it
 *               (`CampayGateway.confirmWebhookEvent`).
 *
 * ⚠ BASE_URL defaults to the DEMO host, deliberately (ADR-A08 P2.1). Going live is an
 * explicit act. `config/env.ts` warns in production when Campay credentials point at the
 * demo host, because a demo account answers every call happily and moves no real money.
 */
export const CAMPAY_CONFIG = Object.freeze({
  USERNAME: process.env.CAMPAY_USERNAME || '',
  PASSWORD: process.env.CAMPAY_PASSWORD || '',
  PERMANENT_TOKEN: process.env.CAMPAY_PERMANENT_TOKEN || '',
  WEBHOOK_KEY: process.env.CAMPAY_WEBHOOK_KEY || '',
  BASE_URL: (process.env.CAMPAY_BASE_URL || CAMPAY_DEMO_BASE_URL).replace(/\/+$/, ''),
  REQUEST_TIMEOUT_MS: parseInt(process.env.CAMPAY_REQUEST_TIMEOUT_MS || '15000'),
  /** Refresh the temporary token when less than this remains, so no call races its expiry. */
  TOKEN_REFRESH_MARGIN_MS: 5 * 60 * 1000,
  /**
   * How our merchant reference travels as `external_reference`.
   *
   * Campay documents that field as "a valid and unique UUID4", and ours is
   * `jm_<kind>_<32 hex>`. `raw` sends it unchanged; `uuid` sends the 32 hex digits
   * formatted as a UUID. Either way the FULL `jm_…` reference also travels in
   * `external_user`, which Campay echoes on the callback and on `/transaction/`, and that is
   * what routing reads. So the mode decides only whether Campay accepts the request, never
   * where the callback goes. Measured by `verify:campay`.
   */
  REF_MODE: (process.env.CAMPAY_REF_MODE === 'uuid' ? 'uuid' : 'raw') as 'raw' | 'uuid',
  /**
   * Whether PAYOUTS (`POST /withdraw/`) are enabled for this deployment.
   *
   * ⚠ Default FALSE. Two things must both be true, and only this one is in the environment:
   * the flag, and "allow withdrawals through the API" switched on in the Campay application
   * settings. A refusal for the second reason comes back per call as `unsupported`.
   */
  PAYOUTS_ENABLED: (process.env.CAMPAY_PAYOUTS_ENABLED || 'false') === 'true',
});

/** CinetPay's two hosts. The key prefix picks one; named once for the default and the boot check. */
export const CINETPAY_SANDBOX_BASE_URL = 'https://api.cinetpay.net';
export const CINETPAY_LIVE_BASE_URL = 'https://api.cinetpay.co';

/** CinetPay caps every URL it is handed (notify, success, failed) at this many characters. */
export const CINETPAY_MAX_URL_LENGTH = 120;

/**
 * The URL CinetPay posts its notifications to, or '' when none can be built.
 *
 * Unlike every other gateway here, CinetPay takes the callback URL on EACH request rather than
 * from a dashboard setting, so it has to be known at call time. `CINETPAY_NOTIFY_URL` wins;
 * otherwise it is our own webhook route under `API_PUBLIC_URL`, derived with the same function
 * that registers that route.
 */
function cinetpayNotifyUrl(): string {
  const explicit = (process.env.CINETPAY_NOTIFY_URL ?? '').trim();
  if (explicit) return explicit;
  const base = (process.env.API_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}${gatewayWebhookPath('CINETPAY')}` : '';
}

/**
 * CinetPay — API v1. https://api.cinetpay.co (live) · https://api.cinetpay.net (sandbox)
 *
 * Written from CinetPay's own JS SDK (github.com/cinetpay/cinetpay-js, 2026-03), because their
 * documentation host no longer resolves. It is NOT the older v2 checkout API
 * (`api-checkout.cinetpay.com`, `apikey` + `site_id`, HMAC `x-token`): v1 has neither a site id
 * nor a webhook secret.
 *
 * API_KEY / API_PASSWORD → exchanged at `POST /v1/oauth/login` for a bearer JWT that lives 24 h.
 *               Issued PER COUNTRY; this platform uses the Cameroon pair only. The key's prefix
 *               names its environment: `sk_test_` → sandbox, `sk_live_` → live.
 * BASE_URL    → derived from that prefix unless set. A key sent to the other environment's host
 *               fails to authenticate, so `config/env.ts` refuses the mismatch at boot.
 * NOTIFY_URL  → sent on every charge and transfer. See `cinetpayNotifyUrl`.
 * RETURN_URL  → where the hosted page sends the customer afterwards, when CinetPay redirects
 *               at all (`success_url` and `failed_url`; one value for both).
 * FALLBACK_EMAIL → `client_email` is REQUIRED by CinetPay and many of our customers have none
 *               (registration is bot-first). This is sent in its place.
 * DIRECT_PAY  → ask for the PIN prompt on the customer's handset instead of the hosted page.
 *               An account without direct mode answers `must_be_redirected`, and the adapter
 *               then hands the client CinetPay's page URL instead.
 *
 * ⛔ THE NOTIFICATION IS NOT SIGNED. It carries a per-transaction `notify_token` and the ids; no
 * status, no amount, no signature. So every CinetPay notification is re-read from CinetPay before
 * anything acts on it (`CinetPayGateway.confirmWebhookEvent`). The notification is a doorbell.
 */
export const CINETPAY_CONFIG = Object.freeze({
  API_KEY: process.env.CINETPAY_API_KEY || '',
  API_PASSWORD: process.env.CINETPAY_API_PASSWORD || '',
  BASE_URL: (
    process.env.CINETPAY_BASE_URL ||
    ((process.env.CINETPAY_API_KEY || '').startsWith('sk_live_') ? CINETPAY_LIVE_BASE_URL : CINETPAY_SANDBOX_BASE_URL)
  ).replace(/\/+$/, ''),
  NOTIFY_URL: cinetpayNotifyUrl(),
  RETURN_URL: (
    process.env.CINETPAY_RETURN_URL ||
    process.env.STOREFRONT_URL ||
    process.env.API_PUBLIC_URL ||
    ''
  ).trim(),
  FALLBACK_EMAIL: (
    process.env.CINETPAY_FALLBACK_EMAIL ||
    process.env.MAIL_SUPPORT_EMAIL ||
    process.env.MAIL_FROM_DEFAULT ||
    ''
  ).trim(),
  DIRECT_PAY: (process.env.CINETPAY_DIRECT_PAY || 'true') === 'true',
  REQUEST_TIMEOUT_MS: parseInt(process.env.CINETPAY_REQUEST_TIMEOUT_MS || '15000'),
  /** Refresh the 24-hour token when less than this remains, so no call races its expiry. */
  TOKEN_REFRESH_MARGIN_MS: 60 * 60 * 1000,
  /**
   * Whether PAYOUTS (`POST /v1/transfer`) are enabled for this deployment.
   *
   * ⚠ Default FALSE. CinetPay answers `NOT_ALLOWED` (2011) to a caller IP it has not
   * whitelisted, so turning this on is paired with registering the VPS egress IP with CinetPay.
   * A refusal for that reason comes back per call as `unsupported`.
   */
  PAYOUTS_ENABLED: (process.env.CINETPAY_PAYOUTS_ENABLED || 'false') === 'true',
});

/** Fapshi's two hosts. Named once for the default and the production boot warning. */
export const FAPSHI_SANDBOX_BASE_URL = 'https://sandbox.fapshi.com';
export const FAPSHI_LIVE_BASE_URL = 'https://live.fapshi.com';

/**
 * Fapshi — https://live.fapshi.com (live) · https://sandbox.fapshi.com (sandbox, the default)
 *
 * Source: docs.fapshi.com (its OpenAPI spec and pages, read 2026-10-02) and the official SDK at
 * github.com/Fapshi/SDKs.
 *
 * API_USER / API_KEY → the `apiuser` / `apikey` HEADERS on every call. Each Fapshi "service" has
 *               its own pair, and **one service cannot both collect and pay out** (Fapshi: "After
 *               enabling payouts for a service, that service can no longer collect payments").
 *               So there are two pairs: this one is the COLLECTION service.
 * PAYOUT_API_USER / PAYOUT_API_KEY → the DISBURSEMENT service. Optional; without it no payout.
 * WEBHOOK_SECRET → the per-service secret Fapshi sends back verbatim in `x-wh-secret`. Set the
 *               SAME value on both services, since both post to /api/webhooks/fapshi. It is a
 *               static shared secret, not a signature over the body, which is why every
 *               callback is re-read from `GET /payment-status/{transId}` before it is acted on
 *               (`FapshiGateway.confirmWebhookEvent`; Fapshi's own SDK example does the same).
 *
 * ⚠ BASE_URL defaults to the SANDBOX host, deliberately, like Campay: going live is an explicit
 * act, and `config/env.ts` warns in production while it points at the sandbox.
 * ⚠ In LIVE mode direct pay and payouts are each DISABLED until Fapshi support enables them for
 * the service (see .env.example).
 */
export const FAPSHI_CONFIG = Object.freeze({
  API_USER: process.env.FAPSHI_API_USER || '',
  API_KEY: process.env.FAPSHI_API_KEY || '',
  PAYOUT_API_USER: process.env.FAPSHI_PAYOUT_API_USER || '',
  PAYOUT_API_KEY: process.env.FAPSHI_PAYOUT_API_KEY || '',
  WEBHOOK_SECRET: process.env.FAPSHI_WEBHOOK_SECRET || '',
  BASE_URL: (process.env.FAPSHI_BASE_URL || FAPSHI_SANDBOX_BASE_URL).replace(/\/+$/, ''),
  REQUEST_TIMEOUT_MS: parseInt(process.env.FAPSHI_REQUEST_TIMEOUT_MS || '15000'),
  /**
   * How long a PENDING status answer is reused. Fapshi allows at most 6 status reads per minute
   * per transaction (429 beyond), and a client polling `verify` every few seconds would exceed
   * it. Webhook confirmations never use the cache.
   */
  STATUS_CACHE_MS: 10_000,
  /**
   * Whether PAYOUTS are enabled for this deployment. ⚠ Default FALSE. Live payouts also need
   * Fapshi support to enable them on the disbursement service (email support@fapshi.com with
   * that service's LIVE apiuser), after a sandbox test.
   */
  PAYOUTS_ENABLED: (process.env.FAPSHI_PAYOUTS_ENABLED || 'false') === 'true',
});

/**
 * Cross-gateway payment policy.
 *
 * RECONCILE_* drive the sweep that closes a payment whose callback never
 * arrived. MIN_AGE is a settling window — a mobile-money confirmation
 * legitimately takes minutes, and re-verifying a 30-second-old transaction
 * only spends gateway quota. MAX_AGE bounds the sweep so it does not re-query
 * the whole history forever; anything older is the audit script's problem.
 */
export const PAYMENTS_CONFIG = Object.freeze({
  RECONCILE_CRON: process.env.PAYMENT_RECONCILE_CRON || '*/10 * * * *',
  RECONCILE_MIN_AGE_MINUTES: parseInt(process.env.PAYMENT_RECONCILE_MIN_AGE_MINUTES || '10'),
  RECONCILE_MAX_AGE_HOURS: parseInt(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS || '72'),
  RECONCILE_BATCH_SIZE: parseInt(process.env.PAYMENT_RECONCILE_BATCH_SIZE || '50'),

  /**
   * Wrong OTP submissions tolerated before the transaction is failed.
   *
   * The authorize endpoint is unauthenticated (it sits beside `initiate` and
   * `verify`, which are deliberately open for shareable payment links), and a
   * six-digit code is 10^6 — so the counter is the only thing standing between
   * a caller and the code. It lives on the transaction because the transaction
   * is what is being attacked.
   */
  OTP_MAX_ATTEMPTS: parseInt(process.env.PAYMENT_OTP_MAX_ATTEMPTS || '5'),

  /**
   * How long an instance may serve its cached `payment_settings` before re-reading Mongo
   * (ADR-A08 D-3). It is the cross-instance convergence bound after an aggregator switch, and
   * it is reported to the administrator as `convergenceSeconds` rather than left to be
   * discovered mid-incident. Same shape and default as `MAINTENANCE_CACHE_TTL_MS`.
   */
  SETTINGS_CACHE_TTL_MS: parseInt(process.env.PAYMENT_SETTINGS_CACHE_TTL_MS || '5000'),
});

/** True when NotchPay has both the credential to call with and the secret to verify with. */
export function notchPayEnabled(): boolean {
  return NOTCHPAY_CONFIG.PUBLIC_KEY !== '' && NOTCHPAY_CONFIG.WEBHOOK_SECRET !== '';
}

/** True when My-CoolPay has both keys. The private key is BOTH the callback signer and the payout credential. */
export function myCoolPayEnabled(): boolean {
  return MYCOOLPAY_CONFIG.PUBLIC_KEY !== '' && MYCOOLPAY_CONFIG.PRIVATE_KEY !== '';
}

/**
 * True when Campay has a way to authenticate (username + password, or the permanent token)
 * AND the webhook key. Without the key every callback is refused `missing_secret`, and
 * settlement would rest on the reconciliation sweep alone, so that is not "configured".
 */
export function campayEnabled(): boolean {
  const canCall =
    (CAMPAY_CONFIG.USERNAME !== '' && CAMPAY_CONFIG.PASSWORD !== '') || CAMPAY_CONFIG.PERMANENT_TOKEN !== '';
  return canCall && CAMPAY_CONFIG.WEBHOOK_KEY !== '';
}

/**
 * True when CinetPay has its credential pair AND somewhere to send notifications. There is no
 * webhook secret to require (the notification is unsigned); the notify URL takes its place,
 * because without one every charge would settle on the reconciliation sweep alone.
 */
export function cinetpayEnabled(): boolean {
  return CINETPAY_CONFIG.API_KEY !== '' && CINETPAY_CONFIG.API_PASSWORD !== '' && CINETPAY_CONFIG.NOTIFY_URL !== '';
}

/**
 * True when Fapshi's COLLECTION service has its pair AND the webhook secret. Without the secret
 * every callback is refused `missing_secret`, and Fapshi sends each callback once, never again.
 */
export function fapshiEnabled(): boolean {
  return FAPSHI_CONFIG.API_USER !== '' && FAPSHI_CONFIG.API_KEY !== '' && FAPSHI_CONFIG.WEBHOOK_SECRET !== '';
}

/**
 * True when Stripe (cards) has the credential to call with and the secret to verify with — the
 * same two-part rule as `notchPayEnabled`.
 *
 * ── ⚠ THIS IS THE CARD OFF-SWITCH, AND UNTIL 2026-09-22 NOTHING READ IT ─────
 * The production environment file says, in as many words, that leaving `STRIPE_SECRET_KEY` out
 * "is the off switch … and the gateway simply is not offered". The first half was true and the
 * second was not: the gateway was registered unconditionally, `POST /payments/initiate` accepted
 * `gateway: 'STRIPE'` from any caller, opened a transaction row, and only THEN reached
 * `getStripeClient()` — which is where a customer met "Stripe is not configured" (ORD-2026-000002,
 * 2026-09-22, from the storefront app's "send a payment link" button). The row it left behind
 * was FAILED, so the pay-link mint that followed answered `PAYMENT_LINK_NOT_PAYABLE`.
 *
 * `gatewayAcceptsNewPayments` (`gateways/registry.ts`) reads this, and the orchestrator refuses
 * a gateway it does not accept BEFORE any row exists. So the sentence in the environment file is
 * now true: no secret key, no card payments — on every door, with nothing else to remember.
 *
 * ⚠ **Read live from `process.env`, never frozen into a config object at import.**
 * `getStripeClient()` reads the variable at call time, and the switch and the client must never
 * hold two opinions about whether Stripe exists.
 *
 * ⚠ **Both halves, not just the key.** `config/env.ts` already refuses to boot with the key and
 * no webhook secret, so in a booted process the second test never decides anything — it is here
 * so a test or a script that sets only the key cannot switch on a gateway whose callbacks would
 * all be refused.
 */
export function stripeEnabled(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? '').trim() !== ''
    && (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim() !== '';
}
