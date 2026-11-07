import { CONNECTION_CHANNELS } from '../../channel-connections';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import type { GeoCandidate } from '../../../core/geocoding';
import type { PendingQuestionOwner } from '../domain/bot-pending-question';

/**
 * ⭐ **WHERE AN APPOINTMENT SHOULD HAPPEN, WHILE THE CUSTOMER IS STILL TELLING US** (2026-10-27).
 *
 * A service the provider travels to needs the customer's address, and the chat asks for it BEFORE
 * the time picker opens (owner decision A-4). The answer takes several messages — an address
 * typed or a location shared, a map match tapped, maybe a town, then a description — so the step
 * has to be remembered between them. It is remembered HERE, per account + channel (the
 * `bot-pending-question` scope), and `/identity/sync` reports it as `bookingAddress`, which is
 * how the automation layer knows to send the next message to `/bookings/address-step` rather than
 * to the assistant. n8n holds no state of its own about it.
 *
 * ⚠ **Fifteen minutes, and any other tap or command ends it.** A step that outlived the
 * conversation it belonged to would read the customer's next unrelated question as an address
 * and geocode it — the onboarding address step's known weakness, not repeated here.
 *
 * ⚠ **A chosen map match is stored as the CANDIDATE, not its handle.** The handle is single-use
 * and is spent on the tap that chose it; keeping the candidate lets the description arrive a
 * message later without a second, already-spent handle. The coordinates in it never leave this
 * service.
 */
export const BOOKING_ADDRESS_STEP_TTL_SECONDS = 15 * 60;

export type BookingAddressStage = 'address' | 'city' | 'description';

export interface BookingAddressStep {
    productId: string;
    stage: BookingAddressStage;
    /** The last text typed at the `address` stage — what "Use what I typed" keeps. */
    typed: string | null;
    /** The town given for a typed address that matched nothing on the map. */
    city: string | null;
    /** The map match the customer chose (or the pin they confirmed). Null for a typed address. */
    candidate: { candidate: GeoCandidate; rawInput: string | null } | null;
    /** ISO. */
    startedAt: string;
}

const keyFor = (owner: PendingQuestionOwner): string => `bot:bkadr:${owner.userId}:${owner.channel}`;

export class BookingAddressStepStore {
    async start(owner: PendingQuestionOwner, productId: string, now: Date = new Date()): Promise<BookingAddressStep> {
        const step: BookingAddressStep = {
            productId,
            stage: 'address',
            typed: null,
            city: null,
            candidate: null,
            startedAt: now.toISOString(),
        };
        await this.save(owner, step);
        return step;
    }

    /** Overwrites the step and restarts its fifteen minutes — every answer keeps it alive. */
    async save(owner: PendingQuestionOwner, step: BookingAddressStep): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.set(keyFor(owner), JSON.stringify(step), { EX: BOOKING_ADDRESS_STEP_TTL_SECONDS });
    }

    async peek(owner: PendingQuestionOwner): Promise<BookingAddressStep | null> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        const raw = await redis.get(keyFor(owner));
        if (!raw) return null;
        try {
            const step = JSON.parse(raw) as BookingAddressStep;
            return typeof step?.productId === 'string' && typeof step?.stage === 'string' ? step : null;
        } catch {
            // A key we wrote that we cannot read is our bug; treat it as no step at all.
            console.error('[BotSurface] malformed booking address step');
            return null;
        }
    }

    async clear(owner: PendingQuestionOwner): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(keyFor(owner));
    }

    /** Every chat of one account — the administrator's memory reset. */
    async clearForUser(userId: string): Promise<void> {
        const redis = await getRedisClient(BOT_SURFACE_DB);
        await redis.del(CONNECTION_CHANNELS.map((channel) => keyFor({ userId, channel })));
    }
}

export const bookingAddressStepStore = new BookingAddressStepStore();
