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
 * Resolve a free-text region to its canonical key, if it names one.
 *
 * Tries, in order: the normalized token as a key of the given country; the
 * token against each of that country's LOCALIZED names (so the French
 * "Extrême-Nord" and the English "Far North" resolve to the same key); then,
 * when no country is known, the same two passes across every country.
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

  const searchIn = (entry: CountryEntry): string | null => {
    for (const [key, region] of Object.entries(entry.regions)) {
      if (normalizeRegionToken(key) === token) return key;
      for (const localized of Object.values(region.name)) {
        if (normalizeRegionToken(localized) === token) return key;
      }
    }
    return null;
  };

  const scoped = countryCode ? COUNTRIES[countryCode.toLowerCase()] : undefined;
  if (scoped) return searchIn(scoped) ?? token;

  for (const entry of Object.values(COUNTRIES)) {
    const hit = searchIn(entry);
    if (hit) return hit;
  }
  return token;
}
