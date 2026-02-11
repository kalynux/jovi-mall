import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { TicketService } from '../services/ticket.service';
import { TicketFollowerService } from '../services/ticket-follower.service';
import {
    CreateTicketSchema,
    UpdateTicketSchema,
    UpdateStatusSchema,
    AssignTicketSchema,
    UpdatePrioritySchema,
    ListTicketsQuerySchema
} from '../validators/ticket.validator';
import { AppError } from '../../../core/errors';
import { ActorRole, EntityType, TicketImportance, TicketPriority, TicketStatus } from '../types/ticket.types';

/**
 * TicketController
 * 
 * HTTP layer for ticket management.
 * All routes require authentication via requireAuth middleware.
 * Role-specific access enforced via requireRole middleware.
 */

export class TicketController {
    private static ticketService = new TicketService();
    private static followerService = new TicketFollowerService();

    // * POST /api/*/tickets
    // * Create a new ticket 
    static async createTicket(req: Request, res: Response): Promise<void> {
        try {
            const validated = CreateTicketSchema.parse(req.body);
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const ticket = await TicketController.ticketService.createTicket({
                subject: validated.subject,
                description: validated.description,
                type: validated.type,
                importance: validated.importance as TicketImportance,
                entityType: validated.entityType as EntityType,
                entityId: validated.entityId,
                createdByUserId: userId,
                createdByRole: role
            });

            res.status(201).json({
                success: true,
                data: ticket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    // * GET /api/*/tickets
    // * List tickets with filters and pagination
    static async listTickets(req: Request, res: Response): Promise<void> {
        try {
            const query = ListTicketsQuerySchema.parse(req.query);
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            // Build filters
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

            const result = await TicketController.ticketService.listTicketsForUser(
                userId,
                role,
                filters,
                pagination
            );

            res.status(200).json({
                success: true,
                data: result.data,
                pagination: result.pagination
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    // * GET /api/*/tickets /: id
    // * Get ticket details with followers, notes, and attachments
    static async getTicketDetails(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const ticket = await TicketController.ticketService.getTicketById(ticketId);
            if (!ticket) {
                res.status(404).json({ success: false, error: 'Ticket not found' });
                return;
            }

            // Check visibility
            if (role !== ActorRole.ADMIN) {
                const isFollower = await TicketController.followerService.isFollower(ticketId, userId);
                if (!isFollower) {
                    res.status(403).json({ success: false, error: 'Access denied to this ticket' });
                    return;
                }
            }

            // Admin exclusivity check
            if (ticket.assigned_admin_id && role === ActorRole.ADMIN) {
                if (ticket.assigned_admin_id.toString() !== req.auth!.role_entity.id) {
                    res.status(403).json({
                        success: false,
                        error: 'This ticket is assigned to a specific admin'
                    });
                    return;
                }
            }

            res.status(200).json({
                success: true,
                data: ticket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    //   * PATCH /api/*/tickets /: id
    // * Update ticket fields(subject, description)
    static async updateTicket(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const validated = UpdateTicketSchema.parse(req.body);
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const updatedTicket = await TicketController.ticketService.updateTicket(
                ticketId,
                validated,
                userId,
                role
            );

            res.status(200).json({
                success: true,
                data: updatedTicket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    // * PATCH /api/*/tickets /: id / status
    // * Update ticket status
    static async updateStatus(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const validated = UpdateStatusSchema.parse(req.body);
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const updatedTicket = await TicketController.ticketService.updateStatus(
                ticketId,
                validated.status as TicketStatus,
                userId,
                role
            );

            res.status(200).json({
                success: true,
                data: updatedTicket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    // * PATCH /api/*/tickets /: id / assign
    // * Assign ticket to a role / user
    static async assignTicket(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const validated = AssignTicketSchema.parse(req.body);
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const updatedTicket = await TicketController.ticketService.assignTicket(
                ticketId,
                validated.targetRole as ActorRole,
                validated.targetUserId || null,
                userId,
                role
            );

            res.status(200).json({
                success: true,
                data: updatedTicket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    // * PATCH /api/*/tickets /: id / priority
    // * Update ticket priority
    static async updatePriority(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const validated = UpdatePrioritySchema.parse(req.body);
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const updatedTicket = await TicketController.ticketService.updatePriority(
                ticketId,
                validated.priority as TicketPriority,
                userId,
                role
            );

            res.status(200).json({
                success: true,
                data: updatedTicket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    // * POST /api/*/tickets /: id / close
    // * Close a ticket
    static async closeTicket(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const updatedTicket = await TicketController.ticketService.closeTicket(ticketId, userId, role);

            res.status(200).json({
                success: true,
                data: updatedTicket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    /**
     * POST /api/admin/tickets/:id/reopen
     * Reopen a closed ticket (admin only)
     */
    static async reopenTicket(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const userId = req.auth!.user.id;
            const role = req.auth!.role as ActorRole;

            const updatedTicket = await TicketController.ticketService.reopenTicket(ticketId, userId, role);

            res.status(200).json({
                success: true,
                data: updatedTicket
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    /**
     * POST /api/admin/tickets/:id/followers
     * Add a follower to a ticket (admin only)
     */
    static async addFollower(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const { userId: targetUserId, role: targetRole } = req.body;
            const addedBy = req.auth!.user.id;

            await TicketController.followerService.addFollower(
                ticketId,
                targetUserId,
                targetRole,
                addedBy,
                false // not silent, create system note
            );

            res.status(200).json({
                success: true,
                message: 'Follower added successfully'
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/admin/tickets/:id/followers/:userId
     * Remove a follower from a ticket (admin only)
     */
    static async removeFollower(req: Request, res: Response): Promise<void> {
        try {
            const ticketId = req.params.id;
            const userIdToRemove = req.params.userId;
            const requesterId = req.auth!.user.id;
            const requesterRole = req.auth!.role as ActorRole;

            await TicketController.followerService.removeFollower(
                ticketId,
                userIdToRemove,
                requesterId,
                requesterRole
            );

            res.status(200).json({
                success: true,
                message: 'Follower removed successfully'
            });
        } catch (error) {
            TicketController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
        if (error instanceof ZodError) {
            res.status(400).json({
                success: false,
                error: 'Validation error',
                details: error.errors
            });
            return;
        }

        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                success: false,
                error: error.message,
                code: error.code
            });
            return;
        }

        console.error('Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
}
