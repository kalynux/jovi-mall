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
