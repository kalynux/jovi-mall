import { Types } from 'mongoose';
import { DigitalAssetModel } from '../../digital-delivery/models/digital-asset.model';
import { CustomerDigitalEntitlementModel } from '../../digital-delivery/models/customer-digital-entitlement.model';

/**
 * DigitalEntitlementGuard
 *
 * Answers a single question for the cleanup sweep: "does this file back a digital
 * download a customer is still entitled to?" If so, the file must never be
 * detached or deleted — doing so would break a purchase the customer paid for.
 *
 * Mapping: File ← DigitalAsset.fileId ← CustomerDigitalEntitlement.assetId. An
 * entitlement is "live" when it is not soft-deleted, not revoked, not expired,
 * and (for capped grants) still has downloads remaining.
 */
export class DigitalEntitlementGuard {
  /**
   * @returns true if the file is protected (has at least one live entitlement).
   */
  async isProtected(fileId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(fileId)) return false;

    // Which digital assets reference this physical file?
    const assetIds = await DigitalAssetModel.find({
      fileId: new Types.ObjectId(fileId),
      deletedAt: null,
    }).distinct('_id');

    if (assetIds.length === 0) return false;

    const now = new Date();
    const liveEntitlement = await CustomerDigitalEntitlementModel.findOne({
      assetId: { $in: assetIds },
      deletedAt: null,
      revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      $expr: {
        $or: [
          { $eq: ['$maxDownloads', null] },
          { $lt: ['$downloadsUsed', '$maxDownloads'] },
        ],
      },
    })
      .select('_id')
      .lean();

    return !!liveEntitlement;
  }
}
