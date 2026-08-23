import mongoose from 'mongoose';
import { IAgencyMagazin, IAgencyHeadquartersAddress } from '../models/magazin.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetail } from '../../catalog/read-models/file-detail.resolver';
import { toGeoAddress } from '../../../core/types/geo-address.types';
import { geoAddressEquals } from '../../../core/validation/address-country.helper';
import { MagazinHeadquartersAddressInput } from '../validators/magazin.validator';

/**
 * Normalise validated HQ input entries into their persistence shape: normalise
 * `geo` (assign resolved_at, null-fill components) and DERIVE the legacy
 * `location` GeoPoint from `geo.coordinates` so downstream readers (the
 * auto-assignment distance factor) keep working while clients send only `geo`.
 *
 * `region` and `city` are derived the same way, from `geo.components` — the
 * selected map result is the source of truth for where a place is. A value the
 * client sent is used only as a fallback for what the geocode omits (Nominatim
 * resolves no city for many rural/landmark results), never as an override, so a
 * stale typed city can't contradict the pin. Both stay null when neither source
 * has one; nothing downstream requires them.
 *
 * ## `_id` continuity
 *
 * The write is a whole-array `$set`, so Mongoose casts every element afresh and
 * applies the auto-`ObjectId` default to any plain object arriving without one.
 * That used to re-mint every depot's `_id` on every save — harmless while nothing
 * referenced them, fatal now that a product's `delivery.pickup_location
 * .agency_address_id` points at one. Two mechanisms keep an `_id` alive, in order:
 *
 * 1. **The client echoes `id`** (the contract). Authoritative, and the only thing
 *    that survives an agency editing a depot's address text.
 * 2. **Content match against `previous`** (the safety net). An entry with no `id`
 *    whose `address_description` and geocoded place both match an existing entry
 *    inherits its `_id`. This is what protects an agency whose dashboard has not
 *    shipped the echo yet — the same "unchanged is content-based" predicate
 *    `assertHeadquartersInCountry` already trusts.
 *
 * The content match CONSUMES each previous entry at most once. Two depots at the
 * same address would otherwise collapse onto a single `_id`, which is precisely
 * the ambiguity the duplicate-id validator guard exists to prevent.
 *
 * Anything that matches neither is genuinely new and is left `_id`-less for
 * Mongoose to mint.
 */
export function toPersistableHeadquarters(
  entries: MagazinHeadquartersAddressInput[],
  previous: IAgencyHeadquartersAddress[] = [],
): IAgencyHeadquartersAddress[] {
  // Entries claimed by an explicit `id` are off the table for content matching —
  // otherwise entry A's echoed id could also be inherited by an id-less entry B.
  const claimed = new Set(entries.map((e) => e.id).filter((id): id is string => !!id));
  const availableForContentMatch = previous.filter((p) => !claimed.has(p._id?.toString()));

  return entries.map((e) => {
    const geo = e.geo ? toGeoAddress(e.geo) : null;
    // ⚠ `undefined`, never `null`. `headquarters_addresses` is 2dsphere-indexed on
    // this leaf, and MongoDB extracts keys for the WHOLE array — one stored null
    // beside one real point refuses every subsequent write to the magazin, not just
    // the one that touched the address. An absent key indexes fine. See
    // `GeoPointSchema`; the key is dropped from the persisted entry below.
    const location = geo ? geo.coordinates : (e.location ?? undefined);

    let id: mongoose.Types.ObjectId | undefined = e.id ? new mongoose.Types.ObjectId(e.id) : undefined;
    if (!id) {
      const matchIndex = availableForContentMatch.findIndex(
        (p) => p.address_description === e.address_description && geoAddressEquals(e.geo, p.geo),
      );
      if (matchIndex !== -1) {
        // Consume it, so a second identical entry cannot claim the same `_id`.
        const [match] = availableForContentMatch.splice(matchIndex, 1);
        id = match._id;
      }
    }

    return {
      // Absent for a genuinely new location — Mongoose mints one.
      ...(id ? { _id: id } : {}),
      label: e.label,
      region: geo?.components.region ?? e.region ?? null,
      city: geo?.components.city ?? e.city ?? null,
      address_description: e.address_description,
      support_contact: { phone: e.support_contact.phone, email: e.support_contact.email ?? null },
      // Spread-or-omit rather than `location,` — an explicit `location: undefined`
      // is still a key Mongoose would cast, and the point is to not have one.
      ...(location ? { location } : {}),
      geo,
    } as unknown as IAgencyHeadquartersAddress;
  });
}

/**
 * The ids an incoming HQ array claims that do NOT exist on the magazin being
 * written. A non-empty result means the client is working from a stale (or
 * fabricated) view of the list — the same situation an optimistic-lock miss
 * describes, so callers answer it the same way.
 */
export function findUnknownHeadquartersIds(
  entries: MagazinHeadquartersAddressInput[],
  previous: IAgencyHeadquartersAddress[] = [],
): Array<{ index: number; id: string }> {
  const known = new Set(previous.map((p) => p._id?.toString()).filter((id): id is string => !!id));
  return entries
    .map((e, index) => ({ index, id: e.id ?? null }))
    .filter((e): e is { index: number; id: string } => !!e.id && !known.has(e.id));
}

/**
 * Get Magazin Profile Response DTO
 *
 * Sanitized agency-business surface for agency API responses. Mirrors the vendor
 * Store profile DTO (minus slug/country/vacation, which don't apply to agencies).
 */
export interface GetMagazinProfileResponseDto {
  id: string;
  agencyId: string;
  name: string;
  // Logo as a resolved file object (same shape as product media), or null.
  // The update endpoint accepts `logoFileId`; reads return this object.
  logo?: FileDetail | null;
  description?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportWhatsapp?: string | null;
  /** Regions the agency serves (region keys of its country). */
  coverageAreas: string[];
  /** Physical / pickup locations; index 0 is the primary headquarters. */
  headquartersAddresses: IAgencyHeadquartersAddress[];
  version: number; // For optimistic locking
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Update Magazin Profile Input DTO
 *
 * Clearable fields: undefined = leave unchanged, null = clear the field.
 * (The validator normalises '' to null before it reaches this DTO.)
 */
export interface UpdateMagazinProfileInputDto {
  name?: string;
  logoFileId?: string | null;
  description?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportWhatsapp?: string | null;
  // Coverage/HQ are validated against the agency's country in the service layer.
  coverage_areas?: string[];
  headquarters_addresses?: MagazinHeadquartersAddressInput[];
  version: number; // REQUIRED for optimistic locking
}

export class MagazinProfileMapper {
  static async toResponseDto(
    magazin: IAgencyMagazin,
    fileRepo: FileRepositoryMongo,
    storage: IStorageProvider,
  ): Promise<GetMagazinProfileResponseDto> {
    return {
      id: magazin._id.toString(),
      agencyId: magazin.agency_id.toString(),
      name: magazin.name,
      logo: await resolveFileDetail(magazin.logo_file_id?.toString(), fileRepo, storage),
      description: magazin.description ?? null,
      supportEmail: magazin.support_email ?? null,
      supportPhone: magazin.support_phone ?? null,
      supportWhatsapp: magazin.support_whatsapp ?? null,
      coverageAreas: magazin.coverage_areas ?? [],
      headquartersAddresses: magazin.headquarters_addresses ?? [],
      version: magazin.version,
      createdAt: magazin.created_at,
      updatedAt: magazin.updated_at,
    };
  }

  /**
   * Map input DTO to a partial domain model for updates.
   * SECURITY: explicit field mapping prevents mass assignment.
   */
  static toUpdatePayload(input: UpdateMagazinProfileInputDto): Partial<IAgencyMagazin> {
    const payload: Partial<IAgencyMagazin> = {};

    if (input.name !== undefined) payload.name = input.name;
    if (input.logoFileId !== undefined) {
      payload.logo_file_id = input.logoFileId ? new mongoose.Types.ObjectId(input.logoFileId) : null;
    }
    if (input.description !== undefined) payload.description = input.description;
    if (input.supportEmail !== undefined) payload.support_email = input.supportEmail;
    if (input.supportPhone !== undefined) payload.support_phone = input.supportPhone;
    if (input.supportWhatsapp !== undefined) payload.support_whatsapp = input.supportWhatsapp;

    return payload;
  }
}
