import { MagazinRepository } from '../repositories/magazin.repository';
import { IAgencyMagazin } from '../models/magazin.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Magazin Provisioning Service
 *
 * Every delivery agency must have exactly one magazin (its business surface),
 * mirroring StoreProvisioningService for vendors. Single creation path, used
 * from two places:
 *
 * 1. Agency signup / initialization (eager hook in auth + `POST /api/agency`).
 * 2. Get-or-create on first access to any `/api/agency/magazin` endpoint —
 *    which also heals pre-existing agencies that never got a magazin row.
 *
 * The magazin carries no logistics data: coverage/HQ/payout/policies/KYC stay on
 * the agency profile. Unlike the Store, it has no slug (agencies are not a public
 * shopping storefront).
 */
export class MagazinProvisioningService {
  private magazinRepo: MagazinRepository;
  private agencyRepo: DeliveryAgencyRepository;

  constructor() {
    this.magazinRepo = new MagazinRepository();
    this.agencyRepo = new DeliveryAgencyRepository();
  }

  /**
   * Return the agency's magazin, creating it if it does not exist yet.
   *
   * @param agencyId - Agency document id
   * @param seedName - Optional business name to seed a freshly-created magazin
   *   with (from signup / init). Ignored when a magazin already exists.
   *
   * Concurrency-safe: the unique index on `agency_id` makes the create race lose
   * cleanly — on a duplicate-key error the winner's row is re-fetched.
   */
  async ensureMagazinForAgency(agencyId: string, seedName?: string): Promise<IAgencyMagazin> {
    const existing = await this.magazinRepo.findByAgencyIdOrNull(agencyId);
    if (existing) return existing;

    const agency = await this.agencyRepo.findById(agencyId);
    if (!agency) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, 'Delivery agency not found');
    }

    const name = this.deriveMagazinName(seedName, agency.display_name);

    try {
      return await this.magazinRepo.create({
        agency_id: agency._id,
        name,
        version: 0,
      });
    } catch (err) {
      // E11000 duplicate key on agency_id: a concurrent request created it first.
      if (this.isDuplicateKeyError(err)) {
        const winner = await this.magazinRepo.findByAgencyIdOrNull(agencyId);
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** Magazin name: explicit seed, else the agency's display name, else a placeholder (min 2 chars per schema). */
  private deriveMagazinName(seedName: string | undefined, displayName: string | undefined): string {
    const base = (seedName?.trim() || displayName?.trim() || '');
    const name = base.length >= 2 ? base : `${base} Agency`.trim();
    return name.slice(0, 100);
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: number }).code === 11000
    );
  }
}
