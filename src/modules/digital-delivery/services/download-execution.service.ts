import { Response } from 'express';
import { Types } from 'mongoose';
import { CustomerDigitalEntitlementModel } from '../models/customer-digital-entitlement.model';
import { DownloadTokenHelper } from '../models/download-token.model';
import { DigitalAssetModel } from '../models/digital-asset.model';
import { FileModel } from '../../catalog/models/file.model';
import { IStorageProvider } from '../../../core/storage/storage-provider.interface';

/**
 * DownloadExecutionService - Token validation and file streaming
 * 
 * CRITICAL GUARANTEES:
 * - Token consumption via Redis GETDEL is atomic (single-use)
 * - Download counter increment uses conditional atomic update with guard
 * - Mathematically impossible to exceed maxDownloads even under extreme concurrency
 * - No MongoDB transactions needed - each operation is self-contained and atomic
 */
export class DownloadExecutionService {
  constructor(private readonly storageProvider: IStorageProvider) {}

  /**
   * Consume a download token and stream the file
   * 
   * ATOMIC OPERATIONS:
   * 1. Redis GETDEL - only one request gets the token (single-use)
   * 2. MongoDB conditional update with $expr guard - prevents over-increment
   * 
   * @param token - Download token
   * @param res - Express response object to stream file to
   */
  async consumeToken(token: string, res: Response): Promise<void> {
    // Step 1: Fetch and consume token from Redis (atomic single-use)
    const tokenData = await DownloadTokenHelper.consumeToken(token);

    if (!tokenData) {
      throw new Error('Invalid, expired, or already used token');
    }

    const { entitlementId } = tokenData;

    // Step 2: Load and validate entitlement
    const entitlement = await CustomerDigitalEntitlementModel.findById(
      entitlementId
    );

    if (!entitlement) {
      throw new Error('Entitlement not found');
    }

    if (entitlement.revokedAt) {
      throw new Error('Entitlement has been revoked');
    }

    if (entitlement.expiresAt && entitlement.expiresAt < new Date()) {
      throw new Error('Entitlement has expired');
    }

    // Step 3: Conditional atomic increment (with guard)
    // This is the CRITICAL operation that prevents over-increment
    const result = await CustomerDigitalEntitlementModel.updateOne(
      {
        _id: entitlement._id,
        // Guard: only increment if limit not reached
        $or: [
          { maxDownloads: null }, // unlimited
          { $expr: { $lt: ['$downloadsUsed', '$maxDownloads'] } }, // used < max
        ],
      },
      {
        $inc: { downloadsUsed: 1 },
      }
    );

    // If guard prevented update, limit was exceeded
    if (result.modifiedCount === 0) {
      throw new Error('Download limit exceeded');
    }

    // Step 4: Load asset and file
    const asset = await DigitalAssetModel.findById(entitlement.assetId);
    if (!asset) {
      throw new Error('Digital asset not found');
    }

    const file = await FileModel.findById(asset.fileId);
    if (!file) {
      throw new Error('File not found');
    }

    // Step 5: Stream file to response
    try {
      const stream = await this.storageProvider.getDownloadStream(file.key);

      // Set response headers
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asset.originalName}"`
      );
      res.setHeader('Content-Length', file.size.toString());

      // Stream file to client
      stream.pipe(res);

      // Handle stream errors
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error streaming file' });
        }
      });
    } catch (error) {
      console.error('Download execution error:', error);
      throw new Error('Failed to stream file');
    }
  }

  /**
   * Get download statistics for an entitlement (for debugging)
   * @param entitlementId - Entitlement ID
   * @returns Download stats
   */
  async getDownloadStats(entitlementId: string) {
    if (!Types.ObjectId.isValid(entitlementId)) {
      throw new Error('Invalid entitlement ID');
    }

    const entitlement = await CustomerDigitalEntitlementModel.findById(
      entitlementId
    );

    if (!entitlement) {
      throw new Error('Entitlement not found');
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
