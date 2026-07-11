import { ClientSession, FilterQuery, Types } from 'mongoose';
import {
  VendorAgencyConnectionModel,
  IVendorAgencyConnection,
  IConnectionStatusHistoryEntry,
  ConnectionStatus,
  ConnectionParty,
} from './connection.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';

export class ConnectionRepository {
  async create(data: Partial<IVendorAgencyConnection>, session?: ClientSession): Promise<IVendorAgencyConnection> {
    const [doc] = await VendorAgencyConnectionModel.create([data], session ? { session } : {});
    return doc;
  }

  async findById(id: string, session?: ClientSession): Promise<IVendorAgencyConnection | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const query = VendorAgencyConnectionModel.findById(id);
    if (session) query.session(session);
    return query.exec();
  }

  async findByVendorAndAgency(
    vendorId: string,
    agencyId: string,
    session?: ClientSession,
  ): Promise<IVendorAgencyConnection | null> {
    const query = VendorAgencyConnectionModel.findOne({ vendor_id: vendorId, agency_id: agencyId });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Left-join input for browse endpoints: connection rows (any status) for a
   * given entity, keyed by the counterparty id, so the caller can annotate a
   * browse list with each row's current connection state.
   */
  async findAllForEntity(
    role: ConnectionParty,
    entityId: string,
    session?: ClientSession,
  ): Promise<IVendorAgencyConnection[]> {
    const filter: FilterQuery<IVendorAgencyConnection> =
      role === 'vendor' ? { vendor_id: entityId } : { agency_id: entityId };
    const query = VendorAgencyConnectionModel.find(filter);
    if (session) query.session(session);
    return query.exec();
  }

  /** The set the policy-change pause hook must touch: everything still "live". */
  async findActiveOrPausedForEntity(
    role: ConnectionParty,
    entityId: string,
    session?: ClientSession,
  ): Promise<IVendorAgencyConnection[]> {
    const filter: FilterQuery<IVendorAgencyConnection> = {
      ...(role === 'vendor' ? { vendor_id: entityId } : { agency_id: entityId }),
      status: { $in: ['active', 'paused_reapproval'] },
    };
    const query = VendorAgencyConnectionModel.find(filter);
    if (session) query.session(session);
    return query.exec();
  }

  async listForVendor(
    vendorId: string,
    filters: { status?: ConnectionStatus },
    pagination: PaginationOptions,
  ): Promise<Page<IVendorAgencyConnection>> {
    const { page, limit } = pagination;
    const filter: FilterQuery<IVendorAgencyConnection> = { vendor_id: vendorId };
    if (filters.status) filter.status = filters.status;

    const [total, docs] = await Promise.all([
      VendorAgencyConnectionModel.countDocuments(filter).exec(),
      VendorAgencyConnectionModel.find(filter)
        .sort({ updated_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  async listForAgency(
    agencyId: string,
    filters: { status?: ConnectionStatus },
    pagination: PaginationOptions,
  ): Promise<Page<IVendorAgencyConnection>> {
    const { page, limit } = pagination;
    const filter: FilterQuery<IVendorAgencyConnection> = { agency_id: agencyId };
    if (filters.status) filter.status = filters.status;

    const [total, docs] = await Promise.all([
      VendorAgencyConnectionModel.countDocuments(filter).exec(),
      VendorAgencyConnectionModel.find(filter)
        .sort({ updated_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Apply an already-validated FSM transition: sets `status` plus any other
   * fields the transition needs, appends a status_history entry, and optionally
   * clears stale fields left over from a previous cycle (e.g. re-requesting after
   * a rejection must clear the old `rejection` object). A single flexible dumb-write
   * — transition validation lives entirely in ConnectionService, mirroring how
   * ShipmentRepository.applyStatusChange/applyRejection stay dumb writes there.
   */
  async applyTransition(
    id: string,
    update: {
      status: ConnectionStatus;
      set?: Partial<IVendorAgencyConnection>;
      unset?: Array<keyof IVendorAgencyConnection>;
      historyEntry: IConnectionStatusHistoryEntry;
    },
    session?: ClientSession,
  ): Promise<IVendorAgencyConnection | null> {
    const setPayload: Record<string, unknown> = { status: update.status, ...(update.set ?? {}) };
    const mongoUpdate: Record<string, unknown> = {
      $set: setPayload,
      $push: { status_history: update.historyEntry },
    };

    if (update.unset && update.unset.length > 0) {
      const unsetPayload: Record<string, ''> = {};
      for (const key of update.unset) unsetPayload[key as string] = '';
      mongoUpdate.$unset = unsetPayload;
    }

    const query = VendorAgencyConnectionModel.findByIdAndUpdate(id, mongoUpdate, { new: true });
    if (session) query.session(session);
    return query.exec();
  }
}
