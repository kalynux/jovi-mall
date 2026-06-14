import { TicketRepository, TicketFilters, PaginationOptions } from '../repositories/ticket.repository';
import { TicketFollowerService } from './ticket-follower.service';
import { TicketNoteService } from './ticket-note.service';
import { TicketStatus, TicketPriority, ActorRole, EntityType, TicketImportance, isWaitingStatus, WAITING_STATUS_TARGET_ROLE } from '../types/ticket.types';
import { ITicket } from '../models/ticket.model';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import mongoose from 'mongoose';

/**
 * TicketService
 * 
 * Orchestrates ticket lifecycle management and business logic.
 * 
 * RESPONSIBILITIES:
 * - Ticket creation with polymorphic entity validation
 * - Status transitions with system notes
 * - Assignment with role validation and 5-user limit enforcement
 * - Priority management with admin locking
 * - Close/reopen operations
 * - Visibility control via followers
 * 
 * DOMAIN RULES:
 * - Creator auto-added as follower
 * - Assignee auto-added as follower
 * - Status changes generate system notes
 * - Priority locks forever after admin updates it
 * - Only creator or admin can close ticket
 * - Only admin can reopen ticket
 * - Assignment validation varies by role
 */

export class TicketService {
    private ticketRepo: TicketRepository;
    private followerService: TicketFollowerService;
    private noteService: TicketNoteService;

    constructor() {
        this.ticketRepo = new TicketRepository();
        this.followerService = new TicketFollowerService();
        this.noteService = new TicketNoteService();
    }

    /**
     * ============================================
     * ADMIN LOCKING HELPERS (Exclusive Active Admin)
     * ============================================
     */

    /**
     * Validate admin has permission to act on ticket
     * Throws ForbiddenError if active admin is set and doesn't match current admin
     * 
     * @param ticket - Ticket object (passed to optimize DB calls)
     * @param adminUserId - Current admin user ID
     * @param role - Current user role
     */
    private validateActiveAdminPermission(
        ticket: ITicket,
        adminUserId: string,
        role: ActorRole
    ): void {
        // Non-admins use normal permission checks
        if (role !== ActorRole.ADMIN) {
            return;
        }

        // If active admin is set and doesn't match current admin, block
        if (ticket.assigned_admin_id) {
            const activeAdminId = ticket.assigned_admin_id.toString();
            if (activeAdminId !== adminUserId) {
                throw createAppError(
                    ERROR_CODES.TICKET_ACCESS_DENIED,
                    403,
                    'This ticket is locked to another admin. Only they can perform actions.'
                );
            }
        }

        // If no active admin OR user matches active admin, allow action
    }

    /**
     * Set active admin if not already set (first action locks ticket)
     * 
     * @param ticket - Ticket object (passed to optimize DB calls)
     * @param adminUserId - Admin user ID to set as active
     */
    private async setActiveAdminIfNotSet(ticket: ITicket, adminUserId: string): Promise<void> {
        // Only set if not already set
        if (!ticket.assigned_admin_id) {
            await this.ticketRepo.setActiveAdmin(ticket.id, adminUserId);
        }
    }

    /**
     * Clear active admin (auto-unlock on close/resolve)
     * 
     * @param ticketId - Ticket ID
     */
    private async clearActiveAdmin(ticketId: string): Promise<void> {
        await this.ticketRepo.clearActiveAdmin(ticketId);
    }

    /**
     * Create a new ticket
     * 
     * @param input - Ticket creation data
     */
    async createTicket(input: {
        subject: string;
        description: string;
        type: string;
        importance: TicketImportance;
        entityType: EntityType;
        entityId: string;
        createdByUserId: string;
        createdByRole: ActorRole;
    }): Promise<ITicket> {
        // Polymorphic entity validation
        await this.validateEntityReference(input.entityType, input.entityId);

        // Create ticket
        const ticket = await this.ticketRepo.create({
            subject: input.subject,
            description: input.description,
            type: input.type as any, // String enum validated by Zod
            status: TicketStatus.OPEN,
            priority: TicketPriority.NORMAL,
            importance: input.importance,
            priority_locked: false,
            entity_type: input.entityType,
            entity_id: input.entityId,
            created_by_role: input.createdByRole,
            created_by_user_id: new mongoose.Types.ObjectId(input.createdByUserId),
            updated_by: [new mongoose.Types.ObjectId(input.createdByUserId)]
        });

        // Auto-add creator as follower (silent = true, no system note)
        await this.followerService.addFollower(
            ticket.id,
            input.createdByUserId,
            input.createdByRole,
            input.createdByUserId,
            true // silent
        );

        // Emit event
        await eventBus.publish('ticket.created', {
            eventType: 'ticket.created',
            aggregateId: ticket.id,
            payload: {
                ticketId: ticket.id,
                subject: ticket.subject,
                type: ticket.type,
                createdByRole: input.createdByRole,
                entityType: input.entityType,
                entityId: input.entityId
            },
            occurredAt: new Date()
        });

        return ticket;
    }

    /**
     * Update ticket status with system notes
     * 
     * @param ticketId - Ticket ID
     * @param newStatus - New status
     * @param userId - User making the change
     * @param role - User's role
     */
    async updateStatus(
        ticketId: string,
        newStatus: TicketStatus,
        userId: string,
        role: ActorRole
    ): Promise<ITicket> {
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Validate active admin permission (exclusive locking)
        this.validateActiveAdminPermission(ticket, userId, role);

        // Validate user has permission (must be follower or admin)
        if (role !== ActorRole.ADMIN) {
            const isFollower = await this.followerService.isFollower(ticketId, userId);
            if (!isFollower) {
                throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only ticket followers can update status');
            }
        }

        const oldStatus = ticket.status;

        // Validate status transition (basic validation)
        this.validateStatusTransition(oldStatus, newStatus);

        // For actor-specific waiting statuses, ensure the targeted party participates
        await this.assertWaitingTargetParticipates(ticketId, newStatus);

        // Update status
        const updatedTicket = await this.ticketRepo.updateStatus(ticketId, newStatus, userId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_UPDATE_FAILED, 500, ERROR_CODES.TICKET_UPDATE_FAILED, false);
        }

        // Set active admin if admin is acting (exclusive lock on first action)
        if (role === ActorRole.ADMIN) {
            await this.setActiveAdminIfNotSet(ticket, userId);
        }

        // Create system note
        await this.noteService.createSystemNote(
            ticketId,
            `Status changed from "${oldStatus}" to "${newStatus}"`
        );

        // Auto-unlock on close or resolve
        if (newStatus === TicketStatus.CLOSED || newStatus === TicketStatus.RESOLVED) {
            await this.clearActiveAdmin(ticketId);
        }

        // Emit event
        await eventBus.publish('ticket.status_changed', {
            eventType: 'ticket.status_changed',
            aggregateId: ticketId,
            payload: {
                ticketId,
                oldStatus,
                newStatus,
                changedBy: userId,
                changedByRole: role
            },
            occurredAt: new Date()
        });

        return updatedTicket;
    }

    /**
     * Assign ticket to a user/role
     * 
     * ASSIGNMENT RULES:
     * - If targetRole = ADMIN and targetUserId = null → admin pool
     * - If targetRole = ADMIN and targetUserId provided → specific admin (exclusivity)
     * - If targetRole ≠ ADMIN → targetUserId is mandatory
     * 
     * @param ticketId - Ticket ID
     * @param targetRole - Role to assign to
     * @param targetUserId - User ID (optional for admin pool)
     * @param assignerUserId - User making assignment
     * @param assignerRole - Assigner's role
     */
    async assignTicket(
        ticketId: string,
        targetRole: ActorRole,
        targetUserId: string | null,
        assignerUserId: string,
        assignerRole: ActorRole
    ): Promise<ITicket> {
        // Fetch ticket once (optimization)
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Validate active admin permission (exclusive locking)
        this.validateActiveAdminPermission(ticket, assignerUserId, assignerRole);

        // Validate assignment rules
        if (targetRole === ActorRole.ADMIN) {
            // Admin assignment: userId optional (pool assignment)
            // If userId provided, enables exclusivity
        } else {
            // Non-admin assignment: userId mandatory
            if (!targetUserId) {
                throw createAppError(ERROR_CODES.TICKET_ASSIGN_FAILED, 400, `User ID is required when assigning to role ${targetRole}`);
            }
        }

        // If assigning to specific user, add as follower (respects 5-user limit)
        if (targetUserId) {
            await this.followerService.addFollower(
                ticketId,
                targetUserId,
                targetRole,
                assignerUserId,
                true // silent
            );
        }

        // For admin exclusivity: set assigned_admin_id if specific admin
        const adminId = (targetRole === ActorRole.ADMIN && targetUserId) ? targetUserId : null;

        // Perform assignment
        const updatedTicket = await this.ticketRepo.assign(ticketId, targetRole, targetUserId, adminId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_ASSIGN_FAILED, 500, ERROR_CODES.TICKET_ASSIGN_FAILED, false);
        }

        // Set active admin if admin is acting (exclusive lock on first action)
        if (assignerRole === ActorRole.ADMIN) {
            await this.setActiveAdminIfNotSet(ticket, assignerUserId);
        }

        // Create system note
        const noteText = targetUserId
            ? `Assigned to ${targetRole} (User ID: ${targetUserId})`
            : `Assigned to ${targetRole} pool`;
        await this.noteService.createSystemNote(ticketId, noteText);

        // Emit event
        await eventBus.publish('ticket.assigned', {
            eventType: 'ticket.assigned',
            aggregateId: ticketId,
            payload: {
                ticketId,
                targetRole,
                targetUserId,
                adminExclusivity: adminId !== null,
                assignedBy: assignerUserId
            },
            occurredAt: new Date()
        });

        return updatedTicket;
    }

    /**
     * Update ticket priority
     * 
     * If requester is admin, priority gets locked forever.
     * Active admin can re-update locked priority.
     * 
     * @param ticketId - Ticket ID
     * @param newPriority - New priority
     * @param userId - User making the change
     * @param role - User's role
     */
    async updatePriority(
        ticketId: string,
        newPriority: TicketPriority,
        userId: string,
        role: ActorRole
    ): Promise<ITicket> {
        // Fetch ticket once (optimization)
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Closed tickets are terminal; priority cannot be modified until reopened
        if (ticket.status === TicketStatus.CLOSED) {
            throw createAppError(ERROR_CODES.TICKET_CLOSED, 409, 'Cannot update priority of a closed ticket');
        }

        // Validate active admin permission FIRST (exclusive locking)
        this.validateActiveAdminPermission(ticket, userId, role);

        // Check if priority is locked
        if (ticket.priority_locked) {
            // If locked, only active admin can update
            if (role !== ActorRole.ADMIN) {
                throw createAppError(ERROR_CODES.TICKET_PRIORITY_LOCKED, 403, 'Priority is locked by admin and cannot be modified');
            }
            // At this point, admin has passed validateActiveAdminPermission
            // So they ARE the active admin and can update
        }

        const oldPriority = ticket.priority;
        const lockPriority = role === ActorRole.ADMIN;

        // Update priority
        const updatedTicket = await this.ticketRepo.updatePriority(
            ticketId,
            newPriority,
            userId,
            lockPriority
        );
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_PRIORITY_UPDATE_FAILED, 500, ERROR_CODES.TICKET_PRIORITY_UPDATE_FAILED, false);
        }

        // Set active admin if admin is acting (exclusive lock on first action)
        if (role === ActorRole.ADMIN) {
            await this.setActiveAdminIfNotSet(ticket, userId);
        }

        // Create system note
        const noteText = lockPriority
            ? `Priority changed from "${oldPriority}" to "${newPriority}" and locked by admin`
            : `Priority changed from "${oldPriority}" to "${newPriority}"`;
        await this.noteService.createSystemNote(ticketId, noteText);

        // Emit event
        await eventBus.publish('ticket.priority_changed', {
            eventType: 'ticket.priority_changed',
            aggregateId: ticketId,
            payload: {
                ticketId,
                oldPriority,
                newPriority,
                locked: lockPriority,
                changedBy: userId
            },
            occurredAt: new Date()
        });

        return updatedTicket;
    }

    /**
     * Close ticket
     * 
     * @param ticketId - Ticket ID
     * @param userId - User closing the ticket
     * @param role - User's role
     */
    async closeTicket(ticketId: string, userId: string, role: ActorRole): Promise<ITicket> {
        // Fetch ticket once (optimization)
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Validate active admin permission (exclusive locking)
        this.validateActiveAdminPermission(ticket, userId, role);

        // Validate only creator or admin can close
        if (role !== ActorRole.ADMIN && ticket.created_by_user_id.toString() !== userId) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only ticket creator or admin can close ticket');
        }

        const updatedTicket = await this.ticketRepo.updateStatus(ticketId, TicketStatus.CLOSED, userId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_CLOSE_FAILED, 500, ERROR_CODES.TICKET_CLOSE_FAILED, false);
        }

        // Set active admin if admin is acting (exclusive lock on first action)
        if (role === ActorRole.ADMIN) {
            await this.setActiveAdminIfNotSet(ticket, userId);
        }

        // Auto-unlock on close
        await this.clearActiveAdmin(ticketId);

        await this.noteService.createSystemNote(ticketId, 'Ticket closed');

        return updatedTicket;
    }

    /**
     * Reopen closed ticket (admin only)
     * 
     * @param ticketId - Ticket ID
     * @param userId - Admin user ID
     * @param role - User's role
     */
    async reopenTicket(ticketId: string, userId: string, role: ActorRole): Promise<ITicket> {
        if (role !== ActorRole.ADMIN) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only admins can reopen tickets');
        }

        // Fetch ticket once (optimization)
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Note: No active admin validation needed - reopening is allowed by any admin
        // since ticket was previously closed and unlocked

        if (ticket.status !== TicketStatus.CLOSED) {
            throw createAppError(ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION, 400, 'Only closed tickets can be reopened');
        }

        const updatedTicket = await this.ticketRepo.updateStatus(ticketId, TicketStatus.OPEN, userId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_REOPEN_FAILED, 500, ERROR_CODES.TICKET_REOPEN_FAILED, false);
        }

        // Set active admin (admin who reopens becomes active)
        await this.setActiveAdminIfNotSet(ticket, userId);

        // Create system note
        await this.noteService.createSystemNote(ticketId, 'Ticket reopened by admin');

        return updatedTicket;
    }

    /**
     * Update ticket fields (subject, description)
     */
    async updateTicket(
        ticketId: string,
        updates: { subject?: string; description?: string },
        userId: string,
        role: ActorRole
    ): Promise<ITicket> {
        // Fetch ticket once (optimization)
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Validate active admin permission (exclusive locking)
        this.validateActiveAdminPermission(ticket, userId, role);

        // Validate permission
        if (role !== ActorRole.ADMIN) {
            const isFollower = await this.followerService.isFollower(ticketId, userId);
            if (!isFollower) {
                throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only ticket followers can update tickets');
            }
        }

        // Update ticket
        const updatedTicket = await this.ticketRepo.update(ticketId, updates, userId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_GENERAL_UPDATE_FAILED, 500, ERROR_CODES.TICKET_GENERAL_UPDATE_FAILED, false);
        }

        // Set active admin if admin is acting (exclusive lock on first action)
        if (role === ActorRole.ADMIN) {
            await this.setActiveAdminIfNotSet(ticket, userId);
        }

        return updatedTicket;
    }

    /**
     * Get ticket by ID
     */
    async getTicketById(ticketId: string): Promise<ITicket | null> {
        return await this.ticketRepo.findById(ticketId);
    }

    /**
     * List tickets visible to a user with filters and pagination
     */
    async listTicketsForUser(
        userId: string,
        role: ActorRole,
        filters: TicketFilters,
        pagination: PaginationOptions
    ) {
        return await this.ticketRepo.findVisibleToUser(userId, role, filters, pagination);
    }

    /**
     * Validate polymorphic entity reference
     * 
     * This is a stub implementation. In production, you would:
     * - Check if ORDER exists in OrderModel
     * - Check if PRODUCT exists in ProductModel
     * - etc.
     */
    private async validateEntityReference(entityType: EntityType, entityId: string): Promise<void> {
        // TODO: Implement actual validation based on entityType
        // For now, just basic validation
        if (!entityId || entityId.trim() === '') {
            throw createAppError(ERROR_CODES.TICKET_GENERAL_UPDATE_FAILED, 400, 'Entity ID is required');
        }

        // Example validation (implement for each entity type):
        // if (entityType === EntityType.ORDER) {
        //   const orderExists = await OrderModel.findById(entityId);
        //   if (!orderExists) {
        //     throw new NotFoundError('Referenced order not found');
        //   }
        // }
    }

    /**
     * Enforce that an actor-specific waiting status targets a party that actually
     * participates in the ticket.
     *
     * - `waiting_on_admin` is always allowed (platform admin support is implicit).
     * - Every other `waiting_on_<role>` requires a follower with that role on the
     *   ticket (creator and assignee are auto-followers, so they count).
     * - Non-waiting statuses are a no-op.
     */
    private async assertWaitingTargetParticipates(ticketId: string, newStatus: TicketStatus): Promise<void> {
        if (!isWaitingStatus(newStatus)) {
            return;
        }

        const targetRole = WAITING_STATUS_TARGET_ROLE[newStatus];
        if (!targetRole || targetRole === ActorRole.ADMIN) {
            return;
        }

        const hasParticipant = await this.followerService.hasParticipantWithRole(ticketId, targetRole);
        if (!hasParticipant) {
            throw createAppError(
                ERROR_CODES.TICKET_WAITING_TARGET_NOT_PARTICIPANT,
                400,
                `Cannot set status to "${newStatus}": no ${targetRole} participates in this ticket`
            );
        }
    }

    /**
     * Validate status transition
     *
     * Basic implementation - can be extended with state machine rules
     */
    private validateStatusTransition(from: TicketStatus, to: TicketStatus): void {
        // Allow any transition for now
        // Can add strict state machine rules here if needed
        if (from === to) {
            throw createAppError(ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION, 400, 'Status is already set to this value');
        }
    }
}
