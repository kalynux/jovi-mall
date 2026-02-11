import { OrderTimelineModel, IOrderTimeline, IOrderTimelineData, TimelineEventType, TimelineActorType } from './order-timeline.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';

/**
 * Order Timeline Repository
 * 
 * Append-only audit trail operations.
 * 
 * IMMUTABILITY:
 * - No update or delete methods provided
 * - Model enforces immutability at DB level
 */

export interface TimelineEventData {
    orderId: string;
    eventType: TimelineEventType;
    description: string;
    metadata?: Record<string, any>;
    actorType: TimelineActorType;
    actorId?: string | null;
}

export class OrderTimelineRepository {
    /**
     * Append new timeline entry
     * 
     * This is the ONLY way to create timeline entries.
     * No updates or deletes allowed.
     */
    async appendEvent(eventData: TimelineEventData): Promise<IOrderTimeline> {
        const timelineEntry = await OrderTimelineModel.create({
            order_id: eventData.orderId,
            event_type: eventData.eventType,
            description: eventData.description,
            metadata: eventData.metadata || {},
            actor_type: eventData.actorType,
            actor_id: eventData.actorId || null
        });

        return timelineEntry;
    }

    /**
     * Get timeline for order (chronological)
     * 
     * Returns paginated timeline entries as plain objects (lean).
     * Default: newest first (descending created_at)
     */
    async findByOrder(
        orderId: string,
        pagination: PaginationOptions = { page: 1, limit: 20, sort: { created_at: -1 } }
    ): Promise<Page<IOrderTimelineData>> {
        const { page = 1, limit = 20, sort = { created_at: -1 } } = pagination;

        // Enforce hard limit (timeline volume control)
        const enforcedLimit = Math.min(limit, 100);
        const skip = (page - 1) * enforcedLimit;

        const query = { order_id: orderId };

        const [total, entries] = await Promise.all([
            OrderTimelineModel.countDocuments(query),
            OrderTimelineModel
                .find(query)
                .sort(sort)
                .skip(skip)
                .limit(enforcedLimit)
                .lean()
                .exec()
        ]);

        return {
            data: entries,
            meta: {
                total,
                page,
                limit: enforcedLimit,
                pages: Math.ceil(total / enforcedLimit)
            }
        };
    }
}
