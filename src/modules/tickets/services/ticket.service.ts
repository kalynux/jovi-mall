import { TicketRepository, TicketFilters, PaginationOptions } from '../repositories/ticket.repository';
import { TicketFollowerService } from './ticket-follower.service';
import { TicketNoteService } from './ticket-note.service';
import { TicketAttachmentService } from './ticket-attachment.service';
import { TicketStatus, TicketPriority, ActorRole, EntityType, TicketImportance, isWaitingStatus, WAITING_STATUS_TARGET_ROLE } from '../types/ticket.types';
import { ITicket } from '../models/ticket.model';
import { IAdminSnapshot } from '../../../core/types/admin-snapshot.types';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { OrderModel } from '../../orders/order.model';
import { Booking } from '../../booking/models/booking.model';
import { ProductModel } from '../../catalog/models/product.model';
import { VendorRepository } from '../../vendors/vendor.repository';
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
    private attachmentService: TicketAttachmentService;
    private vendorRepo: VendorRepository;

    constructor() {
        this.ticketRepo = new TicketRepository();
        this.followerService = new TicketFollowerService();
        this.noteService = new TicketNoteService();
        this.attachmentService = new TicketAttachmentService();
        this.vendorRepo = new VendorRepository();
    }

    /**
     * ============================================
     * ADMIN LOCKING HELPERS (Exclusive Active Admin)
     * ============================================
     */

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
        trackingNumber?: string;
        attachments?: string[];
        createdByUserId: string;
        createdByRole: ActorRole;
        createdByEntityId: string;
        /** Set only when an administrator opened it — see `Ticket.created_by_admin`. */
        createdByAdmin?: IAdminSnapshot | null;
    }): Promise<ITicket> {
        // Polymorphic entity validation → also resolves the vendor behind the entity.
        const vendorId = await this.validateEntityReference(input.entityType, input.entityId);

        // Enforce the vendor's support policy required_info (customer-facing support).
        await this.enforceSupportRequiredInfo(vendorId, input);

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
            tracking_number: input.trackingNumber ?? null,
            created_by_role: input.createdByRole,
            created_by_user_id: new mongoose.Types.ObjectId(input.createdByUserId),
            created_by_admin: input.createdByAdmin ?? null,
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

        // Persist any files supplied at creation time. This is the SAME path the
        // edit flow uses (attachFile), so it creates both the TicketAttachment row
        // and the file_references row that keeps the file out of orphan GC. Skipping
        // it (the old behaviour) silently dropped attachments given on create.
        for (const fileId of input.attachments ?? []) {
            await this.attachmentService.attachFile(
                ticket.id,
                fileId,
                input.createdByUserId,
                input.createdByRole,
                input.createdByEntityId,
                'PUBLIC',
            );
        }

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

        // Create system note
        await this.noteService.createSystemNote(
            ticketId,
            `Status changed from "${oldStatus}" to "${newStatus}"`
        );

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
     * - If targetRole ≠ ADMIN → targetUserId is mandatory
     *
     * ⚠ This assigns to a PLATFORM actor, or to the admin pool. Assigning to a named
     * administrator goes through `assignToAdministrator` instead — administrators live in
     * the wi-admin database and cannot be named by a `users` id here.
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

        // Validate assignment rules
        if (targetRole === ActorRole.ADMIN) {
            // Admin assignment: userId is always null here — the pool. A named administrator
            // is not a `users` id, so `assignToAdministrator` handles that case.
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

        // Perform assignment
        const updatedTicket = await this.ticketRepo.assign(ticketId, targetRole, targetUserId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_ASSIGN_FAILED, 500, ERROR_CODES.TICKET_ASSIGN_FAILED, false);
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
                assignedBy: assignerUserId
            },
            occurredAt: new Date()
        });

        return updatedTicket;
    }

    /**
     * Hand a ticket to a named administrator, or claim it from the pool.
     *
     * ── Why this is not `assignTicket` ────────────────────────────────────────
     * That method assigns to a **platform actor** and names them by a `users` id.
     * Administrators have no `users` row — they live in the wi-admin database — so there is
     * no id here to name them by. What lands instead is a profile SNAPSHOT, because a
     * cross-database join does not exist and every ticket reader would otherwise see a blank
     * where the person handling their ticket should be.
     *
     * ── This service enforces nothing about WHO may do it ─────────────────────
     * The tier rules — who may hold a ticket, who may hand one to whom — are wi-admin's, and
     * are resolved there before this is called, against the administrator records only it
     * has. That is the same single-sided trust `requireAdminCaller` already documents: the
     * service token is a full-privilege credential, so a second opinion computed here would
     * be theatre. What this method owns is that the write is *recorded* correctly.
     *
     * `assignedBy: null` means the ticket was CLAIMED from the pool rather than handed over —
     * a real distinction, since the tier rules key on who assigned it.
     */
    async assignToAdministrator(
        ticketId: string,
        admin: IAdminSnapshot,
        assignedBy: IAdminSnapshot | null
    ): Promise<ITicket> {
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        const updatedTicket = await this.ticketRepo.setAdminAssignment(ticketId, {
            admin,
            assigned_by: assignedBy,
            assigned_at: new Date(),
        });
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_ASSIGN_FAILED, 500, ERROR_CODES.TICKET_ASSIGN_FAILED, false);
        }

        await this.noteService.createSystemNote(
            ticketId,
            assignedBy
                ? `Assigned to ${admin.name} by ${assignedBy.name}`
                : `Claimed by ${admin.name}`
        );

        await eventBus.publish('ticket.assigned', {
            eventType: 'ticket.assigned',
            aggregateId: ticketId,
            payload: {
                ticketId,
                targetRole: ActorRole.ADMIN,
                targetUserId: null,
                administratorId: admin.id,
                assignedBy: assignedBy?.id ?? null
            },
            occurredAt: new Date()
        });

        return updatedTicket;
    }

    /**
     * Re-stamp the assignee's profile from wi-admin's current record.
     *
     * The snapshot is a copy of a row in another database, so it goes stale the moment that
     * row changes — and unlike an audit stamp, this block answers "who is handling my ticket
     * **now**", where a stale answer is simply wrong rather than historical. wi-admin sends
     * the current profile on every delegated write (it has already read the administrator to
     * decide whether the write is allowed), so keeping it fresh costs nothing here.
     *
     * A no-op when the ticket is unassigned or held by somebody else: this refreshes a
     * snapshot, and must never quietly become a way to reassign one.
     */
    async refreshAdminSnapshot(ticketId: string, admin: IAdminSnapshot): Promise<void> {
        await this.ticketRepo.refreshAdminSnapshot(ticketId, admin);
    }

    /**
     * Update ticket priority
     *
     * If requester is admin, priority gets locked forever. Which administrators may change
     * it afterwards is wi-admin's tier decision, not a lock on this row.
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

        // Check if priority is locked. Once an administrator has set it, only an
        // administrator may change it again — which administrator is wi-admin's decision
        // (`resolveScope('tickets')` plus the tier matrix), not a lock on this row.
        if (ticket.priority_locked) {
            if (role !== ActorRole.ADMIN) {
                throw createAppError(ERROR_CODES.TICKET_PRIORITY_LOCKED, 403, 'Priority is locked by admin and cannot be modified');
            }
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

        // Validate only creator or admin can close
        if (role !== ActorRole.ADMIN && ticket.created_by_user_id.toString() !== userId) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only ticket creator or admin can close ticket');
        }

        const updatedTicket = await this.ticketRepo.updateStatus(ticketId, TicketStatus.CLOSED, userId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_CLOSE_FAILED, 500, ERROR_CODES.TICKET_CLOSE_FAILED, false);
        }

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

        if (ticket.status !== TicketStatus.CLOSED) {
            throw createAppError(ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION, 400, 'Only closed tickets can be reopened');
        }

        const updatedTicket = await this.ticketRepo.updateStatus(ticketId, TicketStatus.OPEN, userId);
        if (!updatedTicket) {
            throw new AppError(ERROR_CODES.TICKET_REOPEN_FAILED, 500, ERROR_CODES.TICKET_REOPEN_FAILED, false);
        }

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
    private async validateEntityReference(
        entityType: EntityType,
        entityId: string
    ): Promise<string | null> {
        if (!entityId || !mongoose.Types.ObjectId.isValid(entityId)) {
            throw createAppError(ERROR_CODES.TICKET_ENTITY_NOT_FOUND, 400, 'Invalid entity reference');
        }

        // Resolve the referenced entity, confirm it exists, and return the vendor
        // it belongs to (used to apply that vendor's support policy).
        switch (entityType) {
            case EntityType.ORDER: {
                const order = await OrderModel.findById(entityId).select('vendor_id').lean();
                if (!order) throw createAppError(ERROR_CODES.TICKET_ENTITY_NOT_FOUND, 404, 'Referenced order not found');
                return order.vendor_id?.toString() ?? null;
            }
            case EntityType.BOOKING: {
                const booking = await Booking.findById(entityId).select('vendorId').lean();
                if (!booking) throw createAppError(ERROR_CODES.TICKET_ENTITY_NOT_FOUND, 404, 'Referenced booking not found');
                return booking.vendorId?.toString() ?? null;
            }
            case EntityType.PRODUCT: {
                const product = await ProductModel.findById(entityId).select('vendorId').lean();
                if (!product) throw createAppError(ERROR_CODES.TICKET_ENTITY_NOT_FOUND, 404, 'Referenced product not found');
                return product.vendorId?.toString() ?? null;
            }
            default:
                return null;
        }
    }

    /**
     * Enforce the vendor's support-policy `required_info` on ticket creation.
     *
     * The required_info items are order/delivery/product-centric, so they are
     * only applied to the ticket contexts they make sense for — never to booking
     * or general (`OTHER`) tickets such as a billing/payout question:
     * - `order_number` → satisfied implicitly when the ticket references an ORDER;
     *   not enforced on non-order tickets.
     * - `tracking_number` → a `trackingNumber` is required for ORDER tickets only.
     * - `product_photo_video` → at least one attachment is required for ORDER or
     *   PRODUCT tickets.
     *
     * No-op when the vendor cannot be resolved (e.g. `OTHER` tickets) or the
     * vendor has no support policy. `channels` / `availability` / `languages`
     * stay informational — tickets are their own in-app channel.
     */
    private async enforceSupportRequiredInfo(
        vendorId: string | null,
        input: { entityType: EntityType; trackingNumber?: string; attachments?: string[] }
    ): Promise<void> {
        if (!vendorId) return;

        const vendor = await this.vendorRepo.findById(vendorId);
        const required = vendor?.policies?.support_policy?.required_info ?? [];
        if (required.length === 0) return;

        const isOrder = input.entityType === EntityType.ORDER;
        const isProduct = input.entityType === EntityType.PRODUCT;

        const missing: string[] = [];
        if (required.includes('tracking_number') && isOrder && !input.trackingNumber) {
            missing.push('tracking_number');
        }
        if (
            required.includes('product_photo_video') &&
            (isOrder || isProduct) &&
            (input.attachments?.length ?? 0) === 0
        ) {
            missing.push('product_photo_video');
        }

        if (missing.length > 0) {
            throw createAppError(
                ERROR_CODES.TICKET_REQUIRED_INFO_MISSING,
                400,
                'This vendor requires additional information to open a support ticket',
                { missing }
            );
        }
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

    /**
     * Open a ticket on behalf of the platform (no human creator), e.g. from a
     * Stripe dispute webhook. Uses the configured `SUPPORT_ADMIN_USER_ID` as the
     * admin actor. Best-effort: if that env is unset/invalid this returns null
     * (callers must treat ticket creation as non-fatal) rather than throwing.
     */
    async createSystemTicket(input: {
        type: string;
        entityType: EntityType;
        entityId: string;
        subject: string;
        description: string;
        importance?: TicketImportance;
    }): Promise<ITicket | null> {
        const actorId = process.env.SUPPORT_ADMIN_USER_ID;
        if (!actorId || !mongoose.Types.ObjectId.isValid(actorId)) {
            console.warn('[TicketService] SUPPORT_ADMIN_USER_ID not configured — skipping system ticket creation');
            return null;
        }
        return this.createTicket({
            subject: input.subject,
            description: input.description,
            type: input.type,
            importance: input.importance ?? TicketImportance.HIGH,
            entityType: input.entityType,
            entityId: input.entityId,
            createdByUserId: actorId,
            createdByRole: ActorRole.ADMIN,
            createdByEntityId: actorId,
        });
    }
}

export const ticketService = new TicketService();
