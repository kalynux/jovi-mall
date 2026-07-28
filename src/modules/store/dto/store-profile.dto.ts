import mongoose from 'mongoose';
import { IStore } from '../models/store.model';
import { StoreConfig } from '../config/store.config';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';

/**
 * Get Store Profile Response DTO
 * 
 * Sanitized store profile for vendor API responses.
 * All fields are safe for public consumption.
 */
export interface GetStoreProfileResponseDto {
  id: string;
  vendorId: string;
  name: string;
  slug: string; // READ-ONLY (immutable in vendor API)
  // Branding as resolved file objects (same shape as product media): the update
  // endpoint accepts `logoFileId`/`bannerFileId`, and reads return the resolved
  // `logo`/`banner` objects (`{ id, key, url, mimeType, size, originalName }`),
  // or null when the slot is unset.
  logo?: FileDetail | null;
  banner?: FileDetail | null;
  description?: string | null;
  /**
   * READ-ONLY, sourced from the vendor profile (set-once at onboarding) — the
   * store stores no country of its own. Null until onboarding Step 1 sets it.
   * Physical locations are the vendor profile's `business_addresses`.
   */
  country: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportWhatsapp?: string | null;
  isOpen: boolean; // Vacation mode
  publicUrl: string; // Computed (not stored)
  version: number; // For optimistic locking
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Update Store Profile Input DTO
 *
 * Fields allowed for vendor updates.
 * slug and country are NOT allowed (immutable).
 *
 * Clearable fields: undefined = leave unchanged, null = clear the field.
 * (The validator normalises '' to null before it reaches this DTO.)
 */
export interface UpdateStoreProfileInputDto {
  name?: string;
  // slug NOT allowed (immutable in vendor API)
  logoFileId?: string | null;
  bannerFileId?: string | null;
  description?: string | null;
  // NO address/city/country: physical locations are the vendor profile's
  // business_addresses; country lives on the vendor profile (set-once).
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportWhatsapp?: string | null;
  version: number; // REQUIRED for optimistic locking
}

/**
 * Update Store Status Input DTO
 * 
 * Toggle vacation mode.
 */
export interface UpdateStoreStatusInputDto {
  isOpen: boolean; // true = open for business, false = on vacation
  version: number; // REQUIRED for optimistic locking
}

/**
 * Store Profile Mapper
 * 
 * Maps between domain model and DTOs.
 * Ensures immutable fields are never updated.
 */
export class StoreProfileMapper {
  /**
   * Map Store domain model to sanitized response DTO
   * 
   * SECURITY: This is the ONLY way store data should be sent to vendors.
   * 
   * @param store - Store domain model
   * @returns Sanitized DTO safe for API responses
   */
  static async toResponseDto(
    store: IStore,
    vendorCountry: string | null,
    fileRepo: FileRepositoryMongo,
    storage: IStorageProvider,
  ): Promise<GetStoreProfileResponseDto> {
    // Resolve both branding slots into FileDetail objects in a single batched
    // query. Missing/deleted files resolve to null (same behaviour as vendor
    // branding — see buildBrandingDetail in vendor-profile.dto.ts).
    const logoFid = store.logo_file_id?.toString();
    const bannerFid = store.banner_file_id?.toString();
    const detailById = await resolveFileDetails([logoFid, bannerFid], fileRepo, storage);

    return {
      id: store._id.toString(),
      vendorId: store.vendor_id.toString(),
      name: store.name,
      slug: store.slug,
      logo: logoFid ? detailById.get(logoFid) ?? null : null,
      banner: bannerFid ? detailById.get(bannerFid) ?? null : null,
      description: store.description,
      country: vendorCountry, // read-only, from the vendor profile
      supportEmail: store.support_email,
      supportPhone: store.support_phone,
      supportWhatsapp: store.support_whatsapp,
      isOpen: store.is_open,
      publicUrl: `${StoreConfig.PUBLIC_URL_BASE}/${encodeURIComponent(store.slug)}`, // URL-safe encoding
      version: store.version,
      createdAt: store.created_at,
      updatedAt: store.updated_at,
    };
  }

  /**
   * Map input DTO to partial domain model for updates
   * 
   * SECURITY: Explicit field mapping prevents mass assignment.
   * slug and country are silently ignored if present (don't leak business rules).
   * 
   * @param input - Update input DTO
   * @returns Partial store object safe for updates
   */
  static toUpdatePayload(input: UpdateStoreProfileInputDto): Partial<IStore> {
    const payload: Partial<IStore> = {};

    if (input.name !== undefined) {
      payload.name = input.name;
    }

    // slug is NEVER mapped (immutable in vendor API)

    if (input.logoFileId !== undefined) {
      payload.logo_file_id = input.logoFileId ? new mongoose.Types.ObjectId(input.logoFileId) : null;
    }

    if (input.bannerFileId !== undefined) {
      payload.banner_file_id = input.bannerFileId ? new mongoose.Types.ObjectId(input.bannerFileId) : null;
    }

    if (input.description !== undefined) {
      payload.description = input.description;
    }

    // country is NEVER mapped (it lives on the vendor profile, set-once)

    if (input.supportEmail !== undefined) {
      payload.support_email = input.supportEmail;
    }

    if (input.supportPhone !== undefined) {
      payload.support_phone = input.supportPhone;
    }

    if (input.supportWhatsapp !== undefined) {
      payload.support_whatsapp = input.supportWhatsapp;
    }

    return payload;
  }
}
