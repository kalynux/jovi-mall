export interface CalendarEventInput {
  title: string;
  description?: string;
  start: Date;
  end: Date;
  location?: string;
  metadata?: Record<string, string>;
  colorId?: string; // Google Calendar color ID (1-11)
}

export interface CalendarEvent extends CalendarEventInput {
  externalId: string; // Provider's event ID
}

export interface BusySlot {
  start: Date;
  end: Date;
}

export interface CalendarProviderCapabilities {
  supportsFreeBusy: boolean;
  supportsExtendedMetadata: boolean;
}

export interface CreateEventOptions {
  idempotencyKey?: string;
}

export interface ICalendarClient {
  /**
   * Lists events within a date range.
   */
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>;

  /**
   * Gets a single event by its external ID.
   * Returns null if not found.
   */
  getEvent(externalId: string): Promise<CalendarEvent | null>;

  /**
   * Creates a new calendar event.
   * @param input The event data
   * @param options Optional settings including idempotency key
   */
  createEvent(input: CalendarEventInput, options?: CreateEventOptions): Promise<CalendarEvent>;

  /**
   * Updates an existing event.
   */
  updateEvent(externalId: string, input: CalendarEventInput): Promise<CalendarEvent>;

  /**
   * Deletes an event. Safe to call if event doesn't exist.
   */
  deleteEvent(externalId: string): Promise<void>;

  /**
   * Retrieves busy/free slots for the calendar.
   */
  getBusySlots(from: Date, to: Date): Promise<BusySlot[]>;

  /**
   * Returns the capabilities of this calendar provider.
   */
  getCapabilities(): CalendarProviderCapabilities;
}
