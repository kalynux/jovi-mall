import { IStorageProvider } from '../../../core/storage';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { StoreRepository } from '../../store/repositories/store.repository';
import { VendorRepository } from '../vendor.repository';

/**
 * A vendor as another party's list row names it — the agency's products, stock-request
 * and storage-statement screens (agency-dash asks, 2026-10-04).
 *
 * `businessName` is the STORE's name (business identity lives on the Store, never the
 * profile) and `''` when the vendor has no store yet — the same rule `GET /agency/vendors`
 * applies, so one vendor never reads as two different strings on two agency screens.
 * `verified` is `kyc_details.legit_verified`, the same field the inventory rows' badge reads.
 * `logo` is a `FileDetail`, like every referenced file on the platform — never a bare URL.
 */
export interface VendorSummary {
  id: string;
  businessName: string;
  displayName: string | null;
  logo: FileDetail | null;
  verified: boolean;
}

/**
 * Batch-resolve vendor ids to `VendorSummary`, keyed by id. Three queries for any page —
 * stores, vendor profiles, logo files — never one per row.
 *
 * Every requested id is present in the result, including ones with no vendor row: a list
 * row must still render, and `businessName: ''` / `verified: false` is the honest reading
 * of a vendor the platform cannot find.
 */
export async function resolveVendorSummaries(
  vendorIds: Array<string>,
  storage: IStorageProvider,
  deps: {
    stores?: StoreRepository;
    vendors?: VendorRepository;
    files?: FileRepositoryMongo;
  } = {},
): Promise<Map<string, VendorSummary>> {
  const ids = [...new Set(vendorIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const stores = deps.stores ?? new StoreRepository();
  const vendors = deps.vendors ?? new VendorRepository();
  const files = deps.files ?? new FileRepositoryMongo();

  const [names, identities] = await Promise.all([
    stores.findNamesByVendorIds(ids),
    vendors.findDisplayIdentities(ids),
  ]);
  const logos = await resolveFileDetails(
    ids.map(id => names.get(id)?.logoFileId ?? null),
    files,
    storage,
  );

  return new Map(ids.map(id => {
    const store = names.get(id);
    const identity = identities.get(id);
    return [id, {
      id,
      businessName: store?.name ?? '',
      displayName: identity?.displayName ?? null,
      logo: store?.logoFileId ? logos.get(store.logoFileId) ?? null : null,
      verified: identity?.verified ?? false,
    }];
  }));
}
