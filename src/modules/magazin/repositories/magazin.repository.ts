import { ClientSession } from 'mongoose';
import { AgencyMagazinModel, IAgencyMagazin } from '../models/magazin.model';

/**
 * Magazin Repository
 *
 * Agencies access their magazin by agencyId ONLY (identity flow:
 * token → agency → magazin), mirroring the vendor Store repository.
 * The batch resolvers exist so read-heavy paths (order/shipment timelines,
 * agency browse, admin lists, notifications) can turn a set of agency ids into
 * their business names/logos in ONE query instead of an N+1 per agency.
 */
export class MagazinRepository {
  /** Find magazin by agency id, or null when none exists yet (provisioning path). */
  async findByAgencyIdOrNull(agencyId: string, session?: ClientSession): Promise<IAgencyMagazin | null> {
    const query = AgencyMagazinModel.findOne({ agency_id: agencyId });
    if (session) query.session(session);
    return query.exec();
  }

  /** Update magazin by agency id with optimistic locking. Null on version mismatch. */
  async updateByAgencyId(
    agencyId: string,
    currentVersion: number,
    updates: Partial<IAgencyMagazin>,
  ): Promise<IAgencyMagazin | null> {
    return AgencyMagazinModel.findOneAndUpdate(
      { agency_id: agencyId, version: currentVersion },
      { ...updates, $inc: { version: 1 } },
      { new: true },
    ).exec();
  }

  /** PROVISIONING ONLY — called by MagazinProvisioningService. */
  async create(data: Partial<IAgencyMagazin>): Promise<IAgencyMagazin> {
    const magazin = new AgencyMagazinModel(data);
    return magazin.save();
  }

  /**
   * Batch-resolve agency ids → their business name + logo file id, keyed by
   * agency id string. Agencies without a magazin are simply absent from the map.
   */
  async findNamesByAgencyIds(
    agencyIds: Array<string>,
  ): Promise<Map<string, { name: string; logoFileId: string | null }>> {
    const ids = [...new Set(agencyIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await AgencyMagazinModel.find({ agency_id: { $in: ids } })
      .select('agency_id name logo_file_id')
      .lean()
      .exec();
    return new Map(
      rows.map((r) => [
        r.agency_id.toString(),
        { name: r.name, logoFileId: r.logo_file_id ? r.logo_file_id.toString() : null },
      ]),
    );
  }

  /** Convenience single-id name lookup. Returns null when no magazin exists yet. */
  async findNameByAgencyId(agencyId: string): Promise<string | null> {
    const row = await AgencyMagazinModel.findOne({ agency_id: agencyId }).select('name').lean().exec();
    return row?.name ?? null;
  }

  /**
   * Batch-resolve agency ids → their PRIMARY headquarters address
   * (`headquarters_addresses[0]`), keyed by agency id string. Agencies with no
   * magazin, or a magazin with no HQ address recorded, are absent from the map.
   *
   * Shipment list views need this: an `agency_storage` item is collected from
   * the agency's own HQ, which is resolved live rather than snapshotted onto the
   * order. Resolving it per row via `findByAgencyIdOrNull` would be an N+1.
   */
  async findHqAddressesByAgencyIds(
    agencyIds: Array<string>,
  ): Promise<Map<string, IAgencyMagazin['headquarters_addresses'][number]>> {
    const ids = [...new Set(agencyIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await AgencyMagazinModel.find({ agency_id: { $in: ids } })
      .select('agency_id headquarters_addresses')
      .lean()
      .exec();
    const map = new Map<string, IAgencyMagazin['headquarters_addresses'][number]>();
    for (const row of rows) {
      const hq = row.headquarters_addresses?.[0];
      if (hq) map.set(row.agency_id.toString(), hq);
    }
    return map;
  }
}
