import mongoose from 'mongoose';
import { IAgencyMagazin } from '../models/magazin.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetail } from '../../catalog/read-models/file-detail.resolver';

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
