import { createHash } from 'crypto';
import {
  DEFAULT_LISTING_SETTINGS,
  LISTING_LEAD_WINDOW_DAYS,
  LISTING_PLATFORM_TIMEZONE,
  ListingContactField,
  ListingOnEmpty,
  ListingSettings,
  ListingStatus,
  ListingSuspensionReason,
  ListingVideoHost,
} from './listing.types';

/**
 * The pure half of a reveal (SERVICE-LISTINGS-PLAN § The reveal, L-7 … L-11, L-30, § C-8a) —
 * no I/O, no clock of its own, no database. `ListingRevealService` reads the facts and asks
 * these functions what they mean, so every rule here is pinned by `test:service-listings-reveal`
 * without a server.
 *
 * Imports only `listing.types` (and `crypto`): the bot surface's renderers and the suites read
 * the same rules without pulling a model into their import graph.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RevealCosts {
  first: number;
  next: number;
}

// ─── The lead window (L-7) ──────────────────────────────────────────────────

/** A new lead's window: `LISTING_LEAD_WINDOW_DAYS` from the first reveal. */
export function leadWindowFrom(now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getTime()), end: new Date(now.getTime() + LISTING_LEAD_WINDOW_DAYS * DAY_MS) };
}

/** A lead is CURRENT while its window has not ended. `window_end` itself is already outside. */
export function isCurrentLead(lead: { window_end: Date } | null | undefined, now: Date): boolean {
  return !!lead && new Date(lead.window_end).getTime() > now.getTime();
}

// ─── Price (L-7) ────────────────────────────────────────────────────────────

/**
 * The first field of a window costs `first`, each further field `next`. A lead that is not
 * current is no lead at all: the next reveal opens a new window and starts again at `first`.
 */
export function revealPrice(
  currentLead: { fields_revealed: ReadonlyArray<string> } | null | undefined,
  costs: RevealCosts,
): number {
  return currentLead && currentLead.fields_revealed.length > 0 ? costs.next : costs.first;
}

// ─── Settings (L-10, L-11, L-30) ────────────────────────────────────────────

/** The stored settings with every missing key at its default — missing settings ARE the defaults. */
export function effectiveListingSettings(stored: Partial<ListingSettings> | null | undefined): ListingSettings {
  return {
    on_empty: stored?.on_empty ?? DEFAULT_LISTING_SETTINGS.on_empty,
    debt_floor: stored?.debt_floor ?? DEFAULT_LISTING_SETTINGS.debt_floor,
    max_credits_per_customer_per_day:
      stored?.max_credits_per_customer_per_day ?? DEFAULT_LISTING_SETTINGS.max_credits_per_customer_per_day,
  };
}

// ─── Reachability (step 2, § C-8a) ──────────────────────────────────────────

/**
 * How a listing may be revealed from, for one customer:
 *
 *   live     — the ordinary path: open or extend a lead, debit with `debitIfSufficient`.
 *   grace    — L-10: a listing suspended `insufficient_credits`, a customer whose CURRENT lead
 *              was engaged while it was live, and a provider whose `on_empty` is
 *              `continue_engaged`. Debited with `debitAllowingDebt(debt_floor)`.
 *   refuse   — everyone else: `LISTING_UNREACHABLE`. An oversight or quota suspension, an
 *              archive, or an inactive provider refuses EVERYONE (§ C-8a) — the grace belongs
 *              to the credit suspension alone. (A field already revealed in the current window
 *              is returned free BEFORE this question is asked — step 1.)
 *
 * A non-live listing never opens a lead: `grace` requires the current lead to exist already.
 */
export type RevealPath = 'live' | 'grace' | 'refuse';

export interface ReachabilityFacts {
  status: ListingStatus;
  suspensionReason: ListingSuspensionReason | null;
  vendorActive: boolean;
  currentLeadEngaged: boolean;
  onEmpty: ListingOnEmpty;
}

export function revealPathFor(facts: ReachabilityFacts): RevealPath {
  if (!facts.vendorActive) return 'refuse';
  if (facts.status === 'live' && facts.suspensionReason === null) return 'live';
  if (
    facts.status === 'suspended'
    && facts.suspensionReason === 'insufficient_credits'
    && facts.currentLeadEngaged
    && facts.onEmpty === 'continue_engaged'
  ) {
    return 'grace';
  }
  return 'refuse';
}

/**
 * A LIVE listing whose ordinary debit failed (the balance cannot cover the price): the grace
 * rule decides whether this one customer may still be served into debt.
 */
export function liveDebitFallback(currentLeadEngaged: boolean, onEmpty: ListingOnEmpty): 'grace' | 'refuse' {
  return currentLeadEngaged && onEmpty === 'continue_engaged' ? 'grace' : 'refuse';
}

/** Step 7: below the first-reveal cost, the provider's live listings are suspended. */
export function shouldSuspendAfterDebit(balanceAfter: number, costs: RevealCosts): boolean {
  return balanceAfter < costs.first;
}

// ─── The daily cap (L-30) ───────────────────────────────────────────────────

/**
 * The platform day containing `now`, in `timeZone` (Africa/Douala by default): `[start, end)`.
 *
 * Computed from the zone's own wall clock rather than a fixed offset, so the rule does not
 * silently move if the platform zone ever changes to one with daylight saving.
 */
export function platformDayBounds(now: Date, timeZone: string = LISTING_PLATFORM_TIMEZONE): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // The zone's wall clock read as if it were UTC, minus the real instant = the zone's offset.
  const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  const midnightWallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'));
  const start = new Date(midnightWallAsUtc - offsetMs);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Would this reveal take the customer's spend on this listing today above the provider's cap?
 * `cap: null` = no limit. `spentToday` counts NON-refunded reveals only (the caller's query).
 */
export function exceedsDailyCap(spentToday: number, price: number, cap: number | null): boolean {
  return cap !== null && spentToday + price > cap;
}

// ─── The value (§ C-3 RevealResult.value) ───────────────────────────────────

export interface RevealSocialLink {
  network: string;
  url: string;
}

export type RevealValue =
  | { number: string; link: string }                                            // whatsapp
  | { number: string; numbers: string[] }                                       // phone: first + all (2026-11-08)
  | { address: string }                                                         // email
  | { url: string }                                                             // website
  | { links: RevealSocialLink[] }                                               // socials
  | { address: string; latitude: number; longitude: number; mapUrl: string }   // location
  | { url: string; host: ListingVideoHost };                                    // video

const digitsOf = (value: string): string => value.replace(/\D/g, '');

/** WhatsApp's click-to-chat link: `https://wa.me/<digits>` — the number with every non-digit dropped. */
export function whatsappLinkFor(number: string): string {
  return `https://wa.me/${digitsOf(number)}`;
}

/** A map link that opens the pin in any maps app or browser. */
export function mapUrlFor(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

interface StoredLocation {
  formatted_address?: string | null;
  coordinates?: { coordinates?: [number, number] | number[] } | null;
}

/**
 * The wire value of one STORED field (`listing_contacts.published.<field>`), or `null` when the
 * stored shape carries nothing usable — which the caller treats exactly like an absent field.
 */
export function revealValueOf(field: ListingContactField, raw: unknown): RevealValue | null {
  if (raw === null || raw === undefined) return null;
  switch (field) {
    case 'whatsapp':
      return typeof raw === 'string' && raw.trim() ? { number: raw.trim(), link: whatsappLinkFor(raw) } : null;
    case 'phone': {
      // One number (a row written before 2026-11-08, or a provider with one line) or both. `number`
      // stays the first so every renderer written for one keeps working; `numbers` is all of them.
      const numbers = (Array.isArray(raw) ? raw : [raw])
        .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
        .map((n) => n.trim());
      return numbers.length > 0 ? { number: numbers[0], numbers } : null;
    }
    case 'email':
      return typeof raw === 'string' && raw.trim() ? { address: raw.trim() } : null;
    case 'website':
      return typeof raw === 'string' && raw.trim() ? { url: raw.trim() } : null;
    case 'socials': {
      if (!Array.isArray(raw)) return null;
      const links = raw
        .filter((s): s is { network?: unknown; url?: unknown } => !!s && typeof s === 'object')
        .filter((s) => typeof s.url === 'string' && s.url.trim().length > 0)
        .map((s) => ({ network: typeof s.network === 'string' ? s.network : 'other', url: String(s.url).trim() }));
      return links.length > 0 ? { links } : null;
    }
    case 'location': {
      const loc = raw as StoredLocation;
      const pair = loc.coordinates?.coordinates;
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const [longitude, latitude] = pair as [number, number];
      if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
      return {
        address: loc.formatted_address ?? '',
        latitude,
        longitude,
        mapUrl: mapUrlFor(latitude, longitude),
      };
    }
    case 'video': {
      const video = raw as { url?: unknown; host?: unknown };
      if (typeof video.url !== 'string' || !video.url.trim()) return null;
      const host: ListingVideoHost = video.host === 'google_drive' ? 'google_drive' : 'youtube';
      return { url: video.url.trim(), host };
    }
    default:
      return null;
  }
}

// ─── The fingerprint (L-9) ──────────────────────────────────────────────────

/**
 * The normalised form a fingerprint is taken of. Two spellings of one value must agree, so
 * "charge once per number" can later be read off the money record with no migration (L-9).
 *
 *   whatsapp / phone  `tel:<digits>` — the SAME prefix for both, so one number given as the
 *                     WhatsApp of one listing and the phone of another is recognisably one
 *   email             `email:<trimmed, lower-cased>`
 *   website           `url:<trimmed, lower-cased, no trailing slash>`
 *   socials           `socials:<each url normalised as above, sorted, joined>`
 *   location          `geo:<lat>,<lng>` to six decimals (about 11 cm)
 *   video             `video:<url normalised as above>`
 */
export function normaliseForFingerprint(field: ListingContactField, value: RevealValue): string {
  const url = (u: string): string => u.trim().toLowerCase().replace(/\/+$/, '');
  switch (field) {
    case 'whatsapp':
      return `tel:${digitsOf((value as { number: string }).number)}`;
    case 'phone': {
      // One number fingerprints exactly as before 2026-11-08; two join in stored order.
      const v = value as { number: string; numbers?: string[] };
      return (v.numbers?.length ? v.numbers : [v.number]).map((n) => `tel:${digitsOf(n)}`).join('|');
    }
    case 'email':
      return `email:${(value as { address: string }).address.trim().toLowerCase()}`;
    case 'website':
      return `url:${url((value as { url: string }).url)}`;
    case 'socials':
      return `socials:${(value as { links: RevealSocialLink[] }).links.map((l) => url(l.url)).sort().join('|')}`;
    case 'location': {
      const v = value as { latitude: number; longitude: number };
      return `geo:${v.latitude.toFixed(6)},${v.longitude.toFixed(6)}`;
    }
    case 'video':
      return `video:${url((value as { url: string }).url)}`;
    default:
      return `${String(field)}:`;
  }
}

/** sha256 hex of the normalised value — ⛔ never the value itself (§ C-2). */
export function revealFingerprint(field: ListingContactField, value: RevealValue): string {
  return createHash('sha256').update(normaliseForFingerprint(field, value), 'utf8').digest('hex');
}
