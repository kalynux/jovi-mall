import { IStore } from '../models/store.model';
import { StoreConfig } from '../config/store.config';

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
  logoUrl?: string;
  bannerUrl?: string;
  description?: string;
  address?: string;
  city?: string;
  country: string; // READ-ONLY (immutable)
  supportEmail?: string;
  supportPhone?: string;
  supportWhatsapp?: string;
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
 */
export interface UpdateStoreProfileInputDto {
  name?: string;
  // slug NOT allowed (immutable in vendor API)
  logoUrl?: string;
  bannerUrl?: string;
  description?: string;
  address?: string;
  city?: string;
  // country NOT allowed (immutable)
  supportEmail?: string;
  supportPhone?: string;
  supportWhatsapp?: string;
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
  static toResponseDto(store: IStore): GetStoreProfileResponseDto {
    return {
      id: store._id.toString(),
      vendorId: store.vendor_id.toString(),
      name: store.name,
      slug: store.slug,
      logoUrl: store.logo_url,
      bannerUrl: store.banner_url,
      description: store.description,
      address: store.address,
      city: store.city,
      country: store.country,
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
    
    if (input.logoUrl !== undefined) {
      payload.logo_url = input.logoUrl;
    }

    if (input.bannerUrl !== undefined) {
      payload.banner_url = input.bannerUrl;
    }

    if (input.description !== undefined) {
      payload.description = input.description;
    }

    if (input.address !== undefined) {
      payload.address = input.address;
    }

    if (input.city !== undefined) {
      payload.city = input.city;
    }

    // country is NEVER mapped (immutable)

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
