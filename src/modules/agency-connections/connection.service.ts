import { ClientSession, Types } from 'mongoose';
import { ConnectionRepository } from './connection.repository';
import { VendorRepository, VendorListQueryParams } from '../vendors/vendor.repository';
import { DeliveryAgencyRepository, AgencyListQueryParams } from '../delivery/delivery-agency.repository';
import { ProductRepositoryMongo } from '../catalog/repositories/mongo/product.repository.mongo';
import { ProductDeliveryAgencySuspensionService } from '../catalog/domain/services/ProductDeliveryAgencySuspensionService';
import { FileRepositoryMongo } from '../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider, IStorageProvider } from '../../core/storage';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { transactionManager, TransactionManager } from '../../core/database/transaction.manager';
import { auditLogger } from '../../core/audit/audit-logger';
import { eventBus } from '../../core/events/event-bus';
import { PaginationOptions } from '../../core/repositories/base.repository';
import { VendorAgencyListItemDto, VendorAgencyMapper, AgencyListMeta } from '../vendor/dto/vendor-agency.dto';
import { AgencyVendorListItemDto, AgencyVendorMapper } from './dto/agency-vendor-browse.dto';
import {
  IVendorAgencyConnection,
  IConnectionStatusHistoryEntry,
  ConnectionParty,
  ConnectionStatus,
} from './connection.model';

const CONNECTION_PAUSED_REASON = 'agency_connection_paused' as const;

function opposite(role: ConnectionParty): ConnectionParty {
  return role === 'vendor' ? 'agency' : 'vendor';
}

/**
 * FSM + orchestration for vendor<->agency connections. See connection.model.ts
 * for the status enum and the plan's state-transition table:
 *   (none) -> pending -> active/rejected/withdrawn
 *   active <-> paused_reapproval (system-driven, on policy change)
 *   active/paused_reapproval -> terminated
 *   rejected/withdrawn/terminated -> pending (re-request reuses the same doc)
 */
export class ConnectionService {
  private connectionRepo: ConnectionRepository;
  private vendorRepo: VendorRepository;
  private agencyRepo: DeliveryAgencyRepository;
  private productRepo: ProductRepositoryMongo;
  private suspensionService: ProductDeliveryAgencySuspensionService;
  private txManager: TransactionManager;
  private fileRepository: FileRepositoryMongo;
  private storageProvider: IStorageProvider;

  constructor() {
    this.connectionRepo = new ConnectionRepository();
    this.vendorRepo = new VendorRepository();
    this.agencyRepo = new DeliveryAgencyRepository();
    this.productRepo = new ProductRepositoryMongo();
    this.suspensionService = new ProductDeliveryAgencySuspensionService();
    this.txManager = transactionManager;
    this.fileRepository = new FileRepositoryMongo();
    this.storageProvider = getStorageProvider();
  }

  // ─── Ownership / lookup helpers ─────────────────────────────────────────────

  /** Loads a connection scoped to the caller — 404s rather than leaking the existence of another party's connection. */
  private async getOwned(
    connectionId: string,
    actorRole: ConnectionParty,
    actorEntityId: string,
  ): Promise<IVendorAgencyConnection> {
    const connection = await this.connectionRepo.findById(connectionId);
    if (!connection) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);
    const ownerId = actorRole === 'vendor' ? connection.vendor_id : connection.agency_id;
    if (ownerId.toString() !== actorEntityId) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);
    return connection;
  }

  /**
   * Publish a vendor-facing notification event for a connection lifecycle change.
   * Agency-facing notifications don't exist yet (see plan §8) — only fired when
   * the vendor is the one who needs to know (the agency was the actor).
   */
  private async notifyVendor(
    situation: 'connection.request_received' | 'connection.approved' | 'connection.rejected' | 'connection.reapproval_needed',
    connectionId: string,
    vendorId: string,
    agencyName: string,
  ): Promise<void> {
    await eventBus.publish(situation, {
      eventType: situation,
      aggregateId: connectionId,
      payload: { connectionId, vendorId, agencyName },
      occurredAt: new Date(),
    });
  }

  private historyEntry(
    status: ConnectionStatus,
    changedByRole: ConnectionParty | 'system',
    changedByUserId: string | null,
    note?: string,
  ): IConnectionStatusHistoryEntry {
    return {
      status,
      changed_at: new Date(),
      changed_by_role: changedByRole,
      changed_by_user_id: changedByUserId ? new Types.ObjectId(changedByUserId) : null,
      note: note ?? null,
    };
  }

  // ─── Request / re-request ───────────────────────────────────────────────────

  async request(
    actorRole: ConnectionParty,
    actorEntityId: string,
    actorUserId: string,
    counterpartyId: string,
  ): Promise<IVendorAgencyConnection> {
    const vendorId = actorRole === 'vendor' ? actorEntityId : counterpartyId;
    const agencyId = actorRole === 'agency' ? actorEntityId : counterpartyId;

    const [vendor, agency] = await Promise.all([
      this.vendorRepo.findById(vendorId),
      this.agencyRepo.findById(agencyId),
    ]);
    if (!vendor) throw createAppError(ERROR_CODES.CONNECTION_VENDOR_NOT_FOUND, 404);
    if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

    const existing = await this.connectionRepo.findByVendorAndAgency(vendorId, agencyId);
    const now = new Date();

    let result: IVendorAgencyConnection;

    if (!existing) {
      result = await this.connectionRepo.create({
        vendor_id: new Types.ObjectId(vendorId),
        agency_id: new Types.ObjectId(agencyId),
        status: 'pending',
        requester_role: actorRole,
        requested_by_user_id: new Types.ObjectId(actorUserId),
        requested_at: now,
        responded_by_user_id: null,
        responded_at: null,
        vendor_policy_version_at_approval: null,
        agency_policy_version_at_approval: null,
        reapproval_required_from: null,
        paused_at: null,
        paused_reason: null,
        rejection: null,
        withdrawal: null,
        termination: null,
        status_history: [this.historyEntry('pending', actorRole, actorUserId)],
      } as Partial<IVendorAgencyConnection>);
    } else {
      if (existing.status === 'pending' || existing.status === 'active' || existing.status === 'paused_reapproval') {
        throw createAppError(ERROR_CODES.CONNECTION_ALREADY_EXISTS, 409);
      }

      // rejected / withdrawn / terminated -> re-send by resetting the SAME document
      // (required by the unique (vendor_id, agency_id) index).
      const updated = await this.connectionRepo.applyTransition(existing._id.toString(), {
        status: 'pending',
        set: {
          requester_role: actorRole,
          requested_by_user_id: new Types.ObjectId(actorUserId),
          requested_at: now,
          responded_by_user_id: null,
          responded_at: null,
        },
        unset: ['rejection', 'withdrawal', 'termination', 'reapproval_required_from', 'paused_at', 'paused_reason'],
        historyEntry: this.historyEntry('pending', actorRole, actorUserId, 're-requested'),
      });
      if (!updated) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);
      result = updated;
    }

    if (actorRole === 'agency') {
      await this.notifyVendor('connection.request_received', result._id.toString(), vendorId, agency.agency_name);
    }

    return result;
  }

  // ─── Approve (dispatches on current status: pending->active or paused_reapproval->active) ───

  async approve(
    actorRole: ConnectionParty,
    actorEntityId: string,
    actorUserId: string,
    connectionId: string,
  ): Promise<IVendorAgencyConnection> {
    const connection = await this.getOwned(connectionId, actorRole, actorEntityId);

    if (connection.status === 'pending') {
      if (actorRole === connection.requester_role) {
        throw createAppError(ERROR_CODES.CONNECTION_NOT_APPROVER, 403);
      }
      return this.finalizeApproval(connection, actorRole, actorUserId, false);
    }

    if (connection.status === 'paused_reapproval') {
      if (actorRole !== connection.reapproval_required_from) {
        throw createAppError(ERROR_CODES.CONNECTION_WRONG_REAPPROVAL_PARTY, 403);
      }
      return this.finalizeApproval(connection, actorRole, actorUserId, true);
    }

    throw createAppError(ERROR_CODES.CONNECTION_INVALID_STATUS_TRANSITION, 400, undefined, {
      from: connection.status,
      to: 'active',
    });
  }

  private async finalizeApproval(
    connection: IVendorAgencyConnection,
    actorRole: ConnectionParty,
    actorUserId: string,
    isReapproval: boolean,
  ): Promise<IVendorAgencyConnection> {
    const vendorId = connection.vendor_id.toString();
    const agencyId = connection.agency_id.toString();

    return this.txManager.runInTransaction(async (session) => {
      // Re-fetch current policy versions fresh (not from a stale snapshot) so
      // interleaved edits from both sides resolve correctly — see connection.model.ts.
      const [vendor, agency] = await Promise.all([
        this.vendorRepo.findById(vendorId),
        this.agencyRepo.findById(agencyId),
      ]);
      if (!vendor) throw createAppError(ERROR_CODES.CONNECTION_VENDOR_NOT_FOUND, 404);
      if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);

      const updated = await this.connectionRepo.applyTransition(
        connection._id.toString(),
        {
          status: 'active',
          set: {
            responded_by_user_id: new Types.ObjectId(actorUserId),
            responded_at: new Date(),
            vendor_policy_version_at_approval: vendor.policy_version,
            agency_policy_version_at_approval: agency.policy_version,
          },
          unset: ['reapproval_required_from', 'paused_at', 'paused_reason'],
          historyEntry: this.historyEntry('active', actorRole, actorUserId, isReapproval ? 'reapproved' : 'approved'),
        },
        session,
      );
      if (!updated) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);

      if (isReapproval) {
        await this.restoreForConnection(vendorId, agencyId, session);
      }

      // First-ever approved connection for this vendor becomes their default —
      // a reapproval can never be "first" (this same rule already resolved the
      // default the first time this connection went active), so no products
      // could be suspended for a default-agency reason yet — nothing to restore.
      if (!isReapproval && !vendor.default_delivery_agency_id) {
        await this.vendorRepo.updateProfile(vendorId, { default_delivery_agency_id: agency._id }, session);
        await auditLogger.log({
          actor: { userId: actorUserId, role: actorRole },
          action: 'VENDOR_DEFAULT_AGENCY_AUTO_ASSIGNED',
          resource: { type: 'Vendor', id: vendorId },
          changes: { default_delivery_agency_id: { from: null, to: agencyId } },
          timestamp: new Date(),
        });
      }

      await auditLogger.log({
        actor: { userId: actorUserId, role: actorRole },
        action: isReapproval ? 'AGENCY_CONNECTION_REAPPROVED' : 'AGENCY_CONNECTION_APPROVED',
        resource: { type: 'VendorAgencyConnection', id: updated._id.toString() },
        changes: { vendorId, agencyId },
        timestamp: new Date(),
      });

      if (actorRole === 'agency') {
        await this.notifyVendor('connection.approved', updated._id.toString(), vendorId, agency.agency_name);
      }

      return updated;
    });
  }

  // ─── Reject / withdraw (both only valid from 'pending') ─────────────────────

  async reject(
    actorRole: ConnectionParty,
    actorEntityId: string,
    actorUserId: string,
    connectionId: string,
    reason: string | null,
  ): Promise<IVendorAgencyConnection> {
    const connection = await this.getOwned(connectionId, actorRole, actorEntityId);
    if (connection.status !== 'pending') throw createAppError(ERROR_CODES.CONNECTION_NOT_PENDING, 422);
    if (actorRole === connection.requester_role) throw createAppError(ERROR_CODES.CONNECTION_NOT_APPROVER, 403);

    const updated = await this.connectionRepo.applyTransition(connection._id.toString(), {
      status: 'rejected',
      set: {
        rejection: {
          reason,
          rejected_by_role: actorRole,
          rejected_by_user_id: new Types.ObjectId(actorUserId),
          rejected_at: new Date(),
        },
      },
      historyEntry: this.historyEntry('rejected', actorRole, actorUserId),
    });
    if (!updated) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);

    if (actorRole === 'agency') {
      const agency = await this.agencyRepo.findById(actorEntityId);
      if (agency) await this.notifyVendor('connection.rejected', updated._id.toString(), connection.vendor_id.toString(), agency.agency_name);
    }

    return updated;
  }

  async withdraw(
    actorRole: ConnectionParty,
    actorEntityId: string,
    actorUserId: string,
    connectionId: string,
  ): Promise<IVendorAgencyConnection> {
    const connection = await this.getOwned(connectionId, actorRole, actorEntityId);
    if (connection.status !== 'pending') throw createAppError(ERROR_CODES.CONNECTION_NOT_PENDING, 422);
    if (actorRole !== connection.requester_role) throw createAppError(ERROR_CODES.CONNECTION_NOT_REQUESTER, 403);

    const updated = await this.connectionRepo.applyTransition(connection._id.toString(), {
      status: 'withdrawn',
      set: {
        withdrawal: {
          withdrawn_by_role: actorRole,
          withdrawn_by_user_id: new Types.ObjectId(actorUserId),
          withdrawn_at: new Date(),
        },
      },
      historyEntry: this.historyEntry('withdrawn', actorRole, actorUserId),
    });
    if (!updated) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);
    return updated;
  }

  // ─── Terminate (from active or paused_reapproval) ────────────────────────────

  async terminate(
    actorRole: ConnectionParty,
    actorEntityId: string,
    actorUserId: string,
    connectionId: string,
    note: string | null,
  ): Promise<IVendorAgencyConnection> {
    const connection = await this.getOwned(connectionId, actorRole, actorEntityId);
    if (connection.status !== 'active' && connection.status !== 'paused_reapproval') {
      throw createAppError(ERROR_CODES.CONNECTION_INVALID_STATUS_TRANSITION, 400, undefined, {
        from: connection.status,
        to: 'terminated',
      });
    }

    // Declining a reapproval you were the one owing is distinguished from a
    // plain unilateral end — see connection.model.ts doc comment.
    const reason: 'unilateral' | 'reapproval_declined' =
      connection.status === 'paused_reapproval' && actorRole === connection.reapproval_required_from
        ? 'reapproval_declined'
        : 'unilateral';

    const vendorId = connection.vendor_id.toString();
    const agencyId = connection.agency_id.toString();

    return this.txManager.runInTransaction(async (session) => {
      const updated = await this.connectionRepo.applyTransition(
        connection._id.toString(),
        {
          status: 'terminated',
          set: {
            termination: {
              terminated_by_role: actorRole,
              terminated_by_user_id: new Types.ObjectId(actorUserId),
              terminated_at: new Date(),
              reason,
              note,
            },
          },
          unset: ['reapproval_required_from', 'paused_at', 'paused_reason'],
          historyEntry: this.historyEntry('terminated', actorRole, actorUserId),
        },
        session,
      );
      if (!updated) throw createAppError(ERROR_CODES.CONNECTION_NOT_FOUND, 404);

      await this.suspendForConnection(vendorId, agencyId, session);

      await auditLogger.log({
        actor: { userId: actorUserId, role: actorRole },
        action: 'AGENCY_CONNECTION_TERMINATED',
        resource: { type: 'VendorAgencyConnection', id: updated._id.toString() },
        changes: { vendorId, agencyId, reason },
        timestamp: new Date(),
      });

      return updated;
    });
  }

  // ─── Policy-change pause hook ────────────────────────────────────────────────

  /**
   * Called by VendorProfileService/AgencyProfileService right after `policies`
   * is written with a different value (and the entity's policy_version bumped).
   * Pauses every active/paused connection belonging to this entity, flags the
   * OTHER side as owing reapproval, and suspends the products that depend on
   * each affected pair. Cheap no-op when the entity has no live connections
   * (e.g. during onboarding's first policy submission). Must be called inside
   * the same transaction as the policy write + version bump.
   */
  async pauseConnectionsForPolicyChange(role: ConnectionParty, entityId: string, session: ClientSession): Promise<void> {
    const connections = await this.connectionRepo.findActiveOrPausedForEntity(role, entityId, session);
    if (connections.length === 0) return;

    const reapprovalRequiredFrom = opposite(role);
    const pausedReason = role === 'vendor' ? ('vendor_policy_changed' as const) : ('agency_policy_changed' as const);

    // Fetched once — every connection in this batch shares the same agency_id
    // when role === 'agency' (findActiveOrPausedForEntity filtered on it).
    const agencyName = role === 'agency' ? (await this.agencyRepo.findById(entityId, session))?.agency_name : null;

    for (const connection of connections) {
      await this.connectionRepo.applyTransition(
        connection._id.toString(),
        {
          status: 'paused_reapproval',
          set: {
            paused_at: new Date(),
            paused_reason: pausedReason,
            reapproval_required_from: reapprovalRequiredFrom,
          },
          historyEntry: this.historyEntry('paused_reapproval', 'system', null, `${role} policy changed`),
        },
        session,
      );

      await this.suspendForConnection(connection.vendor_id.toString(), connection.agency_id.toString(), session);

      if (agencyName) {
        await this.notifyVendor('connection.reapproval_needed', connection._id.toString(), connection.vendor_id.toString(), agencyName);
      }
    }
  }

  // ─── Scoped suspend/restore cascade ──────────────────────────────────────────
  //
  // Deliberately scoped to ONE (vendor, agency) pair — unlike AdminAgencyService's
  // agency-wide deactivate cascade, a paused/terminated connection only concerns
  // this one relationship. Blindly calling suspensionService.suspendForVendor
  // would over-suspend products tied to the vendor's OTHER, unaffected connections.

  private async suspendForConnection(vendorId: string, agencyId: string, session: ClientSession): Promise<void> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (vendor?.default_delivery_agency_id?.toString() === agencyId) {
      await this.suspensionService.suspendForVendor(vendorId, { session }, CONNECTION_PAUSED_REASON);
    }

    const overridden = await this.productRepo.findPhysicalByVendorAndOwnDeliveryAgency(vendorId, agencyId, { session });
    for (const product of overridden) {
      await this.suspensionService.suspendProductOwnAgency(product.id, product.vendorId, { session }, CONNECTION_PAUSED_REASON);
    }
  }

  private async restoreForConnection(vendorId: string, agencyId: string, session: ClientSession): Promise<void> {
    const vendor = await this.vendorRepo.findById(vendorId);
    if (vendor?.default_delivery_agency_id?.toString() === agencyId) {
      await this.suspensionService.restoreForVendor(vendorId, { session });
    }

    const overridden = await this.productRepo.findPhysicalByVendorAndOwnDeliveryAgency(vendorId, agencyId, { session });
    for (const product of overridden) {
      await this.suspensionService.restoreProductOwnAgency(product.id, product.vendorId, { session });
    }
  }

  // ─── Browse / search ──────────────────────────────────────────────────────────

  /**
   * Vendor searching agencies to request a connection with. Reuses the existing
   * public agency browse query, then left-joins the vendor's own connection row
   * per agency so the frontend can render Request/Pending/Connected/Reapproval
   * button states.
   */
  async browseAgenciesForVendor(
    vendorId: string,
    params: AgencyListQueryParams,
  ): Promise<{
    agencies: Array<VendorAgencyListItemDto & { connection: { id: string; status: ConnectionStatus } | null }>;
    meta: AgencyListMeta;
  }> {
    const [{ agencies, total }, connections] = await Promise.all([
      this.agencyRepo.findAvailableForVendors(params),
      this.connectionRepo.findAllForEntity('vendor', vendorId),
    ]);
    const byAgencyId = new Map(connections.map((c) => [c.agency_id.toString(), c]));

    const items = agencies.map((agency) => {
      const dto = VendorAgencyMapper.toListItemDto(agency);
      const connection = byAgencyId.get(dto.id);
      return {
        ...dto,
        connection: connection ? { id: connection._id.toString(), status: connection.status } : null,
      };
    });

    return {
      agencies: items,
      meta: { total, page: params.page, limit: params.limit, totalPages: Math.ceil(total / params.limit) },
    };
  }

  /**
   * Agency searching vendors to request a connection with. Symmetric to
   * browseAgenciesForVendor.
   */
  async browseVendorsForAgency(
    agencyId: string,
    params: VendorListQueryParams,
  ): Promise<{
    vendors: Array<AgencyVendorListItemDto & { connection: { id: string; status: ConnectionStatus } | null }>;
    meta: AgencyListMeta;
  }> {
    const [{ vendors, total }, connections] = await Promise.all([
      this.vendorRepo.findAvailableForAgencies(params),
      this.connectionRepo.findAllForEntity('agency', agencyId),
    ]);
    const byVendorId = new Map(connections.map((c) => [c.vendor_id.toString(), c]));

    // Batch-resolve branding logo file ids into public URLs (one query for the page).
    const logoFileIds = [...new Set(
      vendors.map((v) => v.branding?.logo_file_id?.toString()).filter((id): id is string => !!id),
    )];
    const logoFiles = logoFileIds.length > 0 ? await this.fileRepository.findManyByIds(logoFileIds) : [];
    const logoUrlByFileId = new Map(logoFiles.map((f) => [f.id, this.storageProvider.getPublicUrl(f.key)]));

    const items = vendors.map((vendor) => {
      const logoFileId = vendor.branding?.logo_file_id?.toString();
      const logoUrl = logoFileId ? logoUrlByFileId.get(logoFileId) ?? null : null;
      const dto = AgencyVendorMapper.toListItemDto(vendor, logoUrl);
      const connection = byVendorId.get(dto.id);
      return {
        ...dto,
        connection: connection ? { id: connection._id.toString(), status: connection.status } : null,
      };
    });

    return {
      vendors: items,
      meta: { total, page: params.page, limit: params.limit, totalPages: Math.ceil(total / params.limit) },
    };
  }

  // ─── Read ─────────────────────────────────────────────────────────────────────

  async getOwnedById(
    connectionId: string,
    actorRole: ConnectionParty,
    actorEntityId: string,
  ): Promise<IVendorAgencyConnection> {
    return this.getOwned(connectionId, actorRole, actorEntityId);
  }

  async listForVendor(vendorId: string, filters: { status?: ConnectionStatus }, pagination: PaginationOptions) {
    return this.connectionRepo.listForVendor(vendorId, filters, pagination);
  }

  async listForAgency(agencyId: string, filters: { status?: ConnectionStatus }, pagination: PaginationOptions) {
    return this.connectionRepo.listForAgency(agencyId, filters, pagination);
  }

  async findByVendorAndAgency(vendorId: string, agencyId: string): Promise<IVendorAgencyConnection | null> {
    return this.connectionRepo.findByVendorAndAgency(vendorId, agencyId);
  }
}
