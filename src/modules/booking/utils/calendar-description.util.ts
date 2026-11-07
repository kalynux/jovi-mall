/**
 * The text of a booking's Google Calendar event — one place, so every path that
 * writes or rewrites an event says the same thing.
 *
 * WHY A HELPER: the description was hand-built at four sites and only one of
 * them (instant `createBooking`) carried the customer's note. Confirming a
 * manual booking, rescheduling, and every capacity (group) slot wrote it without
 * the note — so the vendor never saw "I have very long hair" in their calendar
 * for most bookings.
 */

/** The customer's free-text note (`metadata.notes`), or `null` when there is none. */
export function customerNote(metadata: unknown): string | null {
  const notes = (metadata as { notes?: unknown } | null | undefined)?.notes;
  if (typeof notes !== 'string') return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface BookingEventFacts {
  email: string | null | undefined;
  bookingNumber: string | null | undefined;
  /** Fallback handle for bookings from before `bookingNumber` existed. */
  bookingId: unknown;
  /** Amount as stored (5000 = 5 000 XAF). Omitted when it shouldn't be shown. */
  priceSnapshot?: number;
  currency?: string | null;
  metadata?: unknown;
  /** First line. Defaults to "Booked by". */
  lead?: string;
}

/** Description for a single-customer event. */
export function bookingEventDescription(facts: BookingEventFacts): string {
  const lines = [`${facts.lead ?? 'Booked by'} ${facts.email || 'Unknown'}`];
  if (typeof facts.priceSnapshot === 'number') {
    lines.push(`Price: ${facts.priceSnapshot} ${facts.currency || 'XAF'}`);
  }
  lines.push(`Booking #${facts.bookingNumber ?? String(facts.bookingId)}`);
  const note = customerNote(facts.metadata);
  if (note) lines.push(`Notes: ${note}`);
  return lines.join('\n');
}

export interface CapacitySeat {
  email: string | null | undefined;
  bookingNumber: string | null | undefined;
  bookingId: unknown;
  metadata?: unknown;
}

/**
 * Description for a capacity slot's SHARED event — one event for the whole
 * class, so each seat is listed with its own note.
 */
export function capacityEventDescription(
  seats: number,
  maxBookings: number,
  attendees: CapacitySeat[],
): string {
  const lines = [`Capacity booking — ${seats}/${maxBookings} seats filled`];
  if (attendees.length > 0) {
    lines.push('', 'Customers:');
    for (const a of attendees) {
      const handle = a.bookingNumber ?? String(a.bookingId);
      const note = customerNote(a.metadata);
      lines.push(`• ${a.email || 'Unknown'} (#${handle})${note ? ` — Notes: ${note}` : ''}`);
    }
  }
  return lines.join('\n');
}
