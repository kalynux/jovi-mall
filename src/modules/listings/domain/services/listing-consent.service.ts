import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { ProviderConsentSource } from '../listing.types';
import { listingLeadRepository, ListingLeadRepository } from '../../repositories/listing-lead.repository';
import {
  providerConsentRepository,
  ProviderConsentRepository,
  ProviderConsentRow,
} from '../../repositories/provider-consent.repository';

/**
 * ProviderConsentService — "may this business message me through Wi-Mall?" (SERVICE-LISTINGS-PLAN
 * L-14, § C-3 Customer).
 *
 * The customer's answer, and only theirs: asked once by the bot after their first reveal from
 * that provider, changeable from their settings (`PUT /api/me/listing-consents/:vendorId`) and
 * from the "Stop messages from this business" button on every relayed message (`lc:<id>:n`).
 * **The default is No.** The messaging builder only reads `isGranted`.
 *
 * A consent can be set only towards a provider the customer has met — a lead with them, or a
 * consent row already (the question was asked). Anything else is `404 LISTING_LEAD_NOT_FOUND`:
 * there is no reason for a stranger's id to gain a row, and the answer must not reveal whether
 * the id is a provider at all.
 */
export type ConsentState = 'granted' | 'not_granted' | 'revoked';

export interface ConsentView {
  vendorId: string;
  businessName: string | null;
  consent: ConsentState;
  granted: boolean;
  askedAt: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
}

type ConsentFields = Pick<ProviderConsentRow, 'granted_at' | 'revoked_at'>;

/** Granted = `granted_at != null && revoked_at == null`; a withdrawal is `revoked`; else the default No. */
export function consentStateOf(row: ConsentFields | null | undefined): ConsentState {
  if (!row || !row.granted_at) return 'not_granted';
  return row.revoked_at ? 'revoked' : 'granted';
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function toConsentView(
  vendorId: string,
  row: (ConsentFields & Pick<ProviderConsentRow, 'asked_at'>) | null,
  businessName: string | null,
): ConsentView {
  const consent = consentStateOf(row);
  return {
    vendorId,
    businessName,
    consent,
    granted: consent === 'granted',
    askedAt: iso(row?.asked_at),
    grantedAt: iso(row?.granted_at),
    revokedAt: iso(row?.revoked_at),
  };
}

export class ProviderConsentService {
  constructor(
    private readonly repo: Pick<
      ProviderConsentRepository,
      'find' | 'listForCustomer' | 'grant' | 'refuse' | 'markAskedIfNew' | 'businessNamesFor'
    > = providerConsentRepository,
    private readonly leads: Pick<ListingLeadRepository, 'existsForVendor'> = listingLeadRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(customerId: string): Promise<ConsentView[]> {
    const rows = await this.repo.listForCustomer(customerId);
    const names = await this.repo.businessNamesFor(rows.map((r) => r.vendor_id.toString()));
    return rows.map((r) => toConsentView(r.vendor_id.toString(), r, names.get(r.vendor_id.toString()) ?? null));
  }

  /** Grant or refuse/withdraw. Refused for a provider the customer has never met (see header). */
  async set(customerId: string, vendorId: string, granted: boolean, source: ProviderConsentSource): Promise<ConsentView> {
    const existing = await this.repo.find(customerId, vendorId);
    if (!existing && !(await this.leads.existsForVendor(customerId, vendorId))) {
      throw createAppError(ERROR_CODES.LISTING_LEAD_NOT_FOUND, 404);
    }
    const now = this.clock();
    if (granted) await this.repo.grant(customerId, vendorId, source, now);
    else await this.repo.refuse(customerId, vendorId, source, now);

    const after = await this.repo.find(customerId, vendorId);
    const names = await this.repo.businessNamesFor([vendorId]);
    return toConsentView(vendorId, after, names.get(vendorId) ?? null);
  }

  /** The messaging builder's question. Default No. */
  async isGranted(customerId: string, vendorId: string): Promise<boolean> {
    return consentStateOf(await this.repo.find(customerId, vendorId)) === 'granted';
  }

  /**
   * The bot is about to ask the opt-in question: `true` exactly once per (customer, provider) —
   * the call that stamps `asked_at`. Any existing row (asked before, or answered on the website)
   * answers `false`, so the question is never asked twice.
   */
  async askOnce(customerId: string, vendorId: string): Promise<boolean> {
    return this.repo.markAskedIfNew(customerId, vendorId, this.clock());
  }
}

export const providerConsentService = new ProviderConsentService();
