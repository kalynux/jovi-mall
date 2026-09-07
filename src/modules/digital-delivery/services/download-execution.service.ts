import { Response } from 'express';
import { Types } from 'mongoose';
import { CustomerDigitalEntitlementModel } from '../models/customer-digital-entitlement.model';
import { DownloadTokenHelper } from '../models/download-token.model';
import { DigitalAssetModel } from '../models/digital-asset.model';
import { FileModel } from '../../catalog/models/file.model';
import { IStorageProvider } from '../../../core/storage/storage-provider.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * DownloadExecutionService - Token validation and file streaming
 *
 * CRITICAL GUARANTEES:
 * - Token consumption is atomic (single-use) via a Lua read-and-delete
 * - Download counter increment uses conditional atomic update with guard
 * - Mathematically impossible to exceed maxDownloads even under extreme concurrency
 * - No MongoDB transactions needed - each operation is self-contained and atomic
 */
export class DownloadExecutionService {
  constructor(private readonly storageProvider: IStorageProvider) { }

  /**
   * Consume a download token and stream the file
   *
   * ATOMIC OPERATIONS:
   * 1. Lua read-and-delete - only one request gets the token (single-use)
   * 2. MongoDB conditional update with $expr guard - prevents over-increment
   *
   * @param token - Download token
   * @param res - Express response object to stream file to
   */
  async consumeToken(token: string, res: Response): Promise<void> {
    // Step 1: Fetch and consume token from Redis (atomic single-use)
    const tokenData = await DownloadTokenHelper.consumeToken(token);

    if (!tokenData) {
      throw createAppError(ERROR_CODES.DIGITAL_TOKEN_INVALID, 400);
    }

    const { entitlementId } = tokenData;

    // Step 2: Load and validate entitlement
    const entitlement = await CustomerDigitalEntitlementModel.findById(entitlementId);

    if (!entitlement) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404);
    }

    if (entitlement.revokedAt) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_REVOKED, 403);
    }

    if (entitlement.expiresAt && entitlement.expiresAt < new Date()) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED, 403);
    }

    // Step 3: Conditional atomic increment (with guard)
    const result = await CustomerDigitalEntitlementModel.updateOne(
      {
        _id: entitlement._id,
        $or: [
          { maxDownloads: null },
          { $expr: { $lt: ['$downloadsUsed', '$maxDownloads'] } },
        ],
      },
      { $inc: { downloadsUsed: 1 } }
    );

    if (result.modifiedCount === 0) {
      throw createAppError(ERROR_CODES.DIGITAL_DOWNLOAD_LIMIT_EXCEEDED, 403);
    }

    // Step 4: Load asset and file
    const asset = await DigitalAssetModel.findById(entitlement.assetId);
    if (!asset) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404, 'Digital asset not found');
    }

    const file = await FileModel.findById(asset.fileId);
    if (!file) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404, 'File not found');
    }

    // Step 5: Stream file to response
    try {
      const stream = await this.storageProvider.getDownloadStream(file.key);

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${asset.originalName}"`);
      res.setHeader('Content-Length', file.size.toString());

      stream.pipe(res);

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Error streaming file');
        }
      });
    } catch (error) {
      console.error('Download execution error:', error);
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to stream file');
    }
  }

  /**
   * Get download statistics for an entitlement
   */
  async getDownloadStats(entitlementId: string) {
    if (!Types.ObjectId.isValid(entitlementId)) {
      throw createAppError(ERROR_CODES.DIGITAL_INVALID_ENTITLEMENT_ID, 400);
    }

    const entitlement = await CustomerDigitalEntitlementModel.findById(entitlementId);

    if (!entitlement) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404);
    }

    return {
      downloadsUsed: entitlement.downloadsUsed,
      maxDownloads: entitlement.maxDownloads,
      downloadsRemaining:
        entitlement.maxDownloads !== null
          ? entitlement.maxDownloads - entitlement.downloadsUsed
          : null,
      expiresAt: entitlement.expiresAt,
      revokedAt: entitlement.revokedAt,
    };
  }
}
