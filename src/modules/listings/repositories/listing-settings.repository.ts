import { ClientSession, Types } from 'mongoose';
import { VendorModel } from '../../vendors/vendor.model';
import { PROVIDER_VENDOR_FILTER } from '../../vendors/domain/vendor-kind';
import { ListingSettings } from '../domain/listing.types';

/**
 * The narrow vendor-document reads and writes the listings module needs — and nothing else.
 *
 * It lives here rather than in the vendors module so a listings change never edits a vendor
 * file. Three operations, each touching only the provider's own `listing_settings` or a
 * projection of `kind` / `status`; it never returns the vendor's email, phone or name.
 */
export interface VendorKindRow {
  _id: Types.ObjectId;
  kind?: string;
  status?: string;
}

export class ListingSettingsRepository {
  /** The stored settings, or `null` when the provider has none yet (callers apply the defaults). */
  async get(vendorId: string): Promise<Partial<ListingSettings> | null> {
    if (!Types.ObjectId.isValid(vendorId)) return null;
    const row = await VendorModel.findById(vendorId, { listing_settings: 1 }).lean<{ listing_settings?: Partial<ListingSettings> | null }>();
    return row?.listing_settings ?? null;
  }

  /**
   * Replace the provider's settings. Scoped to `kind: 'provider'` at the query, so a seller id
   * writes nothing (the route is provider-only already; this is the second lock). Returns
   * whether a row was written.
   */
  async put(vendorId: string, settings: ListingSettings): Promise<boolean> {
    const res = await VendorModel.updateOne(
      { _id: new Types.ObjectId(vendorId), ...PROVIDER_VENDOR_FILTER },
      { $set: { listing_settings: settings } },
      { runValidators: true },
    );
    return res.matchedCount > 0;
  }

  /** Kind + status only — for the funding subscriber's "is this a provider?" check. */
  async kindOf(vendorId: string, session?: ClientSession): Promise<VendorKindRow | null> {
    if (!Types.ObjectId.isValid(vendorId)) return null;
    const query = VendorModel.findById(vendorId, { kind: 1, status: 1 });
    if (session) query.session(session);
    return query.lean<VendorKindRow>();
  }
}

export const listingSettingsRepository = new ListingSettingsRepository();
