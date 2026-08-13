import {
  eventBusHandlerFailuresTotal,
  eventBusPublishedTotal,
} from '../../modules/system/metrics/metrics';

/**
 * Domain Event Interface
 * 
 * Represents a significant occurrence in the domain that domain experts care about.
 */
export interface DomainEvent {
  /** Type of event (e.g., 'vendor.profile.updated') */
  eventType: string;
  /** ID of the aggregate root that produced this event */
  aggregateId: string;
  /** Event payload with domain-specific data */
  payload: Record<string, any>;
  /** When the event occurred */
  occurredAt: Date;
}

/**
 * Event Handler Type
 */
type EventHandler = (payload: DomainEvent) => void | Promise<void>;

/**
 * Event Bus Abstraction
 * 
 * In-memory event bus with subscriber support.
 * 
 * DESIGN NOTE:
 * - Supports subscriber registration pattern
 * - Logs events to console for debugging
 * - Can be upgraded to persisted event store or message queue
 * 
 * FUTURE ENHANCEMENTS:
 * - Add event persistence to database
 * - Add integration with message queue (RabbitMQ, Kafka, etc.)
 * - Add retry logic for failed handlers
 * - Add dead letter queue for unprocessable events
 */
export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();

  /**
   * Subscribe to an event type
   * 
   * @param eventType - Type of event to listen for
   * @param handler - Callback function to execute when event is published
   */
  subscribe(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler);
    console.log(`[EventBus] Registered handler for event: ${eventType}`);
  }

  /**
   * Publish a domain event
   * 
   * @param eventType - Type of event (dot notation recommended, e.g., 'vendor.profile.updated')
   * @param payload - Event data conforming to DomainEvent interface
   */
  async publish(eventType: string, payload: DomainEvent): Promise<void> {
    console.log(`[EventBus] Publishing ${eventType}:`, JSON.stringify(payload, null, 2));

    // Notify all registered handlers
    const handlers = this.handlers.get(eventType) || [];

    /**
     * The metric label, bounded by SUBSCRIPTION rather than by an allowlist.
     *
     * `eventType` is a free-form string, so labelling by it directly would be an unbounded
     * label space — the thing `modules/system/domain/route-group.ts` goes to some trouble to
     * avoid on the HTTP side. But there is a natural bound here that needs no maintenance: the
     * set of event types something actually SUBSCRIBES to is finite, fixed at boot, and cannot
     * be grown by a caller. A published event nobody handles collapses to `unhandled` — which
     * is also a genuinely useful signal, since it means somebody is emitting into the void.
     */
    eventBusPublishedTotal.inc({ event_type: handlers.length > 0 ? eventType : 'unhandled' });

    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (error) {
        eventBusHandlerFailuresTotal.inc({ event_type: eventType });
        console.error(`[EventBus] Error in handler for ${eventType}:`, error);
        // Continue processing other handlers even if one fails
      }
    }

    // TODO: Future implementation
    // - Persist event to event store
    // - Trigger webhooks
    // - Send to message queue
  }
}

// Singleton instance
export const eventBus = new EventBus();
