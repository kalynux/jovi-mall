import { Request, Response, NextFunction } from 'express';
import { TicketService } from '../services/ticket.service';
import { TicketFollowerService } from '../services/ticket-follower.service';
import { TicketEnrichmentService } from '../services/ticket-enrichment.service';
import {
    CreateTicketSchema,
    UpdateTicketSchema,
    UpdateStatusSchema,
    AssignTicketSchema,
    AssignToAdministratorSchema,
    RefreshAdminSnapshotSchema,
    UpdatePrioritySchema,
    ListTicketsQuerySchema
} from '../validators/ticket.validator';
import { ActorRole, EntityType, TicketImportance, TicketPriority, TicketStatus } from '../types/ticket.types';
import { IAdminSnapshot } from '../../../core/types/admin-snapshot.types';
import { adminCallerActor } from '../../../api/middlewares/admin-caller.middleware';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

const ticketService = new TicketService();
const followerService = new TicketFollowerService();
const enrichmentService = new TicketEnrichmentService();

export class TicketController {

    static createTicket = asyncHandler(async (req: Request, res: Response) => {
        const validated = CreateTicketSchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        // General/policy questions (`OTHER`) have no related entity — anchor the
        // polymorphic reference to the requester's own role entity (e.g. customer id).
        const entityId =
            validated.entityId ?? req.auth!.role_entity._id.toString();

        const ticket = await ticketService.createTicket({
            subject: validated.subject,
            description: validated.description,
            type: validated.type,
            importance: validated.importance as TicketImportance,
            entityType: validated.entityType as EntityType,
            entityId,
            trackingNumber: validated.trackingNumber,
            attachments: validated.attachments,
            createdByUserId: userId,
            createdByRole: role,
            createdByEntityId: req.auth!.role_entity._id.toString(),
            // Present only on the internal admin API, where wi-admin sends the profile of the
            // administrator opening the ticket. `role` is `admin` there by mount, so the two
            // cannot disagree.
            createdByAdmin: (validated.admin as IAdminSnapshot | undefined) ?? null
        });

        const enriched = await enrichmentService.enrichTicket(ticket);
        res.status(201).json({ success: true, data: enriched });
    });

    static listTickets = asyncHandler(async (req: Request, res: Response) => {
        const query = ListTicketsQuerySchema.parse(req.query);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const filters: any = {};
        if (query.type) filters.type = query.type;
        if (query.status) filters.status = query.status;
        if (query.priority) filters.priority = query.priority;
        if (query.entityType) filters.entity_type = query.entityType;
        if (query.entityId) filters.entity_id = query.entityId;
        if (query.createdByUserId) filters.created_by_user_id = query.createdByUserId;
        if (query.assignedToRole) filters.assigned_to_role = query.assignedToRole;
        if (query.assignedToUserId) filters.assigned_to_user_id = query.assignedToUserId;

        const pagination = {
            page: query.page,
            limit: query.limit,
            sortBy: query.sortBy,
            sortOrder: query.sortOrder
        };

        const result = await ticketService.listTicketsForUser(userId, role, filters, pagination);

        const enriched = await enrichmentService.enrichTickets(result.data);
        res.status(200).json({ success: true, data: enriched, pagination: result.pagination });
    });

    static getTicketDetails = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const ticketId = req.params.id;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const ticket = await ticketService.getTicketById(ticketId);
        if (!ticket) {
            return next(createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404));
        }

        if (role !== ActorRole.ADMIN) {
            const isFollower = await followerService.isFollower(ticketId, userId);
            if (!isFollower) {
                return next(createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Access denied to this ticket'));
            }
        }

        const enriched = await enrichmentService.enrichTicket(ticket);
        res.status(200).json({ success: true, data: enriched });
    });

    static updateTicket = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const validated = UpdateTicketSchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const updatedTicket = await ticketService.updateTicket(ticketId, validated, userId, role);

        res.status(200).json({ success: true, data: updatedTicket });
    });

    static updateStatus = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const validated = UpdateStatusSchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const updatedTicket = await ticketService.updateStatus(ticketId, validated.status as TicketStatus, userId, role);

        res.status(200).json({ success: true, data: updatedTicket });
    });

    static assignTicket = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const validated = AssignTicketSchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const updatedTicket = await ticketService.assignTicket(
            ticketId,
            validated.targetRole as ActorRole,
            validated.targetUserId || null,
            userId,
            role
        );

        res.status(200).json({ success: true, data: updatedTicket });
    });

    /**
     * Hand a ticket to a named administrator, or claim it from the pool.
     *
     * Only reachable through `/api/internal/admin/tickets`, so the caller is wi-admin and the
     * body carries what only wi-admin can know: the TARGET administrator's profile, read from
     * its own `admin_accounts`. The caller's own identity comes from the `X-Actor-*` headers
     * instead, via `adminCallerActor` — headers describe who is calling, the body describes
     * who they are assigning.
     *
     * `assignedBy` is null when an administrator claims a ticket for themselves, which is a
     * real distinction rather than a missing value: the tier rules key on who assigned it.
     */
    static assignToAdministrator = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const validated = AssignToAdministratorSchema.parse(req.body);

        const caller = adminCallerActor(req);
        const admin = validated.admin as IAdminSnapshot;

        // Claiming — the caller IS the assignee — records no assigner. Compared on the id
        // rather than trusting a flag in the body, so the two cannot disagree.
        const assignedBy: IAdminSnapshot | null =
            caller && caller.id !== admin.id && validated.assignedBy
                ? validated.assignedBy as IAdminSnapshot
                : null;

        const updatedTicket = await ticketService.assignToAdministrator(ticketId, admin, assignedBy);

        res.status(200).json({ success: true, data: updatedTicket });
    });

    /**
     * Re-stamp the assignee's profile, without touching who the assignee is.
     *
     * Its own route rather than a shape of `/assign`, because the difference is not cosmetic:
     * `/assign` with a bare `admin` means "this administrator now holds it, claimed", so
     * routing a refresh through it would reassign the ticket on every edit and clear
     * `assigned_by` — the field the tier rules depend on. The service no-ops when the id does
     * not match the current holder, so a refresh racing a reassignment cannot win.
     */
    static refreshAdminSnapshot = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const validated = RefreshAdminSnapshotSchema.parse(req.body);

        await ticketService.refreshAdminSnapshot(ticketId, validated.admin as IAdminSnapshot);

        res.status(204).send();
    });

    static updatePriority = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const validated = UpdatePrioritySchema.parse(req.body);
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const updatedTicket = await ticketService.updatePriority(ticketId, validated.priority as TicketPriority, userId, role);

        res.status(200).json({ success: true, data: updatedTicket });
    });

    static closeTicket = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const updatedTicket = await ticketService.closeTicket(ticketId, userId, role);

        res.status(200).json({ success: true, data: updatedTicket });
    });

    static reopenTicket = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const userId = req.auth!.user.id;
        const role = req.auth!.role as ActorRole;

        const updatedTicket = await ticketService.reopenTicket(ticketId, userId, role);

        res.status(200).json({ success: true, data: updatedTicket });
    });

    static addFollower = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const { userId: targetUserId, role: targetRole } = req.body;
        const addedBy = req.auth!.user.id;

        await followerService.addFollower(ticketId, targetUserId, targetRole, addedBy, false);

        res.status(200).json({ success: true, message: 'Follower added successfully' });
    });

    static removeFollower = asyncHandler(async (req: Request, res: Response) => {
        const ticketId = req.params.id;
        const userIdToRemove = req.params.userId;
        const requesterId = req.auth!.user.id;
        const requesterRole = req.auth!.role as ActorRole;

        await followerService.removeFollower(ticketId, userIdToRemove, requesterId, requesterRole);

        res.status(200).json({ success: true, message: 'Follower removed successfully' });
    });
}
