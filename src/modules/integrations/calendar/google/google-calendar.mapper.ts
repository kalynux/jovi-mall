import { calendar_v3 } from 'googleapis';
import { CalendarEvent, CalendarEventInput } from '../interfaces/calendar-client.interface';
import { CALENDAR_COLOR } from '../utils/calendar-event-colors.util';

export class GoogleCalendarMapper {
  /**
   * Converts a Google Calendar event to our domain model.
   * Enforces externalId === gEvent.id
   */
  static toDomain(gEvent: calendar_v3.Schema$Event): CalendarEvent {
    if (!gEvent.id) {
      throw new Error('Google event missing ID');
    }

    if (!gEvent.start?.dateTime || !gEvent.end?.dateTime) {
      throw new Error('Google event missing start/end dateTime');
    }

    // Combine user-defined metadata with Google event metadata
    const metadata: Record<string, string> = {
      ...(gEvent.extendedProperties?.shared || {}),
      // Add Google event metadata for sync purposes
      ...(gEvent.updated && { updated: gEvent.updated }),
      ...(gEvent.status && { status: gEvent.status }),
      ...(gEvent.start.timeZone && { timeZone: gEvent.start.timeZone }),
    };

    return {
      externalId: gEvent.id,
      title: gEvent.summary || 'Untitled Event',
      description: gEvent.description || undefined,
      start: new Date(gEvent.start.dateTime),
      end: new Date(gEvent.end.dateTime),
      location: gEvent.location || undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  /**
   * Converts our domain model to a Google Calendar event input.
   * Maps metadata to extendedProperties.shared
   */
  static toGoogleInput(
    input: CalendarEventInput,
    idempotencyKey?: string
  ): calendar_v3.Schema$Event {
    const gEvent: calendar_v3.Schema$Event = {
      summary: input.title,
      description: input.description,
      start: {
        dateTime: input.start.toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: input.end.toISOString(),
        timeZone: 'UTC',
      },
      location: input.location,
      colorId: input.colorId || CALENDAR_COLOR.DEFAULT,
    };

    // Map metadata to extendedProperties.shared
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      gEvent.extendedProperties = {
        shared: input.metadata,
      };
    }

    return gEvent;
  }
}
