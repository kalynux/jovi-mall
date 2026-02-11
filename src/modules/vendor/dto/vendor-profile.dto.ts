import { IVendor } from '../../vendors/vendor.model';

/**
 * Get Vendor Profile Response DTO
 * 
 * Sanitized vendor profile for API responses.
 * Excludes sensitive internal fields.
 */
export interface GetVendorProfileResponseDto {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string;
  phoneVerified: boolean;
  businessName: string;
  displayName?: string;
  notificationPreferences: {
    email: boolean;
    whatsapp: boolean;
    phone: boolean;
  };
  twoFactorEnabled: boolean;
  status: string;
  version: number; // For optimistic locking
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Update Vendor Profile Input DTO
 * 
 * Input for profile updates. Validated by Zod schema.
 */
export interface UpdateVendorProfileInputDto {
  displayName?: string;
  email?: string;
  phone?: string;
  notificationPreferences?: {
    email?: boolean;
    whatsapp?: boolean;
    phone?: boolean;
  };
  version: number; // Required for optimistic locking
}

/**
 * Update Password Input DTO
 */
export interface UpdatePasswordInputDto {
  oldPassword: string;
  newPassword: string;
}

/**
 * Vendor Profile Mapper
 * 
 * Maps between domain model and DTOs.
 * Ensures sensitive fields are never leaked.
 */
export class VendorProfileMapper {
  /**
   * Map Vendor domain model to sanitized response DTO
   * 
   * SECURITY: This is the ONLY way vendor data should be sent to clients.
   * Never send the raw IVendor document.
   * 
   * @param vendor - Vendor domain model
   * @returns Sanitized DTO safe for API responses
   */
  static toResponseDto(vendor: IVendor): GetVendorProfileResponseDto {
    return {
      id: vendor._id.toString(),
      email: vendor.email || '',
      emailVerified: vendor.email_verified,
      phone: vendor.phone || '',
      phoneVerified: vendor.phone_verified,
      businessName: vendor.business_name,
      displayName: vendor.display_name,
      notificationPreferences: {
        email: vendor.notification_preferences.email,
        whatsapp: vendor.notification_preferences.whatsapp,
        phone: vendor.notification_preferences.phone,
      },
      twoFactorEnabled: vendor.two_factor_enabled,
      status: vendor.status,
      version: vendor.version,
      createdAt: vendor.created_at,
      updatedAt: vendor.updated_at,
    };
  }

  /**
   * Map input DTO to partial domain model for updates
   * 
   * SECURITY: Explicit field mapping prevents mass assignment vulnerabilities.
   * Only allowed fields are mapped.
   * 
   * @param input - Update input DTO
   * @returns Partial vendor object safe for updates
   */
  static toUpdatePayload(input: UpdateVendorProfileInputDto): Partial<IVendor> {
    const payload: Partial<IVendor> = {};

    if (input.displayName !== undefined) {
      payload.display_name = input.displayName;
    }

    if (input.email !== undefined) {
      payload.email = input.email;
    }

    if (input.phone !== undefined) {
      payload.phone = input.phone;
    }

    if (input.notificationPreferences) {
      payload.notification_preferences = {
        email:
          input.notificationPreferences.email !== undefined
            ? input.notificationPreferences.email
            : true, // Default if not provided
        whatsapp:
          input.notificationPreferences.whatsapp !== undefined
            ? input.notificationPreferences.whatsapp
            : false,
        phone:
          input.notificationPreferences.phone !== undefined
            ? input.notificationPreferences.phone
            : false,
      };
    }

    return payload;
  }
}
