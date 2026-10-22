import { Types } from 'mongoose';
import { ListingModel } from '../../listings/models/listing.model';
import type { ListingStatus, ListingSuspensionReason } from '../../listings/domain/listing.types';
import {
  LISTING_QUOTA_REASON,
  LISTING_QUOTA_SUSPENDABLE,
  LISTING_SLOT_STATUSES,
  ListingRestoreTarget,
  ListingSlot,
} from '../domain/listing-quota';

/**
 * The plan quota's reads and writes on `listings` (SERVICE-LISTINGS-PLAN O-16).
 *
 * Here rather than in the listings module, for the reason products' quota primitives sit on the
 * product repository but the SWEEP sits in plan-quota: nothing imports plan-quota except
 * `lifecycle.ts`, so this module may reach into listings without closing a cycle. It touches
 * `listings` only — never `listing_contacts` — and only ever writes its OWN suspension reason.
 *
 * Every write is a compare-and-set on the state the sweep read, so a listing archived, approved
 * or suspended by someone else between the read and the write is left alone and not reported.
 */
export class ListingQuotaRepository {
  /**
   * Every listing competing for a slot, OLDEST FIRST with an `_id` tie-break — the ordering the
   * products sweep uses, for its reason: a bulk create lands rows in one millisecond, and an
   * unstable sort would move the cut-off between runs. Uses `listing_vendor_status_created`.
   */
  async listSlotsOldestFirst(vendorId: string): Promise<ListingSlot[]> {
    if (!Types.ObjectId.isValid(vendorId)) return [];
    const docs = await ListingModel.find(
      { vendor_id: new Types.ObjectId(vendorId), status: { $in: [...LISTING_SLOT_STATUSES] } },
      { status: 1, created_at: 1, 'suspension.reason': 1 },
    )
      .sort({ created_at: 1, _id: 1 })
      .lean()
      .exec();
    return (docs as Array<{ _id: Types.ObjectId; status: ListingStatus; suspension?: { reason?: ListingSuspensionReason } | null }>)
      .map((d) => ({
        id: d._id.toString(),
        status: d.status,
        suspensionReason: d.suspension?.reason ?? null,
      }));
  }

  /**
   * Suspend these listings `plan_quota_exceeded`, capturing each one's OWN status.
   *
   * ⚠ A pipeline update, so `previous_status: '$status'` is the field's value rather than the
   * literal string — the trap `verify:plan-quota` pins for products. Only `live` /
   * `pending_review` listings move; anything already suspended (another reason) or archived in
   * the meantime is filtered out. Returns the ids that really moved (re-read, not modifiedCount).
   */
  async suspendForQuota(vendorId: string, ids: string[]): Promise<string[]> {
    const objectIds = ids.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (objectIds.length === 0) return [];
    await ListingModel.updateMany(
      {
        _id: { $in: objectIds },
        vendor_id: new Types.ObjectId(vendorId),
        status: { $in: [...LISTING_QUOTA_SUSPENDABLE] },
      },
      [
        {
          $set: {
            suspension: {
              reason: LISTING_QUOTA_REASON,
              previous_status: '$status',
              at: '$$NOW',
              note: null,
              by_user_id: null,
              by_source: 'platform',
              by_name: null,
            },
            status: 'suspended',
            updated_at: '$$NOW',
          },
        },
      ] as never,
    ).exec();

    const moved = await ListingModel.find(
      { _id: { $in: objectIds }, status: 'suspended', 'suspension.reason': LISTING_QUOTA_REASON },
      { _id: 1 },
    ).lean().exec();
    return (moved as Array<{ _id: Types.ObjectId }>).map((d) => d._id.toString());
  }

  /** The `previous_status` of a quota-suspended listing, or `null` if it is no longer one. */
  async findQuotaSuspendedPrevious(vendorId: string, id: string): Promise<ListingStatus | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await ListingModel.findOne(
      { _id: id, vendor_id: new Types.ObjectId(vendorId), status: 'suspended', 'suspension.reason': LISTING_QUOTA_REASON },
      { 'suspension.previous_status': 1 },
    ).lean().exec();
    return ((doc as { suspension?: { previous_status?: ListingStatus } } | null)?.suspension?.previous_status) ?? null;
  }

  /**
   * Lift ONE quota suspension, to the target the pure rule chose. A compare-and-set on the
   * quota reason, so a listing whose suspension changed meanwhile is untouched (returns false).
   */
  async restoreFromQuota(vendorId: string, id: string, target: ListingRestoreTarget): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const now = new Date();
    const suspension = target.suspension
      ? {
          reason: target.suspension.reason,
          previous_status: target.suspension.previous_status,
          at: now,
          note: null,
          by_user_id: null,
          by_source: 'platform',
          by_name: null,
        }
      : null;
    const result = await ListingModel.updateOne(
      { _id: id, vendor_id: new Types.ObjectId(vendorId), status: 'suspended', 'suspension.reason': LISTING_QUOTA_REASON },
      { $set: { status: target.status, suspension, updated_at: now } },
    ).exec();
    return result.modifiedCount > 0;
  }

  /** Vendors currently holding at least one listing back for the quota — the sweep's second set. */
  async vendorsHoldingQuotaSuspensions(): Promise<string[]> {
    const ids = await ListingModel.distinct('vendor_id', {
      status: 'suspended',
      'suspension.reason': LISTING_QUOTA_REASON,
    });
    return (ids as Types.ObjectId[]).map((id) => id.toString());
  }
}

export const listingQuotaRepository = new ListingQuotaRepository();
