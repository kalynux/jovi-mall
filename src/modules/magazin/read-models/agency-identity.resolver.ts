import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import {
  FileLookup,
  resolveFileDetail,
  resolveFileDetails,
} from '../../catalog/read-models/file-detail.resolver';
import { IStorageProvider } from '../../../core/storage';
import { AgencyIdentityFields } from '../repositories/magazin.repository';

/**
 * Who an agency IS, on the wire — the block any response shows when a caller
 * needs to know which agency is behind a record (a shipment, an offer, a
 * timeline entry) and how to reach it.
 *
 * The business name and logo live on the Magazin, never on the agency account
 * document — see the Magazin model. `logo` is a resolved `FileDetail`, never a
 * bare URL string, exactly like every other referenced file in this API.
 *
 * `name` is `''` and the contacts are `null` only for a magazin that exists but
 * hasn't been filled in; an agency with no magazin at all yields no identity
 * (callers emit `null`).
 */
export interface AgencyIdentity {
  id: string;
  name: string;
  logo: FileDetail | null;
  supportPhone: string | null;
  supportEmail: string | null;
  supportWhatsapp: string | null;
}

/** Map an agency id + its magazin (hydrated doc or lean row) + logo to the wire shape. */
export function toAgencyIdentity(
  agencyId: string,
  magazin: AgencyIdentityFields,
  logo: FileDetail | null,
): AgencyIdentity {
  return {
    id: agencyId,
    name: magazin.name ?? '',
    logo,
    supportPhone: magazin.support_phone ?? null,
    supportEmail: magazin.support_email ?? null,
    supportWhatsapp: magazin.support_whatsapp ?? null,
  };
}

/** The magazin lookup this resolver needs — `MagazinRepository` satisfies it structurally. */
export interface MagazinIdentityLookup {
  findIdentitiesByAgencyIds(agencyIds: Array<string>): Promise<Map<string, AgencyIdentityFields>>;
}

/**
 * Batch-resolve agency ids → `AgencyIdentity`, keyed by agency id. Two queries
 * total (magazins, then their logos) regardless of how many agencies a page
 * spans — an agent's queue routinely mixes several. Agencies with no magazin
 * are omitted, so callers should `?? null`.
 */
export async function resolveAgencyIdentities(
  agencyIds: Array<string>,
  magazinRepo: MagazinIdentityLookup,
  fileRepo: FileLookup,
  storage: IStorageProvider,
): Promise<Map<string, AgencyIdentity>> {
  const magazins = await magazinRepo.findIdentitiesByAgencyIds(agencyIds);
  if (magazins.size === 0) return new Map();

  const logos = await resolveFileDetails(
    [...magazins.values()].map((m) => m.logo_file_id?.toString() ?? null),
    fileRepo,
    storage,
  );

  const result = new Map<string, AgencyIdentity>();
  for (const [agencyId, magazin] of magazins) {
    const fileId = magazin.logo_file_id?.toString();
    result.set(agencyId, toAgencyIdentity(agencyId, magazin, (fileId && logos.get(fileId)) || null));
  }
  return result;
}

/**
 * Single-entity variant for a caller that has ALREADY loaded the magazin (the
 * shipment detail does, for the HQ pickup address) — resolves just the logo so
 * the magazin isn't fetched twice. Returns null when there is no magazin.
 */
export async function resolveAgencyIdentity(
  agencyId: string,
  magazin: AgencyIdentityFields | null,
  fileRepo: FileLookup,
  storage: IStorageProvider,
): Promise<AgencyIdentity | null> {
  if (!magazin) return null;
  const logo = await resolveFileDetail(magazin.logo_file_id?.toString(), fileRepo, storage);
  return toAgencyIdentity(agencyId, magazin, logo);
}
