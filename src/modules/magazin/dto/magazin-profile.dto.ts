import mongoose from 'mongoose';
import { IAgencyMagazin, IAgencyHeadquartersAddress } from '../models/magazin.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetail } from '../../catalog/read-models/file-detail.resolver';
import { toGeoAddress } from '../../../core/types/geo-address.types';
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
 */
export function toPersistableHeadquarters(
  entries: MagazinHeadquartersAddressInput[],
): IAgencyHeadquartersAddress[] {
  return entries.map((e) => {
    const geo = e.geo ? toGeoAddress(e.geo) : null;
    const location = geo ? geo.coordinates : (e.location ?? null);
    return {
      label: e.label,
      region: geo?.components.region ?? e.region ?? null,
      city: geo?.components.city ?? e.city ?? null,
      address_description: e.address_description,
      support_contact: { phone: e.support_contact.phone, email: e.support_contact.email ?? null },
      location,
      geo,
    } as unknown as IAgencyHeadquartersAddress;
  });
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
