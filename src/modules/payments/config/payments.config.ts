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
});

/** True when NotchPay has both the credential to call with and the secret to verify with. */
export function notchPayEnabled(): boolean {
  return NOTCHPAY_CONFIG.PUBLIC_KEY !== '' && NOTCHPAY_CONFIG.WEBHOOK_SECRET !== '';
}

/** True when My-CoolPay has both keys. The private key is BOTH the callback signer and the payout credential. */
export function myCoolPayEnabled(): boolean {
  return MYCOOLPAY_CONFIG.PUBLIC_KEY !== '' && MYCOOLPAY_CONFIG.PRIVATE_KEY !== '';
}
