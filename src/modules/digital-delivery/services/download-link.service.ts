import { Types } from 'mongoose';
import { CustomerDigitalEntitlementModel } from '../models/customer-digital-entitlement.model';
import { DownloadTokenHelper } from '../models/download-token.model';
import { CreateDownloadLinkDto, DownloadLinkResult } from '../types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * DownloadLinkService - Generate secure download links
 * 
 * Creates short-lived (15 min), single-use download tokens stored in Redis.
 * All validation happens server-side before token generation.
 */
export class DownloadLinkService {
  /**
   * Create a secure download link for an entitlement
   * 
   * Validates entitlement status before generating token.
   * Token is stored in Redis with 15-minute TTL.
   * 
   * @param dto - Download link request
   * @returns Download link with expiry and remaining downloads
   */
  async createDownloadLink(
    dto: CreateDownloadLinkDto
  ): Promise<DownloadLinkResult> {
    if (!Types.ObjectId.isValid(dto.entitlementId)) {
      throw createAppError(ERROR_CODES.DIGITAL_INVALID_ENTITLEMENT_ID, 400);
    }

    // Load entitlement
    const entitlement = await CustomerDigitalEntitlementModel.findById(
      dto.entitlementId
    );

    if (!entitlement) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404);
    }

    // Verify ownership
    if (entitlement.customerId.toString() !== dto.customerId) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_UNAUTHORIZED, 403);
    }

    // Validation: Check not revoked
    if (entitlement.revokedAt !== null) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_REVOKED, 403);
    }

    // Validation: Check not expired
    const now = new Date();
    if (entitlement.expiresAt !== null && entitlement.expiresAt < now) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED, 403);
    }

    // Validation: Check downloads available
    if (
      entitlement.maxDownloads !== null &&
      entitlement.downloadsUsed >= entitlement.maxDownloads
    ) {
      throw createAppError(ERROR_CODES.DIGITAL_DOWNLOAD_LIMIT_EXCEEDED, 403);
    }

    // Generate secure token and store in Redis
    const token = await DownloadTokenHelper.createToken(dto.entitlementId);

    // Calculate expiry (15 minutes from now)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Calculate downloads remaining
    const downloadsRemaining =
      entitlement.maxDownloads !== null
        ? entitlement.maxDownloads - entitlement.downloadsUsed
        : null;

    return {
      url: `/api/digital/download/${token}`,
      expiresAt,
      downloadsRemaining,
    };
  }
}
