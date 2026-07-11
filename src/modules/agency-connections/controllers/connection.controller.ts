import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { ConnectionService } from '../connection.service';
import { ConnectionMapper } from '../dto/connection.dto';
import {
  RequestConnectionSchema,
  RejectConnectionSchema,
  TerminateConnectionSchema,
  ListConnectionsQuerySchema,
  BrowseAgenciesQuerySchema,
  BrowseVendorsQuerySchema,
} from '../connection.validator';
import { ConnectionParty } from '../connection.model';

const connectionService = new ConnectionService();

/**
 * ConnectionController
 *
 * Shared by both the vendor and agency routers — which side is acting is
 * always derived from req.auth.role/role_entity, never from the route path,
 * mirroring ShipmentService's role-branching methods.
 */
export class ConnectionController {
  /** POST /api/vendor/agency-connections | POST /api/agency/vendor-connections */
  static request = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();
    const userId = req.auth!.user.id;
    const { counterpartyId } = RequestConnectionSchema.parse(req.body);

    const connection = await connectionService.request(role, entityId, userId, counterpartyId);

    res.status(201).json({
      success: true,
      data: ConnectionMapper.toDto(connection),
      message: 'Connection request sent',
    });
  });

  /** GET /api/vendor/agency-connections/browse — vendor searches agencies. */
  static browseAgencies = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { page, limit, ...filters } = BrowseAgenciesQuerySchema.parse(req.query);

    const result = await connectionService.browseAgenciesForVendor(vendorId, { ...filters, page, limit });

    res.json({ success: true, data: result.agencies, meta: result.meta });
  });

  /** GET /api/agency/vendor-connections/browse — agency searches vendors. */
  static browseVendors = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { page, limit, ...filters } = BrowseVendorsQuerySchema.parse(req.query);

    const result = await connectionService.browseVendorsForAgency(agencyId, { ...filters, page, limit });

    res.json({ success: true, data: result.vendors, meta: result.meta });
  });

  /** GET .../  — the caller's own connections, any status, paginated. */
  static list = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();
    const { status, page, limit } = ListConnectionsQuerySchema.parse(req.query);

    const result = role === 'vendor'
      ? await connectionService.listForVendor(entityId, { status }, { page, limit })
      : await connectionService.listForAgency(entityId, { status }, { page, limit });

    res.json({
      success: true,
      data: result.data.map(ConnectionMapper.toDto),
      meta: { total: result.meta.total, page: result.meta.page, limit: result.meta.limit, totalPages: result.meta.pages },
    });
  });

  /** GET .../:id */
  static getById = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();

    const connection = await connectionService.getOwnedById(req.params.id, role, entityId);

    res.json({ success: true, data: ConnectionMapper.toDto(connection) });
  });

  /** POST .../:id/approve — dispatches on current status (pending or paused_reapproval). */
  static approve = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();
    const userId = req.auth!.user.id;

    const connection = await connectionService.approve(role, entityId, userId, req.params.id);

    res.json({ success: true, data: ConnectionMapper.toDto(connection), message: 'Connection approved' });
  });

  /** POST .../:id/reject */
  static reject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();
    const userId = req.auth!.user.id;
    const { reason } = RejectConnectionSchema.parse(req.body);

    const connection = await connectionService.reject(role, entityId, userId, req.params.id, reason ?? null);

    res.json({ success: true, data: ConnectionMapper.toDto(connection), message: 'Connection rejected' });
  });

  /** POST .../:id/withdraw */
  static withdraw = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();
    const userId = req.auth!.user.id;

    const connection = await connectionService.withdraw(role, entityId, userId, req.params.id);

    res.json({ success: true, data: ConnectionMapper.toDto(connection), message: 'Connection request withdrawn' });
  });

  /** POST .../:id/terminate */
  static terminate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const role = req.auth!.role as ConnectionParty;
    const entityId = req.auth!.role_entity._id.toString();
    const userId = req.auth!.user.id;
    const { note } = TerminateConnectionSchema.parse(req.body);

    const connection = await connectionService.terminate(role, entityId, userId, req.params.id, note ?? null);

    res.json({ success: true, data: ConnectionMapper.toDto(connection), message: 'Connection terminated' });
  });
}
