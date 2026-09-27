import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import {
  FileLookup,
  resolveFileDetail,
  resolveFileDetails,
} from '../../catalog/read-models/file-detail.resolver';
import { IStorageProvider } from '../../../core/storage';
import { AgencyIdentityFields, AgencyIdentityRow } from '../repositories/magazin.repository';

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
  /**
   * Is the agency KYC-verified — the delivery agency's `kyc_details.legit_verified === true`
   * (never the deprecated top-level mirror). Read from the agency ACCOUNT, not the magazin,
   * and joined into the same batch query. A platform verdict for a badge, never the KYC
   * documents behind it; `false` covers both "never reviewed" and "refused".
   */
  verified: boolean;
}

/**
 * Map an agency id + its magazin (hydrated doc or lean row) + logo + the agency's KYC
 * verdict to the wire shape. `verified` is explicit because it lives on the agency
 * account, which a magazin document does not carry.
 */
export function toAgencyIdentity(
  agencyId: string,
  magazin: AgencyIdentityFields,
  logo: FileDetail | null,
  verified: boolean,
): AgencyIdentity {
  return {
    id: agencyId,
    name: magazin.name ?? '',
    logo,
    supportPhone: magazin.support_phone ?? null,
    supportEmail: magazin.support_email ?? null,
    supportWhatsapp: magazin.support_whatsapp ?? null,
    verified,
  };
}

/** The magazin lookup this resolver needs — `MagazinRepository` satisfies it structurally. */
export interface MagazinIdentityLookup {
  findIdentitiesByAgencyIds(agencyIds: Array<string>): Promise<Map<string, AgencyIdentityRow>>;
}

/**
 * Batch-resolve agency ids → `AgencyIdentity`, keyed by agency id. Two queries
 * total (magazins with their agency's KYC verdict joined in, then their logos)
 * regardless of how many agencies a page spans — an agent's queue routinely
 * mixes several. Agencies with no magazin
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
    result.set(
      agencyId,
      toAgencyIdentity(agencyId, magazin, (fileId && logos.get(fileId)) || null, magazin.agency_verified === true),
    );
  }
  return result;
}

/**
 * Single-entity variant for a caller that has ALREADY loaded the magazin (the
 * shipment detail does, for the HQ pickup address) — resolves just the logo so
 * the magazin isn't fetched twice. Returns null when there is no magazin.
 *
 * `verified` is the agency's `kyc_details.legit_verified === true`, passed in by the
 * caller, which has the agency document loaded already — no extra query here.
 */
export async function resolveAgencyIdentity(
  agencyId: string,
  magazin: AgencyIdentityFields | null,
  verified: boolean,
  fileRepo: FileLookup,
  storage: IStorageProvider,
): Promise<AgencyIdentity | null> {
  if (!magazin) return null;
  const logo = await resolveFileDetail(magazin.logo_file_id?.toString(), fileRepo, storage);
  return toAgencyIdentity(agencyId, magazin, logo, verified);
}
