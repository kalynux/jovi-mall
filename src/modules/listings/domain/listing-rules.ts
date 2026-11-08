/**
 * The pure rules of a listing (SERVICE-LISTINGS-PLAN L-5, O-15, O-18, § C-2, § C-8a) —
 * no database, no clock, no network, so `test:service-listings-catalog` can pin every one
 * of them with plain objects.
 *
 *   § completeness   what SUBMIT requires (`LISTING_INCOMPLETE`, `details.missing[]`)
 *   § contacts       which fields a contact set HAS — names, never values
 *   § state machine  which provider action is valid in which state, and where it leads
 *   § links          http(s) only; the video must be YouTube or Google Drive
 *   § pre-flags      phone numbers, emails and links typed into the PUBLIC text (O-15)
 *   § slugs          the public URL key
 *   § settings       the L-10 / L-11 / L-30 provider settings
 */
import { normalizePhoneNumber } from '../../../core/validation/phone';
import { isEmailAddress, normalizeEmailAddress } from '../../../core/validation/email';
import {
  LISTING_CONTACT_FIELDS,
  LISTING_MAX_CATEGORIES,
  LISTING_TITLE_MIN,
  LISTING_TITLE_MAX,
  LISTING_COMPANY_MIN,
  LISTING_COMPANY_MAX,
  LISTING_DESCRIPTION_MIN,
  ListingContactField,
  ListingRequiredField,
  ListingReviewState,
  ListingStatus,
  ListingSuspensionReason,
  ListingVideoHost,
} from './listing.types';

// ─── § completeness ──────────────────────────────────────────────────────────

/** The content fields completeness reads. Structural, so a lean document or a DTO both fit. */
export interface CompletenessContent {
  title?: string | null;
  company_name?: string | null;
  category_ids?: ReadonlyArray<unknown> | null;
  country?: string | null;
  city?: string | null;
  area?: string | null;
  description?: string | null;
}

const filled = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');

/**
 * What a submission is missing, in the order the dashboard shows its form. Empty = complete.
 *
 * Judged at SUBMIT only (§ C-4): a draft is saved half-written on purpose. "At least one
 * contact field" is part of completeness — a listing nobody can reach sells nothing, and
 * the reveal buttons are the whole product.
 */
export function findMissing(
  content: CompletenessContent | null | undefined,
  contacts: ContactPresence | null | undefined,
): ListingRequiredField[] {
  const c = content ?? {};
  const missing: ListingRequiredField[] = [];
  const title = filled(c.title);
  if (title.length < LISTING_TITLE_MIN || title.length > LISTING_TITLE_MAX) missing.push('title');
  const company = filled(c.company_name);
  if (company.length < LISTING_COMPANY_MIN || company.length > LISTING_COMPANY_MAX) missing.push('companyName');
  const categories = c.category_ids?.length ?? 0;
  if (categories < 1 || categories > LISTING_MAX_CATEGORIES) missing.push('categories');
  if (!/^[A-Z]{2}$/.test(filled(c.country))) missing.push('country');
  if (!filled(c.city)) missing.push('city');
  if (!filled(c.area)) missing.push('area');
  if (filled(c.description).length < LISTING_DESCRIPTION_MIN) missing.push('description');
  if (availableFieldsOf(contacts).length === 0) missing.push('contact');
  return missing;
}

// ─── § contacts ──────────────────────────────────────────────────────────────

/** A contact set as far as "which fields does it have" is concerned. */
export interface ContactPresence {
  whatsapp?: string | null;
  phone?: string | null;
  phone2?: string | null;
  email?: string | null;
  website?: string | null;
  socials?: ReadonlyArray<unknown> | null;
  location?: unknown;
  video?: { url?: string | null } | null;
}

function hasField(set: ContactPresence, field: ListingContactField): boolean {
  switch (field) {
    case 'phone':
      // The second number counts too (2026-11-08); normally it is never set alone.
      return filled(set.phone).length > 0 || filled(set.phone2).length > 0;
    case 'whatsapp':
    case 'email':
    case 'website':
      return filled(set[field]).length > 0;
    case 'socials':
      return (set.socials?.length ?? 0) > 0;
    case 'location':
      return set.location !== null && set.location !== undefined;
    case 'video':
      return filled(set.video?.url).length > 0;
  }
}

/**
 * WHICH contact fields a set has — field NAMES, in button order, never a value.
 *
 * ⛔ This is the only thing the approve path copies from `listing_contacts` onto the public
 * `listings` document (`available_fields`), so a public card can draw and price its buttons
 * without any public read touching the sensitive collection. Returning anything but names
 * here would put a contact on every card.
 */
export function availableFieldsOf(set: ContactPresence | null | undefined): ListingContactField[] {
  if (!set) return [];
  return LISTING_CONTACT_FIELDS.filter((f) => hasField(set, f));
}

// ─── § state machine (L-5) ───────────────────────────────────────────────────

export interface ListingStateView {
  status: ListingStatus;
  hasPublished: boolean;
  hasPending: boolean;
  reviewState: ListingReviewState | null;
}

export type ProviderListingAction = 'edit' | 'submit' | 'withdraw' | 'discard_revision' | 'archive';

/**
 * Whether a provider action is valid in this state — the 409 `LISTING_STATUS_CONFLICT` rule.
 *
 *   edit              anything not archived and not waiting for a decision. On a listing with
 *                     no working copy (a live one) the first edit OPENS a revision.
 *   submit            a working copy exists and is not already submitted.
 *   withdraw          a submission is waiting for a decision.
 *   discard_revision  a PUBLISHED listing carries a working copy (submitted or not).
 *   archive           anything not archived.
 */
export function canPerform(action: ProviderListingAction, s: ListingStateView): boolean {
  if (s.status === 'archived') return false;
  switch (action) {
    case 'edit':
      return s.reviewState !== 'pending_review' && (s.hasPending || s.hasPublished);
    case 'submit':
      return s.hasPending && (s.reviewState === 'editing' || s.reviewState === 'rejected');
    case 'withdraw':
      return s.reviewState === 'pending_review';
    case 'discard_revision':
      return s.hasPublished && s.hasPending;
    case 'archive':
      return true;
  }
}

/** An edit on a listing with no working copy clones `published` into `pending` first (L-5). */
export function editOpensRevision(s: ListingStateView): boolean {
  return !s.hasPending && s.hasPublished;
}

/**
 * The `status` an action leaves behind. A listing that was ever approved keeps its own status
 * through every working-copy move — a live listing being revised STAYS live (L-5) — so only a
 * never-published listing walks draft → pending_review → rejected / draft.
 */
export function statusAfter(action: 'submit' | 'withdraw' | 'reject', s: ListingStateView): ListingStatus {
  if (s.hasPublished) return s.status;
  if (action === 'submit') return 'pending_review';
  if (action === 'withdraw') return 'draft';
  return 'rejected';
}

/**
 * Whether a listing occupies one of the plan's `max_active_listings` slots (§ C-8a): `live`,
 * `pending_review`, and `suspended` for any reason but `plan_quota_exceeded` — the products
 * rule, where a quota-suspended item frees its slot so the sweep converges.
 */
export function occupiesSlot(status: ListingStatus, suspensionReason: ListingSuspensionReason | null | undefined): boolean {
  if (status === 'live' || status === 'pending_review') return true;
  return status === 'suspended' && suspensionReason !== 'plan_quota_exceeded';
}

/** The Mongo form of `occupiesSlot`, for counting. Keep the two in step. */
export function occupyingSlotFilter(): Record<string, unknown> {
  return {
    $or: [
      { status: { $in: ['live', 'pending_review'] } },
      { status: 'suspended', 'suspension.reason': { $ne: 'plan_quota_exceeded' } },
    ],
  };
}

// ─── § links ─────────────────────────────────────────────────────────────────

function parseUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/** An absolute http(s) URL with a dotted host — the only links a listing accepts. */
export function isHttpUrl(value: string): boolean {
  const u = parseUrl(value);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.hostname.includes('.') && !u.hostname.endsWith('.');
}

/**
 * The host of a location-video link, or `null` when it is not an accepted one (L-17).
 *
 * Compared on the PARSED hostname, exactly or as a true subdomain — never with `includes`:
 * `youtube.com.evil.example` and `notyoutube.com` both contain the word and both are refused.
 * A YouTube link must name a video (`watch?v=`, `/shorts/`, `/embed/`, `/live/`, `youtu.be/<id>`);
 * a Drive link must name a file (`/file/d/<id>` or `/open?id=`).
 */
export function classifyVideoUrl(value: string): ListingVideoHost | null {
  if (!isHttpUrl(value)) return null;
  const u = parseUrl(value)!;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === 'youtu.be') return path.length > 1 ? 'youtube' : null;
  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (path === '/watch') return (u.searchParams.get('v') ?? '').length > 0 ? 'youtube' : null;
    return /^\/(shorts|embed|live)\/[^/]+/.test(path) ? 'youtube' : null;
  }
  if (host === 'drive.google.com') {
    if (/^\/file\/d\/[^/]+/.test(path)) return 'google_drive';
    if (path === '/open') return (u.searchParams.get('id') ?? '').length > 0 ? 'google_drive' : null;
  }
  return null;
}

// ─── § pre-flags (O-15) ──────────────────────────────────────────────────────

export interface ListingPreflag {
  kind: 'phone' | 'email' | 'url';
  field: string;
  excerpt: string;
}

// Static patterns over module constants — no user input reaches a RegExp constructor.
// Each is linear: one character class per run, no nested quantifier.
const PHONE_RUN = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL_RUN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RUN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const BARE_DOMAIN_RUN = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|cm|fr|io|me|info|biz|co|africa|shop|site|online)\b(?:\/[^\s<>"']*)?/gi;
const WA_ME_RUN = /\bwa\.me\/\S+/gi;

const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15;
const EXCERPT_MAX = 200;

/**
 * Contact details typed into the PUBLIC text — help for the reviewer, never a decision
 * (O-15: text only; photos are checked by eye). Every hit is reported with the field it was
 * found in and the text as typed, so the review screen can highlight it.
 *
 * A run of 8–15 digits counts as a phone number however it is spaced ("6 77 12 34 56"), which
 * is the shape a slipped-in Cameroonian number actually takes. Over-flagging is the right
 * direction: a reviewer dismisses a false hit in a second, and a missed number is the whole
 * revenue of a reveal.
 */
export function detectPreflags(fields: Record<string, string | null | undefined>): ListingPreflag[] {
  const out: ListingPreflag[] = [];
  const seen = new Set<string>();
  const push = (kind: ListingPreflag['kind'], field: string, excerpt: string): void => {
    const key = `${kind}|${field}|${excerpt}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, field, excerpt: excerpt.slice(0, EXCERPT_MAX) });
  };
  for (const [field, raw] of Object.entries(fields)) {
    const text = typeof raw === 'string' ? raw : '';
    if (!text) continue;
    for (const m of text.match(PHONE_RUN) ?? []) {
      const digits = normalizePhoneNumber(m).replace(/^\+/, '');
      if (/^\d+$/.test(digits) && digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS) {
        push('phone', field, m.trim());
      }
    }
    for (const m of text.match(EMAIL_RUN) ?? []) {
      if (isEmailAddress(normalizeEmailAddress(m))) push('email', field, m);
    }
    const emailSpans = text.match(EMAIL_RUN) ?? [];
    for (const m of [...(text.match(URL_RUN) ?? []), ...(text.match(WA_ME_RUN) ?? []), ...(text.match(BARE_DOMAIN_RUN) ?? [])]) {
      // The domain half of an email is not a second finding.
      if (emailSpans.some((e) => e.includes(m))) continue;
      push('url', field, m);
    }
  }
  return out;
}

// ─── § slugs ─────────────────────────────────────────────────────────────────

const SLUG_MAX = 80;

/**
 * The slug BASE for a title: ASCII, lowercase, hyphenated — the store slug's house style
 * (`store-provisioning.service.ts`), with accents FOLDED rather than dropped, so "Plomberie
 * Yaoundé" is `plomberie-yaounde` and not `plomberie-yaound`. Uniqueness (a numeric suffix)
 * is the repository's job; the slug never changes after the first approval.
 */
export function listingSlugBase(title: string | null | undefined): string {
  const base = (title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return base || 'listing';
}

/** `base`, then `base-2`, `base-3` … — the n-th candidate (n ≥ 1). */
export function slugCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

// ─── § settings (L-10, L-11, L-30) ───────────────────────────────────────────

export interface ListingSettingsInput {
  onEmpty: 'stop' | 'continue_engaged';
  debtFloor: number | null;
  maxCreditsPerCustomerPerDay: number | null;
}

/**
 * Why a settings write is refused (`422 LISTING_SETTINGS_INVALID`), or `null`.
 *
 * A floor is a NEGATIVE bound (L-11: how far into debt continued service may go), so a positive
 * one is nonsense. A daily cap under the first-reveal cost would mean no reveal could ever
 * happen on a fresh day — the listing would be live and unreachable (L-30).
 */
export function settingsProblem(input: ListingSettingsInput, firstRevealCost: number): string | null {
  if (input.debtFloor !== null && input.debtFloor > 0) {
    return 'The debt floor is how far below zero your balance may go, so it must be 0 or negative.';
  }
  if (input.maxCreditsPerCustomerPerDay !== null && input.maxCreditsPerCustomerPerDay < firstRevealCost) {
    return `The daily limit per customer must be at least ${firstRevealCost} credits (the cost of a first reveal), or empty for no limit.`;
  }
  return null;
}
