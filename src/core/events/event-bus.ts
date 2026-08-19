import { logger } from '../logging';
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
 * One registration. The name is carried beside the handler because a failure log that says
 * only "a handler for shipment.assigned threw" names the event, which we already have from
 * the metric, and not the code, which is the only thing an operator can act on.
 */
interface Subscription {
  handler: EventHandler;
  name: string;
}

/**
 * Best-effort identity for a handler, resolved once at subscribe time.
 *
 * `.bind()` — the shape the four notification consumers use — produces a function whose
 * `name` is `bound handleShipmentAssigned`, which is exactly what we want minus the prefix.
 * An arrow passed inline as an argument gets **no** inferred name at all, so those sites
 * pass one explicitly; the positional fallback is what stops a missed site from logging an
 * empty string, not a substitute for naming it.
 */
function resolveHandlerName(handler: EventHandler, explicit: string | undefined, index: number): string {
  if (explicit) return explicit;
  const intrinsic = handler.name.replace(/^bound /, '').trim();
  return intrinsic || `anonymous#${index}`;
}

/**
 * Event Bus Abstraction
 *
 * In-memory event bus with subscriber support.
 *
 * DESIGN NOTE:
 * - Supports subscriber registration pattern
 * - Publishes and handler failures are both metered; failures are logged structurally
 * - Can be upgraded to persisted event store or message queue
 *
 * ⚠ **This bus is lossy by construction** (03-JOVI-MALL R-2 / F-17) and that is a known,
 * deliberate state — see the note at `publish` for which audiences survive a lost event and
 * which do not, and `:publish`'s J8 marker for why the transport is not being replaced yet.
 */
export class EventBus {
  private handlers: Map<string, Subscription[]> = new Map();

  /**
   * Subscribe to an event type
   *
   * @param eventType - Type of event to listen for
   * @param handler - Callback function to execute when event is published
   * @param handlerName - Identity for the failure log. REQUIRED IN PRACTICE for an inline
   *   arrow, which carries no `name` of its own; omit it for a bound method, which does.
   */
  subscribe(eventType: string, handler: EventHandler, handlerName?: string): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    const subscriptions = this.handlers.get(eventType)!;
    const name = resolveHandlerName(handler, handlerName, subscriptions.length);
    subscriptions.push({ handler, name });
    logger().debug({ eventType, handler: name }, 'event bus: handler registered');
  }

  /**
   * Publish a domain event
   *
   * ── WHAT SURVIVES A LOST EVENT, AND WHAT DOES NOT (03-JOVI-MALL R-2) ────────────────
   * A handler that throws is counted, logged and skipped; the event is not retried and is
   * not persisted. Whether that is survivable depends entirely on the audience, and the
   * asymmetry is the actual shape of the risk:
   *
   *   RECOVERABLE — **neither of them is on this bus.** Both money splits are post-commit
   *     calls made directly by their write path, and `EarningsReleaseWorker` sweeps for the
   *     ones that never landed (`recoverMissedCodSplits`, `recoverMissedDeliverySplits`,
   *     idempotent on the allocation's per-source unique index). The tracking outbox left
   *     the bus in Phase 3 (`tracking-integration/services/tracking-outbox.emitter.ts`) for
   *     the same reason, and writes inside the caller's session.
   *
   *   NOT RECOVERABLE — **everything that is left**: the four notification stacks
   *     (vendor · agency · agent · customer), assignment offers, agent plan capacity and
   *     agency onboarding. There is no sweep behind any of them. A handler that throws here
   *     means a notification nobody sends, and nothing anywhere will notice a second time.
   *
   * So the reassurance "the money is fine" is true and does not transfer. Before putting a
   * new consumer on this bus, decide which of the two lists it joins — and if the answer is
   * the second one and the work matters, it wants a sweep of its own rather than a subscription.
   */
  async publish(eventType: string, payload: DomainEvent): Promise<void> {
    // Notify all registered handlers
    const subscriptions = this.handlers.get(eventType) || [];

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
    eventBusPublishedTotal.inc({ event_type: subscriptions.length > 0 ? eventType : 'unhandled' });

    // `debug`, and WITHOUT the payload. The line this replaced was an unconditional
    // `console.log` of `JSON.stringify(payload, null, 2)` on every publish: an arbitrary
    // domain payload printed in full, on a path that carries customer addresses and order
    // contents, at a level that is on in production. The aggregate id is the handle for
    // finding the rest.
    logger().debug(
      { eventType, aggregateId: payload.aggregateId, handlers: subscriptions.length },
      'event bus: publishing',
    );

    for (const { handler, name } of subscriptions) {
      try {
        await handler(payload);
      } catch (error) {
        eventBusHandlerFailuresTotal.inc({ event_type: eventType });
        logger().error(
          { err: error, eventType, handler: name, aggregateId: payload.aggregateId },
          'event bus: handler failed',
        );
        // Continue processing other handlers even if one fails
      }
    }

    // TODO(events, 2026-08-19, J8): no persistence, no retry, no dead-letter queue — and this
    // is DEFERRED ON PURPOSE, not forgotten. See PHASE-4-HARDENING-PLAN.md D-16 and
    // admin/docs/ADR-013 D-2: the obvious next step (a Redis pub/sub hop) would add a SECOND
    // place to lose an event rather than fixing the first, so it is a bandage that reads as a
    // fix. The decision now waits on evidence rather than on argument —
    // `jovi_mall_event_bus_handler_failures_total{event_type}` above is that evidence, and it
    // has never run against real traffic. Revisit trigger: a non-trivial rate on that counter
    // in production, or one lost notification traced to a handler failure. Whoever picks it up
    // owns the durability question end to end (persist → retry → DLQ), not the transport alone.
  }
}

// Singleton instance
export const eventBus = new EventBus();
