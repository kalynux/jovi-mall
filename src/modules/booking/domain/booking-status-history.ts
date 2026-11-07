import { BookingStatus } from '../types/booking.types';

/**
 * Who changed a booking's status, and why — one row per change (ADMIN-BOOKINGS-PLAN § 3).
 *
 * WHY THIS EXISTS: a booking kept `cancelledAt`, `completedAt` and `paidAt` and nothing else, so
 * "the vendor marked me no-show but I came" was one person's word against another's. An
 * administrator settling it needs to see who wrote each status and when — the question an order's
 * timeline answers for orders.
 *
 * Embedded on the booking rather than a collection of its own: a booking moves through at most a
 * handful of statuses, every reader already loads the booking, and nothing queries the history
 * across bookings.
 *
 * ⚠ Bookings written before 2026-10-27 have NO history (pre-production, no backfill). Readers
 * treat an absent or empty array as "not recorded", never as "nothing happened".
 */

export const BOOKING_STATUS_ACTOR_ROLES = ['customer', 'vendor', 'admin', 'system'] as const;
export type BookingStatusActorRole = (typeof BOOKING_STATUS_ACTOR_ROLES)[number];

/** Who is changing the status. `id` is the customer's USER id, the VENDOR id, the wi-admin account id, or null. */
export interface BookingStatusActor {
  role: BookingStatusActorRole;
  id: string | null;
}

export interface IBookingStatusChange {
  /** null on the first row — the booking was created in `to`. */
  from: BookingStatus | null;
  to: BookingStatus;
  at: Date;
  actorRole: BookingStatusActorRole;
  actorId: string | null;
  reason: string | null;
}

/** Longest reason kept on a history row. Longer text is cut, never refused: the change already happened. */
export const STATUS_REASON_MAX = 500;

/** One history row. */
export function statusChange(
  from: BookingStatus | null,
  to: BookingStatus,
  actor: BookingStatusActor,
  reason?: string | null,
  at: Date = new Date(),
): IBookingStatusChange {
  const text = typeof reason === 'string' ? reason.trim().slice(0, STATUS_REASON_MAX) : '';
  return {
    from,
    to,
    at,
    actorRole: actor.role,
    actorId: actor.id ?? null,
    reason: text.length > 0 ? text : null,
  };
}

/**
 * Set a booking's status AND record the change, in memory — the caller saves.
 *
 * Every write path goes through this so the history cannot fall behind the status. Reassigning the
 * array (rather than `push`) keeps it working on a plain object as well as a Mongoose document.
 */
export function applyStatusChange(
  booking: { status: BookingStatus; statusHistory?: IBookingStatusChange[] | null },
  to: BookingStatus,
  actor: BookingStatusActor,
  reason?: string | null,
  at: Date = new Date(),
): IBookingStatusChange {
  const entry = statusChange(booking.status ?? null, to, actor, reason, at);
  booking.status = to;
  booking.statusHistory = [...(booking.statusHistory ?? []), entry];
  return entry;
}
