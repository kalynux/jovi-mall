import locations from './locations.json';
import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';

/**
 * Country → region helpers backed by `locations.json`
 * (`countries.<iso2-lowercase>.regions.<regionKey>`).
 *
 * An agency's `coverage_areas` are region **keys** (e.g. `"littoral"`, `"centre"`)
 * and must belong to the agency's registered country — the same country that
 * anchors its headquarters-address geo policy. These helpers are the single place
 * that reads the locations dataset for that check.
 */

interface RegionEntry {
  name: Record<string, string>;
  /**
   * Other spellings geocoders and people use for this region — "Adamawa", "Center",
   * "Extreme North". Matching only; never displayed.
   */
  aliases?: string[];
  cities?: string[];
}
interface CountryEntry {
  name: Record<string, string>;
  regions: Record<string, RegionEntry>;
}
const COUNTRIES = (locations as { countries: Record<string, CountryEntry> }).countries;

/** All valid region keys for an ISO-2 country code (case-insensitive). Empty if unknown. */
export function getRegionKeysForCountry(country: string | null | undefined): string[] {
  if (!country) return [];
  const entry = COUNTRIES[country.toLowerCase()];
  return entry ? Object.keys(entry.regions) : [];
}

/** Whether a region key is a valid region of the given country (case-insensitive). */
export function isRegionInCountry(region: string, country: string | null | undefined): boolean {
  const key = region.trim().toLowerCase();
  return getRegionKeysForCountry(country).includes(key);
}

/**
 * Validate a `coverage_areas` list against a country and return the canonical
 * (lowercase) region keys. Throws `AGENCY_COVERAGE_AREA_INVALID` (400) listing any
 * entries that are not regions of that country. When `country` is not set yet
 * (agency still mid-onboarding without a country), the check is skipped and the
 * trimmed inputs are returned as-is.
 */
export function normalizeCoverageAreasForCountry(
  coverageAreas: string[],
  country: string | null | undefined,
): string[] {
  const trimmed = coverageAreas.map((r) => r.trim());
  if (!country) return trimmed;

  const valid = new Set(getRegionKeysForCountry(country));
  const invalid = trimmed.filter((r) => !valid.has(r.toLowerCase()));
  if (invalid.length > 0) {
    throw createAppError(
      ERROR_CODES.AGENCY_COVERAGE_AREA_INVALID,
      400,
      `Coverage areas must be regions of your registered country (${country.toUpperCase()}).`,
      { invalid, requiredCountry: country.toUpperCase(), allowedRegions: [...valid] },
    );
  }
  return trimmed.map((r) => r.toLowerCase());
}

// ─── Region matching ──────────────────────────────────────────────────────────
//
// Three vocabularies meet whenever a contract's coverage is compared to an
// order's delivery region, and none of them agrees with the others:
//
//   1. `AgentAgencyContract.coverage.regions` — canonical region KEYS since the
//      contract terms gained a picker (`normalizeContractRegions` canonicalises
//      every write against the agency's country). It WAS free text, and rows
//      written before that check still are — "Littoral", "Douala — Littoral" —
//      which is why the read path still goes through the resolver below.
//   2. `AgencyMagazin.coverage_areas` — canonical lowercase region KEYS from
//      locations.json, enforced by normalizeCoverageAreasForCountry above.
//   3. `order.delivery_address.components.region` — whatever the geocoding
//      provider returned: "Littoral", "Région du Littoral", "Extrême-Nord".
//
// Comparing these as raw strings fails on case, on accents and on separators.
// These two helpers are the single place that reconciles them.

/**
 * Fold a region string to a comparable token: lowercase, accent-stripped,
 * separators collapsed to single hyphens.
 *
 * `Extrême-Nord` → `extreme-nord`, `Far North` → `far-north`,
 * `  littoral ` → `littoral`. Pure.
 */
export function normalizeRegionToken(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    // NFD splits "ê" into "e" + combining circumflex; the range then drops the mark.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Filler a region name carries around its actual name. Geocoders say "Centre
 * Region", "Région du Centre", "Région de l'Extrême-Nord", "Littoral Province";
 * the region is the word that is left once these are gone.
 *
 * ⚠ Matching only. Before this existed, "Centre Region" folded to `centre-region`,
 * matched no key and no name, and an agency whose contract covered `centre`
 * could never be offered a delivery in Yaoundé.
 */
const REGION_FILLER_WORDS = new Set([
  'region', 'province', 'state', 'departement', 'department',
  'du', 'de', 'des', 'la', 'le', 'l', 'd', 'of', 'the',
]);

/**
 * The form two spellings of one region share: accent-stripped, filler words
 * dropped, every separator gone. `Région de l'Extrême-Nord` → `extremenord`,
 * `Centre Region` → `centre`, `North-West` and `North West` → `northwest`.
 * Empty when nothing but filler was given. Pure.
 */
export function compactRegionToken(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0 && !REGION_FILLER_WORDS.has(word))
    .join('');
}

/** Every compact spelling that names this region: its key, its localized names, its aliases. */
function regionSpellings(key: string, region: RegionEntry): string[] {
  return [key, ...Object.values(region.name), ...(region.aliases ?? [])].map(compactRegionToken);
}

/** The key of the region in `entry` that `raw` names, or null. */
function findRegionIn(entry: CountryEntry, raw: string | null | undefined): string | null {
  const compact = compactRegionToken(raw);
  if (!compact) return null;
  for (const [key, region] of Object.entries(entry.regions)) {
    if (regionSpellings(key, region).includes(compact)) return key;
  }
  return null;
}

/**
 * Resolve a free-text region to its canonical key, if it names one.
 *
 * Matches the region's key, each of its LOCALIZED names (so the French
 * "Extrême-Nord" and the English "Far North" resolve to the same key) and its
 * aliases, all compared through {@link compactRegionToken} — so "Centre Region",
 * "Région du Centre" and "Center" all resolve to `centre`. Scoped to the given
 * country; when none is known, every country is searched.
 *
 * Returns the normalized token itself when nothing matches, rather than null.
 * That is deliberate: two unrecognised free-text strings should still compare
 * equal to each other if they mean the same thing, and a coverage list full of
 * region names this dataset has never heard of must still work.
 */
export function resolveRegionKey(
  raw: string | null | undefined,
  countryCode?: string | null
): string {
  const token = normalizeRegionToken(raw);
  if (!token) return '';

  const scoped = countryCode ? COUNTRIES[countryCode.toLowerCase()] : undefined;
  if (scoped) return findRegionIn(scoped, raw) ?? token;

  for (const entry of Object.values(COUNTRIES)) {
    const hit = findRegionIn(entry, raw);
    if (hit) return hit;
  }
  return token;
}

/** Whether the locations dataset lists regions for this ISO-2 country. */
export function isKnownCountry(countryCode: string | null | undefined): boolean {
  return !!countryCode && !!COUNTRIES[countryCode.toLowerCase()];
}

/**
 * The region key `raw` names in this country, or null when it names none.
 *
 * Unlike {@link resolveRegionKey}, which falls back to the token so free text can
 * still compare against free text, this answers the strict question an address
 * write asks: is this one of the country's regions?
 */
export function matchCountryRegion(
  raw: string | null | undefined,
  countryCode: string | null | undefined
): string | null {
  const entry = countryCode ? COUNTRIES[countryCode.toLowerCase()] : undefined;
  return entry ? findRegionIn(entry, raw) : null;
}

/**
 * The region key whose city list contains `city`, or null. The fallback when a
 * geocoder returned no region, or one that names nothing: Yaoundé is in `centre`
 * whatever the provider called the region around it.
 */
export function regionKeyForCity(
  city: string | null | undefined,
  countryCode: string | null | undefined
): string | null {
  const entry = countryCode ? COUNTRIES[countryCode.toLowerCase()] : undefined;
  const compact = compactRegionToken(city);
  if (!entry || !compact) return null;
  for (const [key, region] of Object.entries(entry.regions)) {
    if ((region.cities ?? []).some((c) => compactRegionToken(c) === compact)) return key;
  }
  return null;
}

/** A region's display name in `locale`, falling back to English, then to the key. */
export function regionDisplayName(key: string, countryCode: string, locale = 'en'): string {
  const region = COUNTRIES[countryCode.toLowerCase()]?.regions[key];
  return region?.name[locale] ?? region?.name.en ?? key;
}

/** A country's regions as `{ key, name }`, for an error a client can build a picker from. */
export function listCountryRegions(
  countryCode: string | null | undefined
): Array<{ key: string; name: Record<string, string> }> {
  const entry = countryCode ? COUNTRIES[countryCode.toLowerCase()] : undefined;
  return entry ? Object.entries(entry.regions).map(([key, r]) => ({ key, name: r.name })) : [];
}
