import { TicketModel, ITicket, IAdminAssignment } from '../models/ticket.model';
import { IAdminSnapshot } from '../../../core/types/admin-snapshot.types';
import { TicketStatus, TicketPriority, ActorRole, EntityType, isTerminalStatus } from '../types/ticket.types';
import mongoose from 'mongoose';
import { COLLECTIONS } from '../../../core/database/collections';

/**
 * TicketRepository
 * 
 * Data access layer for tickets with comprehensive filtering and pagination.
 * 
 * FILTERING SUPPORT:
 * - By type, status, priority, importance
 * - By creator ID, assignee ID
 * - By entity type + entity ID (polymorphic)
 *
 * VISIBILITY ENFORCEMENT:
 * - Non-admin queries: See only tickets they follow (enforced at service layer)
 * - There is no admin query here any more. Administrators reach tickets through wi-admin,
 *   which reads this collection directly and folds its own tier scope into the query —
 *   filtering by `admin_assignment` is therefore its job, not this repository's.
 */

export interface TicketFilters {
    type?: string;
    status?: TicketStatus;
    priority?: TicketPriority;
    entity_type?: EntityType;
    entity_id?: string;
    created_by_user_id?: string;
    assigned_to_role?: ActorRole;
    assigned_to_user_id?: string;
}

export interface PaginationOptions {
    page: number;
    limit: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
    data: T[];
    pagination: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    };
}

export class TicketRepository {
    /**
     * Create a new ticket
     */
    async create(ticketData: Partial<ITicket>): Promise<ITicket> {
        const ticket = new TicketModel(ticketData);
        return await ticket.save();
    }

    /**
     * Find ticket by ID
     */
    async findById(ticketId: string): Promise<ITicket | null> {
        return await TicketModel.findById(ticketId);
    }

    /**
     * Find tickets by entity (polymorphic lookup)
     */
    async findByEntity(entityType: EntityType, entityId: string): Promise<ITicket[]> {
        return await TicketModel.find({
            entity_type: entityType,
            entity_id: entityId,
            deletedAt: null
        }).sort({ createdAt: -1 });
    }

    /**
     * Find tickets by assignee
     */
    async findByAssignee(role: ActorRole, userId?: string): Promise<ITicket[]> {
        const filter: any = {
            assigned_to_role: role,
            deletedAt: null
        };

        if (userId) {
            filter.assigned_to_user_id = userId;
        }

        return await TicketModel.find(filter).sort({ createdAt: -1 });
    }

    /**
     * Find tickets by creator
     */
    async findByCreator(userId: string): Promise<ITicket[]> {
        return await TicketModel.find({
            created_by_user_id: userId,
            deletedAt: null
        }).sort({ createdAt: -1 });
    }

    /**
     * Find tickets with filters and pagination
     * 
     * CRITICAL: This method returns RAW tickets without visibility enforcement.
     * Visibility filtering (follower-based access) MUST be enforced at service layer
     * by joining with TicketFollower collection.
     */
    async findWithFilters(
        filters: TicketFilters,
        pagination: PaginationOptions
    ): Promise<PaginatedResult<ITicket>> {
        const query: any = { deletedAt: null };

        // Apply filters
        if (filters.type) query.type = filters.type;
        if (filters.status) query.status = filters.status;
        if (filters.priority) query.priority = filters.priority;
        if (filters.entity_type) query.entity_type = filters.entity_type;
        if (filters.entity_id) query.entity_id = filters.entity_id;
        if (filters.created_by_user_id) query.created_by_user_id = filters.created_by_user_id;
        if (filters.assigned_to_role) query.assigned_to_role = filters.assigned_to_role;
        if (filters.assigned_to_user_id) query.assigned_to_user_id = filters.assigned_to_user_id;

        // Count total matching documents
        const total = await TicketModel.countDocuments(query);

        // Calculate pagination
        const page = pagination.page || 1;
        const limit = pagination.limit || 20;
        const skip = (page - 1) * limit;
        const totalPages = Math.ceil(total / limit);

        // Build sort object
        const sortBy = pagination.sortBy || 'createdAt';
        const sortOrder = pagination.sortOrder === 'asc' ? 1 : -1;
        const sort: any = { [sortBy]: sortOrder };

        // Execute query with pagination
        const data = await TicketModel.find(query)
            .sort(sort)
            .skip(skip)
            .limit(limit);

        return {
            data,
            pagination: {
                total,
                page,
                limit,
                totalPages
            }
        };
    }

    /**
     * Find tickets visible to a specific user
     * 
     * This method joins with TicketFollower to enforce visibility.
     * Admins see all tickets, non-admins see only tickets they follow.
     * 
     * @param userId - User ID to check visibility for
     * @param role - User's role
     * @param filters - Additional filters
     * @param pagination - Pagination options
     */
    async findVisibleToUser(
        userId: string,
        role: ActorRole,
        filters: TicketFilters,
        pagination: PaginationOptions
    ): Promise<PaginatedResult<ITicket>> {
        const matchStage: any = { deletedAt: null };

        // Apply filters
        if (filters.type) matchStage.type = filters.type;
        if (filters.status) matchStage.status = filters.status;
        if (filters.priority) matchStage.priority = filters.priority;
        if (filters.entity_type) matchStage.entity_type = filters.entity_type;
        if (filters.entity_id) matchStage.entity_id = filters.entity_id;
        if (filters.created_by_user_id) matchStage.created_by_user_id = new mongoose.Types.ObjectId(filters.created_by_user_id);
        if (filters.assigned_to_role) matchStage.assigned_to_role = filters.assigned_to_role;
        if (filters.assigned_to_user_id) matchStage.assigned_to_user_id = new mongoose.Types.ObjectId(filters.assigned_to_user_id);

        // Build aggregation pipeline
        const pipeline: any[] = [
            // Join with followers
            {
                $lookup: {
                    from: COLLECTIONS.TICKET_FOLLOWER,
                    localField: '_id',
                    foreignField: 'ticket_id',
                    as: 'followers'
                }
            },
            // Match tickets where user is follower (or admin sees all)
            {
                $match: role === ActorRole.ADMIN
                    ? matchStage
                    : {
                        ...matchStage,
                        'followers.user_id': new mongoose.Types.ObjectId(userId)
                    }
            }
        ];

        // Count total
        const countPipeline = [...pipeline, { $count: 'total' }];
        const countResult = await TicketModel.aggregate(countPipeline);
        const total = countResult.length > 0 ? countResult[0].total : 0;

        // Calculate pagination
        const page = pagination.page || 1;
        const limit = pagination.limit || 20;
        const skip = (page - 1) * limit;
        const totalPages = Math.ceil(total / limit);

        // Build sort object
        const sortBy = pagination.sortBy || 'createdAt';
        const sortOrder = pagination.sortOrder === 'asc' ? 1 : -1;

        // Execute query with pagination and sorting
        const dataPipeline = [
            ...pipeline,
            { $sort: { [sortBy]: sortOrder } },
            { $skip: skip },
            { $limit: limit }
        ];

        const data = await TicketModel.aggregate(dataPipeline);

        return {
            data: data.map(doc => new TicketModel(doc)),
            pagination: {
                total,
                page,
                limit,
                totalPages
            }
        };
    }

    /**
     * Update ticket status
     */
    async updateStatus(ticketId: string, newStatus: TicketStatus, userId: string): Promise<ITicket | null> {
        // Maintain `terminalAt`: stamp it when entering a terminal state, clear it
        // on reopen. This is the stable clock the file-cleanup module reads to
        // decide when a closed ticket's attachments may be detached.
        const update: Record<string, unknown> = {
            status: newStatus,
            $addToSet: { updated_by: userId },
            ...(isTerminalStatus(newStatus)
                ? { terminalAt: new Date() }
                : { terminalAt: null }),
        };

        return await TicketModel.findByIdAndUpdate(ticketId, update, { new: true });
    }

    /**
     * Update ticket priority
     * 
     * @param lock - If true, locks priority forever (admin-only)
     */
    async updatePriority(
        ticketId: string,
        newPriority: TicketPriority,
        userId: string,
        lock: boolean = false
    ): Promise<ITicket | null> {
        const update: any = {
            priority: newPriority,
            $addToSet: { updated_by: userId }
        };

        if (lock) {
            update.priority_locked = true;
            update.priority_locked_by = userId;
            update.priority_locked_at = new Date();
        }

        return await TicketModel.findByIdAndUpdate(ticketId, update, { new: true });
    }

    /**
     * Assign ticket to a platform actor, or to the admin pool (`userId: null`).
     */
    async assign(
        ticketId: string,
        role: ActorRole,
        userId: string | null
    ): Promise<ITicket | null> {
        const update: any = {
            assigned_to_role: role,
            assigned_to_user_id: userId
        };

        return await TicketModel.findByIdAndUpdate(ticketId, update, { new: true });
    }

    /**
     * Add user to updatedBy audit trail
     */
    async addUpdater(ticketId: string, userId: string): Promise<void> {
        await TicketModel.findByIdAndUpdate(ticketId, {
            $addToSet: { updated_by: userId }
        });
    }

    /**
     * Update ticket fields (subject, description)
     */
    async update(ticketId: string, updates: Partial<ITicket>, userId: string): Promise<ITicket | null> {
        return await TicketModel.findByIdAndUpdate(
            ticketId,
            {
                ...updates,
                $addToSet: { updated_by: userId }
            },
            { new: true }
        );
    }

    /**
     * Soft delete ticket
     */
    async softDelete(ticketId: string): Promise<ITicket | null> {
        return await TicketModel.findByIdAndUpdate(
            ticketId,
            { deletedAt: new Date() },
            { new: true }
        );
    }

    /**
     * Set — or clear, with `null` — which wi-admin administrator holds this ticket.
     */
    async setAdminAssignment(
        ticketId: string,
        assignment: IAdminAssignment | null
    ): Promise<ITicket | null> {
        return await TicketModel.findByIdAndUpdate(
            ticketId,
            { admin_assignment: assignment },
            { new: true }
        );
    }

    /**
     * Re-stamp the assignee's profile, and ONLY if it is still that administrator.
     *
     * The id predicate is the whole safety of this method. Without it a refresh racing a
     * reassignment would write the previous holder's profile back over the new one — and
     * because the block also carries `tier`, that is not a cosmetic slip: wi-admin's read
     * scope filters on that field, so the ticket would become visible to the wrong tier.
     * Folding the guard into the query rather than checking first also makes it atomic.
     *
     * `assigned_by` is deliberately untouched: who handed the ticket over is a historical
     * fact, and refreshing a live profile must not rewrite it.
     */
    async refreshAdminSnapshot(ticketId: string, admin: IAdminSnapshot): Promise<ITicket | null> {
        return await TicketModel.findOneAndUpdate(
            { _id: ticketId, 'admin_assignment.admin.id': admin.id },
            { $set: { 'admin_assignment.admin': admin } },
            { new: true }
        );
    }
}
