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
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (error) {
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
