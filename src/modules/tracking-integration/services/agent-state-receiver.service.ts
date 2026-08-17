import { logger } from '../../../core/logging';
import { getGeocodingProvider, getGeocodingProviderType } from '../../../core/geocoding';
import { IGeoPoint } from '../../../core/types/geo.types';
import {
    AgentTrackingStateStatus,
    IAgentLastKnownPlace,
    IDeliveryAgent,
} from '../../agents/models/agent.model';
import { AgentRepository, agentRepository } from '../../agents/repositories/agent.repository';
import {
    AgentTrackingPolicyService,
    agentTrackingPolicyService,
} from '../../agents/domain/services/agent-tracking-policy.service';

/**
 * geo-tracker telling jovi-mall that an agent's tracking state changed.
 *
 * This is the **inbound half of the reverse channel** — the mirror of the outbox that
 * pushes shipment lifecycle events the other way. geo-tracker owns live tracking; this
 * keeps `DeliveryAgent.last_known_tracking_state` as a coarse business mirror so
 * operational screens can say "last seen near X, four hours ago" without a synchronous
 * cross-service call and without a door into geo-tracker.
 *
 * ── ⚠ This receiver did not exist, and nothing said so ───────────────────────
 * geo-tracker has been POSTing these since the tracking lifecycle shipped, to
 * `TRACKING_STATE_NOTIFY_PATH` (default `/api/tracking/agent-state`). jovi-mall served
 * no such path: `/api/tracking` had exactly one route, `visible-agents`. A receiver WAS
 * built — at `POST /api/internal/agents/:agentId/tracking-state` — and the notifier has
 * never called it. Delivery is best-effort by design, so every notification since has
 * been logged as a failure and dropped, and `last_known_tracking_state` has been the
 * schema default (`status: 'unknown'`, `last_position: null`) on every agent in the
 * database. The internal route stays; this one is the address that was advertised.
 *
 * ── What it deliberately does not do ─────────────────────────────────────────
 * **No `eventId` dedup store**, and that is a decision rather than an omission. Applying
 * a notification is a `$set` of the same three fields to the same three values, so a
 * redelivery is a no-op by construction — a dedup table would be a second store to keep
 * correct in order to prevent nothing. What a duplicate genuinely CAN do is arrive out of
 * order and overwrite a newer state with an older one, and that is guarded on the
 * timestamp instead, which also handles the case dedup misses entirely: two DIFFERENT
 * events delivered in the wrong sequence.
 */

/**
 * geo-tracker's nine lifecycle states, mapped onto the four this side stores.
 *
 * The two vocabularies are deliberately not the same size. geo-tracker distinguishes
 * `network_lost` from `location_disabled` because it acts differently on each; jovi-mall
 * only ever asks "is this mirror worth reading", so those collapse. Anything unrecognised
 * becomes `unknown` rather than being coerced to a live-looking value — a state added
 * upstream must not silently read as `streaming` here.
 *
 * `stale` is absent on purpose: nothing writes it. It is derived on READ by
 * `effectiveTrackingStateStatus`, because staleness is a function of the clock and a
 * stored `streaming` becomes a lie the moment the process stops writing.
 */
const STATE_MAP: Readonly<Record<string, AgentTrackingStateStatus>> = Object.freeze({
    online: 'streaming',
    degraded: 'streaming',
    app_foreground: 'streaming',
    app_background: 'streaming',
    offline: 'disconnected',
    disconnected: 'disconnected',
    network_lost: 'disconnected',
    location_disabled: 'disconnected',
    tracking_disabled: 'disconnected',
});

/**
 * How much a position must move before it is worth naming again.
 *
 * Four decimal places is roughly 11 metres at the equator. Below that the reverse
 * geocoder returns the same street for the same money, so the comparison is what makes
 * "resolved once per position" true rather than "resolved once per notification".
 */
const PLACE_PRECISION = 4;

/** The notification body, as `api-doc/tracking-notifications.md` publishes it. */
export interface AgentStateNotification {
    eventId: string;
    agentId: string;
    previousState: string;
    state: string;
    trigger: string;
    reason?: string;
    occurredAt: Date;
    position?: {
        latitude: number;
        longitude: number;
        recordedAt: Date;
    } | null;
}

export type AgentStateOutcome = 'applied' | 'ignored_stale' | 'unknown_agent';

export class AgentStateReceiverService {
    constructor(
        private readonly agents: AgentRepository = agentRepository,
        private readonly tracking: AgentTrackingPolicyService = agentTrackingPolicyService,
    ) { }

    async receive(notification: AgentStateNotification): Promise<AgentStateOutcome> {
        const agent = await this.agents.findById(notification.agentId);

        /**
         * A 200, not a 404. geo-tracker treats any non-2xx as a dropped delivery and does
         * not retry, so answering 404 for an agent this service no longer has would put a
         * permanent error line in its logs for a condition nobody can fix. The outcome is
         * reported in the body instead.
         */
        if (!agent) {
            logger().warn({ agentId: notification.agentId }, 'tracking-state notification for unknown agent');
            return 'unknown_agent';
        }

        /**
         * Out-of-order guard, and the reason it is a timestamp rather than an event id.
         *
         * geo-tracker's notifier is an async best-effort queue, and a multi-instance
         * deployment has several of them. Two transitions can be delivered in the wrong
         * sequence, at which point the older one's `disconnected` would overwrite the
         * newer one's `streaming` and the mirror would claim an agent is offline while
         * they are streaming. Dedup on `eventId` would not catch that at all: the two
         * events are genuinely different.
         *
         * `>=` rather than `>`, so a redelivery of the newest event is still applied —
         * it writes identical values, and refusing it would mean a lost first delivery
         * could never be repaired by a retry.
         */
        const previous = agent.last_known_tracking_state?.last_reported_at;
        if (previous && notification.occurredAt.getTime() < new Date(previous).getTime()) {
            logger().debug(
                { agentId: notification.agentId, eventId: notification.eventId },
                'tracking-state notification older than the stored state — ignored',
            );
            return 'ignored_stale';
        }

        const position = toGeoPoint(notification.position);
        const place = await this.resolvePlace(agent, position);

        await this.tracking.recordTrackingState(notification.agentId, {
            status: STATE_MAP[notification.state] ?? 'unknown',
            // `undefined` when the notification carries no position — "leave the mirror's
            // coordinates alone", never "clear them". Where somebody was last seen does
            // not stop being true because they went offline, and going offline is
            // precisely the transition that arrives without a fix.
            position,
            place,
            reportedAt: notification.position?.recordedAt ?? notification.occurredAt,
            source: 'geo_tracker',
        });

        return 'applied';
    }

    /**
     * Name the position, but only when naming it would say something new.
     *
     * Three ways out, in order of how often they are taken:
     *
     *  1. **No new position** → `undefined`, leaving whatever is stored. The common case.
     *  2. **The position has not meaningfully moved** → carry the stored name forward.
     *     This is what keeps the geocoder call "once per position" rather than "once per
     *     notification" for an agent flapping between online and network_lost at a
     *     junction.
     *  3. **It moved** → one reverse-geocode.
     *
     * ⚠ **Resolution failure is never fatal.** A place is a nicety; the position and the
     * state are the payload. A geocoding provider being down, rate-limited or
     * unconfigured must not cost jovi-mall the state change — so this returns `null`
     * (clearing a name that no longer matches the new coordinates) and the write proceeds.
     */
    private async resolvePlace(
        agent: IDeliveryAgent,
        position: IGeoPoint | null | undefined,
    ): Promise<IAgentLastKnownPlace | null | undefined> {
        if (position === undefined) return undefined;
        if (position === null) return null;

        const stored = agent.last_known_tracking_state?.last_position;
        const storedPlace = agent.last_known_tracking_state?.last_place ?? null;
        if (storedPlace && stored && sameApproximatePoint(stored, position)) {
            return storedPlace;
        }

        const [longitude, latitude] = position.coordinates;

        try {
            const candidate = await getGeocodingProvider().reverse(latitude, longitude);
            if (!candidate) return null;

            return {
                label: candidate.formatted_address,
                // The provider name, not a literal: `GEO_PROVIDER` is configurable and a
                // hardcoded `'nominatim'` would become a lie on the day somebody changes
                // it. Readers render this raw — it is an open string, not an enum.
                source: `reverse_geocode:${getGeocodingProviderType()}`,
                resolved_at: new Date(),
            };
        } catch (error) {
            logger().warn({ err: error }, 'reverse geocode failed for a tracking-state notification');
            return null;
        }
    }
}

/**
 * The wire's `{latitude, longitude}` to the storage layer's GeoJSON `[lng, lat]`.
 *
 * ⚠ **This is the one place the inversion happens**, and it is why the notification
 * carries named fields rather than a pair. A `[9.7043, 4.0511]` crossing a service
 * boundary is read as lat-first by the first person to look at it, and the pin lands in
 * the wrong hemisphere with nothing to catch it.
 */
function toGeoPoint(
    position: AgentStateNotification['position'],
): IGeoPoint | null | undefined {
    if (position === undefined) return undefined;
    if (position === null) return null;
    return { type: 'Point', coordinates: [position.longitude, position.latitude] };
}

/** Same spot to within ~11 m — see `PLACE_PRECISION`. */
function sameApproximatePoint(a: IGeoPoint, b: IGeoPoint): boolean {
    const round = (n: number): number => Number(n.toFixed(PLACE_PRECISION));
    return (
        round(a.coordinates[0]) === round(b.coordinates[0]) &&
        round(a.coordinates[1]) === round(b.coordinates[1])
    );
}

export const agentStateReceiverService = new AgentStateReceiverService();
