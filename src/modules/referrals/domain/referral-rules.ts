/**
 * The referral program's rules (REFERRAL-PROGRAM-PLAN § 5). PURE: no I/O and no clock of its own,
 * so `test:referrals` can run every worked example of the owner's document against it.
 *
 * ── A rate follows the settings, a duration does not ───────────────────────────
 * The owner's document treats the two differently and this file is where that shows.
 *  - The RATE is read when the commission is earned (`resolveRate`), so a change reaches every
 *    active referral on its next commission. It is then saved on the reward, so a later change
 *    never recalculates what was already earned.
 *  - The DURATION is read once, at registration, and frozen as `expires_at` (`referralExpiresAt`),
 *    so a later change reaches new referrals only and can never reactivate an expired one.
 */

/**
 * `provider` since 2026-11-08 (LISTING-REVIEWS-SAVES-REFERRALS-PLAN § 3.3, owner RS-3): a vendor
 * who registered as a SERVICE PROVIDER. It earns on what the provider pays Wi-Mall (plans and
 * credit packs), never on commission, which a provider does not generate. A seller stays `vendor`.
 */
export const REFERRED_CATEGORIES = ['vendor', 'customer', 'agency', 'agent', 'provider'] as const;
export type ReferredCategory = (typeof REFERRED_CATEGORIES)[number];

/** The categories that can earn. An `agent` relationship is recorded and never earns (document § 13). */
export const EARNING_CATEGORIES = ['vendor', 'customer', 'agency', 'provider'] as const;
export type EarningCategory = (typeof EARNING_CATEGORIES)[number];

export function isEarningCategory(value: string): value is EarningCategory {
  return (EARNING_CATEGORIES as readonly string[]).includes(value);
}

/** The category a NEW account is referred under: a provider vendor is `provider`, every other role itself. */
export function referredCategoryOf(role: 'customer' | 'vendor' | 'agency' | 'agent', vendorKind?: string | null): ReferredCategory {
  return role === 'vendor' && vendorKind === 'provider' ? 'provider' : role;
}

/**
 * The second reward source (owner RS-3, 2026-11-08): a provider's own payment to Wi-Mall. A
 * `plan_purchases` row (a plan) or a `credit_topups` row (a credit pack), `paid`. The commission
 * sources stay `order` · `cod_collection` · `booking`.
 */
export const BILLING_REWARD_SOURCES = ['plan_purchase', 'credit_topup'] as const;
export type BillingRewardSource = (typeof BILLING_REWARD_SOURCES)[number];

export function isBillingRewardSource(value: string): value is BillingRewardSource {
  return (BILLING_REWARD_SOURCES as readonly string[]).includes(value);
}

/**
 * What a partner is told a provider reward came from (owner RS-7): the KIND, never the amount the
 * provider paid. `null` on a commission reward, which carries no kind.
 */
export type RewardPaymentKind = 'plan' | 'credits';

export function paymentKindOf(sourceType: string): RewardPaymentKind | null {
  if (sourceType === 'plan_purchase') return 'plan';
  if (sourceType === 'credit_topup') return 'credits';
  return null;
}

export const PARTNER_STATUSES = ['pending', 'active', 'rejected', 'suspended', 'terminated'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export type PartnerVerb = 'approve' | 'reject' | 'suspend' | 'reinstate' | 'terminate';

/**
 * Which verb may run from which status, and where it lands. The document's "approved" and
 * "active" are one state here: approval makes the partner active. `terminated` has no exit by
 * itself: an administrator allows a new application (owner R-9), which is a separate write.
 */
export const PARTNER_TRANSITIONS: Readonly<Record<PartnerVerb, { from: readonly PartnerStatus[]; to: PartnerStatus }>> = {
  approve: { from: ['pending'], to: 'active' },
  reject: { from: ['pending'], to: 'rejected' },
  suspend: { from: ['active'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'active' },
  terminate: { from: ['active', 'suspended'], to: 'terminated' },
};

export const RATE_MIN_PERCENT = 0;
/** Owner, document § 14: an administrator can never set more than this. */
export const RATE_MAX_PERCENT = 25;
export const DURATION_MIN_MONTHS = 1;
export const DURATION_MAX_MONTHS = 120;

/** The defaults when no settings document exists. Current values, not permanent ones (document § 8). */
export const REFERRAL_DEFAULTS = Object.freeze({
  enabled: false,
  ratePercent: 3,
  durationMonths: 6,
  minPayoutAmount: 1_000,
  rewardWaitDays: 14,
});

export interface CategoryTerms {
  rate_percent: number;
  duration_months: number;
}

export interface CategoryOverride {
  rate_percent: number | null;
  duration_months: number | null;
}

export type GlobalTerms = Record<EarningCategory, CategoryTerms>;
export type PartnerOverrides = Partial<Record<EarningCategory, Partial<CategoryOverride> | null>>;

/** Each field inherits on its own: customising a rate must not customise the duration. */
export function resolveRate(
  category: EarningCategory,
  global: GlobalTerms,
  overrides: PartnerOverrides | null | undefined,
): { ratePercent: number; source: 'global' | 'custom' } {
  const custom = overrides?.[category]?.rate_percent;
  return typeof custom === 'number'
    ? { ratePercent: custom, source: 'custom' }
    : { ratePercent: global[category].rate_percent, source: 'global' };
}

export function resolveDuration(
  category: EarningCategory,
  global: GlobalTerms,
  overrides: PartnerOverrides | null | undefined,
): { durationMonths: number; source: 'global' | 'custom' } {
  const custom = overrides?.[category]?.duration_months;
  return typeof custom === 'number'
    ? { durationMonths: custom, source: 'custom' }
    : { durationMonths: global[category].duration_months, source: 'global' };
}

/** `Africa/Douala` is UTC+1 all year, so one constant is the whole timezone rule. */
const DOUALA_OFFSET_MS = 60 * 60 * 1000;

/**
 * The first instant a referral is NO LONGER eligible.
 *
 * Calendar months in `Africa/Douala`: a registration on January 1 with 6 months earns through the
 * end of June 30, so this returns July 1 00:00 there (document § 11). A date the target month does
 * not have (January 31 + 1 month) earns through that month's last day.
 */
export function referralExpiresAt(registeredAt: Date, durationMonths: number): Date {
  const local = new Date(registeredAt.getTime() + DOUALA_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + durationMonths;
  const day = local.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const boundary = day > lastDayOfTarget
    ? Date.UTC(year, month + 1, 1)
    : Date.UTC(year, month, day);
  return new Date(boundary - DOUALA_OFFSET_MS);
}

export function isWithinEarningPeriod(expiresAt: Date | null | undefined, at: Date): boolean {
  return !!expiresAt && at.getTime() < expiresAt.getTime();
}

/** The moment Wi-Mall earned a commission: the hold's end, or the cash's arrival if that was later (R-1). */
export function commissionEarnedAt(row: {
  hold_release_at?: Date | null;
  cash_settled_at?: Date | null;
  released_at?: Date | null;
}): Date {
  const hold = row.hold_release_at ?? row.released_at ?? new Date(0);
  const cash = row.cash_settled_at;
  return cash && cash.getTime() > hold.getTime() ? cash : hold;
}

export interface PartnerStatusChange {
  to: PartnerStatus;
  at: Date;
}

/**
 * Was this partner active at that moment? Read from the history, not today's status, so a sweep
 * running a day late judges the commission by the partner's status on the day it was earned.
 */
export function wasPartnerActiveAt(history: readonly PartnerStatusChange[], at: Date): boolean {
  let status: PartnerStatus | null = null;
  let latest = -Infinity;
  for (const change of history) {
    const time = change.at.getTime();
    if (time <= at.getTime() && time >= latest) {
      latest = time;
      status = change.to;
    }
  }
  return status === 'active';
}

/** Whether a partner may withdraw now: active, or an administrator released the balance (owner R-9). */
export function isBalanceFrozen(partner: { status: PartnerStatus; balance_released?: unknown }): boolean {
  return partner.status !== 'active' && !partner.balance_released;
}

/** Basis points, so `5.25%` multiplies exactly. */
function toBasisPoints(ratePercent: number): number {
  return Math.round(ratePercent * 100);
}

function mulDivFloor(a: number, b: number, c: number): number {
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/**
 * A participant's part of the commission. The whole of it, except a prepaid order's agency, which
 * takes its share by parcel value (R-7). Shares are written as a fraction because they are applied
 * again to whatever is left after a refund.
 */
export interface RewardShare {
  numerator: number;
  denominator: number;
}

export const WHOLE_SHARE: RewardShare = Object.freeze({ numerator: 1, denominator: 1 });

export function rewardBase(retainedCommission: number, share: RewardShare): number {
  if (retainedCommission <= 0 || share.denominator <= 0 || share.numerator <= 0) return 0;
  return mulDivFloor(retainedCommission, Math.min(share.numerator, share.denominator), share.denominator);
}

/**
 * `floor(base × rate / 100)` in whole FCFA. Used for the first calculation AND after every refund,
 * always from the commission retained and the rate saved on the reward, so the reward can never
 * exceed the rate applied to what Wi-Mall kept (document § 14).
 */
export function rewardAmount(retainedCommission: number, ratePercent: number, share: RewardShare = WHOLE_SHARE): number {
  const base = rewardBase(retainedCommission, share);
  return base > 0 ? mulDivFloor(base, toBasisPoints(ratePercent), 10_000) : 0;
}

export function isValidRatePercent(value: number): boolean {
  return Number.isFinite(value)
    && value >= RATE_MIN_PERCENT
    && value <= RATE_MAX_PERCENT
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

export function isValidDurationMonths(value: number): boolean {
  return Number.isInteger(value) && value >= DURATION_MIN_MONTHS && value <= DURATION_MAX_MONTHS;
}

const CODE_PATTERN = /^[A-Z0-9]{4,20}$/;

/** Upper-case, trimmed, or null when it cannot be a code. Lookups are case-insensitive through this. */
export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** The letters of a code: the first word of the name, or a neutral stem for a name with no latin letters. */
export function referralCodeStem(name: string | null | undefined): string {
  const firstWord = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .split(/\s+/)[0] ?? '';
  const letters = firstWord.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  return letters.length >= 3 ? letters : 'WIMALL';
}

const WHATSAPP_REF_PREFIX = 'Wi-Mall ref:';
const TELEGRAM_START_PREFIX = 'ref_';

export function referralWhatsappText(code: string): string {
  return `${WHATSAPP_REF_PREFIX} ${code}`;
}

export function referralTelegramStart(code: string): string {
  return `${TELEGRAM_START_PREFIX}${code}`;
}

/**
 * The code inside a customer's first message: the text a referral link prefills on WhatsApp, or
 * Telegram's `/start ref_CODE`. Anything else is an ordinary message and carries no code.
 */
export function parseReferralCodeFromMessage(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const match = /(?:wi-mall\s+ref:\s*|\/start(?:@\w+)?\s+ref_)([A-Za-z0-9]{4,20})/i.exec(text);
  return match ? normalizeReferralCode(match[1]) : null;
}

/** "Ulrich Mbarga" → "U***** M*****". A partner never sees the name of who they referred in full (R-8). */
export function maskDisplayName(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '***';
  return words.slice(0, 3).map((word) => `${[...word][0]}${'*'.repeat(Math.min(5, Math.max(1, [...word].length - 1)))}`).join(' ');
}
