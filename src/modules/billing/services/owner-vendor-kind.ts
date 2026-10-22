import { ClientSession, Types } from 'mongoose';
import { VendorModel } from '../../vendors/vendor.model';
import { VendorKind, vendorKindOf } from '../../vendors/domain/vendor-kind';
import { BillingOwnerType } from '../billing.types';

/**
 * The vendor KIND of a billing owner (SERVICE-LISTINGS-PLAN § C-5): `'seller'` / `'provider'`
 * for a vendor, `null` for an agency or agent.
 *
 * Read on the paths where billing acts for an owner it has only an id for — the lazy free tier,
 * the downgrade at expiry, an administrator's assignment — so the free plan and the plan
 * refusal follow the vendor's kind. A vendor row that cannot be found reads as a seller, as a
 * vendor with no `kind` does (`vendorKindOf`): the same answer every pre-2026-10-19 vendor gets.
 *
 * One indexed `_id` read of one field. It runs on plan TRANSITIONS only, never on the
 * entitlement read every request makes.
 */
export async function resolveOwnerVendorKind(
  ownerType: BillingOwnerType,
  ownerId: string,
  session?: ClientSession,
): Promise<VendorKind | null> {
  if (ownerType !== 'vendor') return null;
  if (!Types.ObjectId.isValid(ownerId)) return 'seller';
  const row = await VendorModel.findById(ownerId)
    .select('kind')
    .session(session ?? null)
    .lean<{ kind?: unknown }>()
    .exec();
  return vendorKindOf(row);
}

/** The resolver's signature, so services can take it as an injectable dependency. */
export type OwnerVendorKindResolver = (
  ownerType: BillingOwnerType,
  ownerId: string,
  session?: ClientSession,
) => Promise<VendorKind | null>;
