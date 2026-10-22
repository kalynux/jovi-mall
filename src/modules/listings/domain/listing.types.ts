/**
 * Informational service listings — the shared vocabulary.
 *
 * Plan: `PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md` (decisions L-1…L-31, O-12…O-18,
 * and § Contracts). This file imports nothing from the module, so models, services, DTOs,
 * the bot surface and the tests can all read the same lists without a cycle.
 *
 * ⚠ The word is `listing`, never `service`: `service` is already the bookable
 * `Product.type` (L-20).
 */

/** Lifecycle of a listing. `draft` / `pending_review` / `rejected` only while nothing was ever approved. */
export const LISTING_STATUSES = ['draft', 'pending_review', 'rejected', 'live', 'suspended', 'archived'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/**
 * Why a listing is suspended. Disjoint, and each is lifted only by its own path:
 *   insufficient_credits — the provider's balance fell below the first-reveal cost (L-10);
 *                          lifted automatically when a credit brings it back.
 *   platform_oversight   — an administrator took it offline; lifted only by an administrator.
 *   plan_quota_exceeded  — over the plan's `max_active_listings` after a downgrade (O-16);
 *                          lifted only by the plan-quota sweep, oldest first.
 */
export const LISTING_SUSPENSION_REASONS = ['insufficient_credits', 'platform_oversight', 'plan_quota_exceeded'] as const;
export type ListingSuspensionReason = (typeof LISTING_SUSPENSION_REASONS)[number];

/** State of the working copy (`pending`) — a first submission or a revision of a live listing. */
export const LISTING_REVIEW_STATES = ['editing', 'pending_review', 'rejected'] as const;
export type ListingReviewState = (typeof LISTING_REVIEW_STATES)[number];

export const LISTING_DECISIONS = ['approved', 'rejected'] as const;
export type ListingDecision = (typeof LISTING_DECISIONS)[number];

/**
 * The sensitive fields, in the order buttons are drawn. Seven, so the most one customer can
 * cost a provider in one window is FIRST + 6 × NEXT (7 + 24 = 31 with the defaults) — the
 * bound the plan's debt argument rests on. Adding a field moves that bound.
 */
export const LISTING_CONTACT_FIELDS = ['whatsapp', 'phone', 'email', 'website', 'socials', 'location', 'video'] as const;
export type ListingContactField = (typeof LISTING_CONTACT_FIELDS)[number];

export const LISTING_VIDEO_HOSTS = ['youtube', 'google_drive'] as const;
export type ListingVideoHost = (typeof LISTING_VIDEO_HOSTS)[number];

export const LISTING_SOCIAL_NETWORKS = ['facebook', 'instagram', 'tiktok', 'x', 'linkedin', 'youtube', 'other'] as const;
export type ListingSocialNetwork = (typeof LISTING_SOCIAL_NETWORKS)[number];

/** Where a reveal was made — the lead remembers the last one, so a relayed message knows where to go. */
export const LISTING_LEAD_CHANNELS = ['web', 'whatsapp', 'telegram'] as const;
export type ListingLeadChannel = (typeof LISTING_LEAD_CHANNELS)[number];

/** L-10: what happens to engaged customers when the provider runs out of credits. */
export const LISTING_ON_EMPTY = ['stop', 'continue_engaged'] as const;
export type ListingOnEmpty = (typeof LISTING_ON_EMPTY)[number];

export const PROVIDER_MESSAGE_KINDS = ['call_me', 'free_text'] as const;
export type ProviderMessageKind = (typeof PROVIDER_MESSAGE_KINDS)[number];

export const PROVIDER_MESSAGE_CHANNELS = ['whatsapp', 'telegram'] as const;
export type ProviderMessageChannel = (typeof PROVIDER_MESSAGE_CHANNELS)[number];

export const PROVIDER_CONSENT_SOURCES = ['bot', 'web'] as const;
export type ProviderConsentSource = (typeof PROVIDER_CONSENT_SOURCES)[number];

/** What a provider asks for when reporting a lead (L-31): one ticket, either or both. */
export const LISTING_REPORT_WANTS = ['refund', 'check_customer'] as const;
export type ListingReportWant = (typeof LISTING_REPORT_WANTS)[number];

/** The lead window (L-7). Not configurable: the plan fixes it, and the debt bound reads it. */
export const LISTING_LEAD_WINDOW_DAYS = 30;

/** The vendor message caps (L-15, L-24), per customer per 30 days. */
export const PROVIDER_MESSAGE_CAP = 3;
export const PROVIDER_CALL_ME_CAP = 1;

/** "Today" for the L-30 daily cap is the platform day. */
export const LISTING_PLATFORM_TIMEZONE = 'Africa/Douala';

export const LISTING_MAX_CATEGORIES = 5;
export const LISTING_MAX_PHOTOS = 10;
export const LISTING_MAX_SOCIALS = 5;

export type OpeningDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

/** The vendor model's weekly-hours shape (L-28), reused as is. */
export interface ListingOpeningHours {
  day: OpeningDay;
  open_time: string;  // "HH:MM"
  close_time: string; // "HH:MM"
  is_closed: boolean;
}

/** The PUBLIC content of a listing — the only listing data anything indexes or lists. */
export interface ListingContent {
  title: string;
  company_name: string;
  category_ids: string[];
  country: string;          // ISO-3166-1 alpha-2
  city: string;
  area: string;             // the vendor-typed neighbourhood — public, indexed (stated defaults)
  description: string;
  description_rich: unknown | null;
  photo_file_ids: string[];
  opening_hours: ListingOpeningHours[] | null;
}

export interface ListingSocialLink {
  network: ListingSocialNetwork;
  url: string;
}

export interface ListingVideoLink {
  url: string;
  host: ListingVideoHost;
  checked_at: Date | null;
}

/** The SENSITIVE contact set. Stored only in `listing_contacts`, never indexed (L-6). */
export interface ListingContactSet {
  whatsapp: string | null;   // E.164
  phone: string | null;      // E.164
  email: string | null;
  website: string | null;
  socials: ListingSocialLink[];
  location: unknown | null;  // IGeoAddress — kept `unknown` so this file imports nothing
  video: ListingVideoLink | null;
}

/** A provider's L-10 / L-11 / L-30 settings, on `vendors.listing_settings`. */
export interface ListingSettings {
  on_empty: ListingOnEmpty;
  /** ≤ 0 when set; null = no floor. */
  debt_floor: number | null;
  /** ≥ the first-reveal cost when set; null = no limit. */
  max_credits_per_customer_per_day: number | null;
}

export const DEFAULT_LISTING_SETTINGS: Readonly<ListingSettings> = Object.freeze({
  on_empty: 'continue_engaged',
  debt_floor: null,
  max_credits_per_customer_per_day: null,
});

// ─── Wave 1 (step 3 / 5) — additive ─────────────────────────────────────────

/**
 * Domain events a listing emits (§ C-5). Post-commit and fire-and-forget, like every
 * publish on the bus; the payload always carries `listingId` and `vendorId`.
 * `listing.suspended` adds `{ reason }`.
 */
export const LISTING_EVENTS = Object.freeze({
  SUBMITTED: 'listing.submitted',
  APPROVED: 'listing.approved',
  REJECTED: 'listing.rejected',
  SUSPENDED: 'listing.suspended',
  RESUMED: 'listing.resumed',
  VIDEO_UNAVAILABLE: 'listing.video_unavailable',
} as const);

/** Length rules judged at SUBMIT (a draft may be saved half-written). */
export const LISTING_TITLE_MIN = 3;
export const LISTING_TITLE_MAX = 120;
export const LISTING_COMPANY_MIN = 2;
export const LISTING_COMPANY_MAX = 120;
export const LISTING_DESCRIPTION_MIN = 20;
export const LISTING_DESCRIPTION_MAX = 5000;

/**
 * The names `details.missing[]` of `422 LISTING_INCOMPLETE` uses — the wire (camelCase)
 * names of the content fields, plus `contact` for "no contact field at all".
 */
export const LISTING_REQUIRED_FIELDS = [
  'title', 'companyName', 'categories', 'country', 'city', 'area', 'description', 'contact',
] as const;
export type ListingRequiredField = (typeof LISTING_REQUIRED_FIELDS)[number];
