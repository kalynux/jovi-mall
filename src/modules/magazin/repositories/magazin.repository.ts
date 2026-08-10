import { ClientSession } from 'mongoose';
import { AgencyMagazinModel, IAgencyMagazin } from '../models/magazin.model';

/**
 * The magazin fields that make up an agency's public identity block — its
 * business name, logo and support contacts. Kept in the persisted (snake_case)
 * spelling so `toAgencyIdentity` accepts a hydrated magazin document and a lean
 * batch row interchangeably.
 */
export type AgencyIdentityFields = Pick<
  IAgencyMagazin,
  'name' | 'logo_file_id' | 'support_phone' | 'support_email' | 'support_whatsapp'
>;

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

  /**
   * Batch-resolve agency ids → their public identity fields (name, logo file id
   * and support contacts), keyed by agency id string. Agencies without a magazin
   * are absent from the map.
   *
   * Wider projection than `findNamesByAgencyIds`, which stays as-is for the
   * name-only paths (timelines, notifications) that shouldn't pay for the rest.
   */
  async findIdentitiesByAgencyIds(agencyIds: Array<string>): Promise<Map<string, AgencyIdentityFields>> {
    const ids = [...new Set(agencyIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await AgencyMagazinModel.find({ agency_id: { $in: ids } })
      .select('agency_id name logo_file_id support_phone support_email support_whatsapp')
      .lean()
      .exec();
    return new Map(
      rows.map((r) => [
        r.agency_id.toString(),
        {
          name: r.name,
          logo_file_id: r.logo_file_id ?? null,
          support_phone: r.support_phone ?? null,
          support_email: r.support_email ?? null,
          support_whatsapp: r.support_whatsapp ?? null,
        },
      ]),
    );
  }

  /**
   * Batch-resolve agency ids → the regions each agency declares it serves,
   * keyed by agency id string. Agencies without a magazin are absent.
   *
   * Its own method rather than a wider projection on `findNamesByAgencyIds`,
   * which every timeline and notification path calls and should not start
   * paying for an array it never reads. This one has a single audience: the
   * agent's contract views, where the coverage picker marks which of the
   * country's regions the agency actually operates in.
   */
  async findCoverageAreasByAgencyIds(agencyIds: Array<string>): Promise<Map<string, string[]>> {
    const ids = [...new Set(agencyIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await AgencyMagazinModel.find({ agency_id: { $in: ids } })
      .select('agency_id coverage_areas')
      .lean()
      .exec();
    return new Map(rows.map((r) => [r.agency_id.toString(), r.coverage_areas ?? []]));
  }

  /** Convenience single-id name lookup. Returns null when no magazin exists yet. */
  async findNameByAgencyId(agencyId: string): Promise<string | null> {
    const row = await AgencyMagazinModel.findOne({ agency_id: agencyId }).select('name').lean().exec();
    return row?.name ?? null;
  }

  /**
   * Batch-resolve agency ids → ALL their headquarters addresses, in stored order
   * (index 0 is the primary), keyed by agency id string. Agencies with no magazin
   * are absent from the map.
   *
   * Shipment list views need this: an `agency_storage` item is collected from one
   * of the agency's own depots, resolved live rather than snapshotted onto the
   * order. Resolving it per row via `findByAgencyIdOrNull` would be an N+1.
   *
   * Returns the whole list, not the primary, because the order item names WHICH
   * depot (`pickup_location.agency_address_id`). Pair it with `resolveHqAddress`
   * / `resolveHqAddressFor` (magazin/domain/hq-address.resolver.ts) — never index
   * into it directly, or the null-means-primary fallback ends up reimplemented
   * per call site. The projection is unchanged: this method always fetched the
   * full array and threw away entries 1..n, so returning them costs nothing.
   */
  /**
   * The ids of one agency's depots, in stored order. `null` when the agency has
   * no magazin at all — distinct from `[]` (a magazin with no depot on file), so
   * a caller can tell "unknown" from "none" even though both currently mean the
   * same thing to `PickupLocationValidationService`.
   *
   * Ids only: the catalog validates that a chosen depot BELONGS to the agency and
   * has no use for the addresses themselves, so this keeps the payload minimal
   * and keeps `IAgencyMagazin` out of the catalog module.
   */
  async findHqAddressIdsByAgencyId(agencyId: string): Promise<string[] | null> {
    const row = await AgencyMagazinModel.findOne({ agency_id: agencyId })
      .select('headquarters_addresses._id')
      .lean()
      .exec();
    if (!row) return null;
    return (row.headquarters_addresses ?? [])
      .map((hq) => hq._id?.toString())
      .filter((id): id is string => !!id);
  }

  async findHqAddressListsByAgencyIds(
    agencyIds: Array<string>,
  ): Promise<Map<string, IAgencyMagazin['headquarters_addresses']>> {
    const ids = [...new Set(agencyIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const rows = await AgencyMagazinModel.find({ agency_id: { $in: ids } })
      .select('agency_id headquarters_addresses')
      .lean()
      .exec();
    const map = new Map<string, IAgencyMagazin['headquarters_addresses']>();
    for (const row of rows) {
      map.set(row.agency_id.toString(), row.headquarters_addresses ?? []);
    }
    return map;
  }
}
