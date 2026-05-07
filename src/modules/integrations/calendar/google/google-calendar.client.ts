import { google, Auth } from 'googleapis';
import {
  ICalendarClient,
  CalendarEvent,
  CalendarEventInput,
  BusySlot,
  CalendarProviderCapabilities,
  CreateEventOptions,
} from '../interfaces/calendar-client.interface';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IConnectedCalendarAccount } from './connected-account.model';
import { ConnectedCalendarAccount } from './connected-account.model';
import { GoogleTokenVault } from './google-token.vault';
import { GoogleCalendarMapper } from './google-calendar.mapper';

export class GoogleCalendarClient implements ICalendarClient {
  private vault: GoogleTokenVault;
  private account: IConnectedCalendarAccount;

  constructor(account: IConnectedCalendarAccount) {
    this.vault = new GoogleTokenVault();
    this.account = account;
  }

  getCapabilities(): CalendarProviderCapabilities {
    return {
      supportsFreeBusy: true,
      supportsExtendedMetadata: true,
    };
  }

  async listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    return this.execute(async (client) => {
      const calendar = google.calendar({ version: 'v3', auth: client });
      const response = await calendar.events.list({
        calendarId: this.account.calendarId,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      return (response.data.items || []).map((item) => GoogleCalendarMapper.toDomain(item));
    });
  }

  async getEvent(externalId: string): Promise<CalendarEvent | null> {
    return this.execute(async (client) => {
      try {
        const calendar = google.calendar({ version: 'v3', auth: client });
        const response = await calendar.events.get({
          calendarId: this.account.calendarId,
          eventId: externalId,
        });

        return GoogleCalendarMapper.toDomain(response.data);
      } catch (error: any) {
        if (error.code === 404) {
          return null;
        }
        throw error;
      }
    });
  }

  async createEvent(
    input: CalendarEventInput,
    options?: CreateEventOptions
  ): Promise<CalendarEvent> {
    return this.execute(async (client) => {
      const calendar = google.calendar({ version: 'v3', auth: client });
      const gEvent = GoogleCalendarMapper.toGoogleInput(input, options?.idempotencyKey);

      const response = await calendar.events.insert({
        calendarId: this.account.calendarId,
        requestBody: gEvent,
      });

      if (!response.data) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 502, 'No response data from Google Calendar');
      }

      return GoogleCalendarMapper.toDomain(response.data);
    });
  }

  async updateEvent(externalId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.execute(async (client) => {
      const calendar = google.calendar({ version: 'v3', auth: client });
      const gEvent = GoogleCalendarMapper.toGoogleInput(input);

      const response = await calendar.events.update({
        calendarId: this.account.calendarId,
        eventId: externalId,
        requestBody: gEvent,
      });

      if (!response.data) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 502, 'No response data from Google Calendar');
      }

      return GoogleCalendarMapper.toDomain(response.data);
    });
  }

  async deleteEvent(externalId: string): Promise<void> {
    return this.execute(async (client) => {
      try {
        const calendar = google.calendar({ version: 'v3', auth: client });
        await calendar.events.delete({
          calendarId: this.account.calendarId,
          eventId: externalId,
        });
      } catch (error: any) {
        // Safe to call if event doesn't exist
        if (error.code === 404 || error.code === 410) {
          return;
        }
        throw error;
      }
    });
  }

  async getBusySlots(from: Date, to: Date): Promise<BusySlot[]> {
    return this.execute(async (client) => {
      const calendar = google.calendar({ version: 'v3', auth: client });
      const response = await calendar.freebusy.query({
        requestBody: {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: [{ id: this.account.calendarId }],
        },
      });

      const calendars = response.data.calendars || {};
      const calendarData = calendars[this.account.calendarId];

      if (!calendarData?.busy) {
        return [];
      }

      return calendarData.busy.map((slot) => ({
        start: new Date(slot.start!),
        end: new Date(slot.end!),
      }));
    });
  }

  /**
   * Central execution method that handles:
   * - Token refresh
   * - Error normalization
   * - Token persistence
   */
  private async execute<T>(operation: (client: Auth.OAuth2Client) => Promise<T>): Promise<T> {
    try {
      const client = await this.getAuthenticatedClient();
      return await operation(client);
    } catch (error: any) {
      throw this.normalizeError(error);
    }
  }

  /**
   * Creates an authenticated OAuth2 client, handling token refresh automatically.
   */
  private async getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
    const clientId = process.env.GOOGLE_CLIENT_ID || "822716717666-5i8g21sbvl9pk02cu703vjgoln7i67hv.apps.googleusercontent.com";
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "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";
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/integrations/google/callback";

    if (!clientId || !clientSecret || !redirectUri) {
      throw createAppError(ERROR_CODES.GOOGLE_MISSING_CLIENT_ID, 500, 'Google Calendar credentials not configured');
    }

    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    const accessToken = this.vault.decrypt(this.account.accessToken);
    const refreshToken = this.vault.decrypt(this.account.refreshToken);

    client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: this.account.expiresAt.getTime(),
      scope: this.account.scope,
      token_type: 'Bearer',
    });

    // Set up token refresh listener
    client.on('tokens', async (tokens: Auth.Credentials) => {
      try {
        const update: any = {};

        if (tokens.access_token) {
          update.accessToken = this.vault.encrypt(tokens.access_token);
        }

        if (tokens.refresh_token) {
          update.refreshToken = this.vault.encrypt(tokens.refresh_token);
        }

        if (tokens.expiry_date) {
          update.expiresAt = new Date(tokens.expiry_date);
        }

        if (Object.keys(update).length > 0) {
          await ConnectedCalendarAccount.updateOne({ _id: this.account._id }, { $set: update });

          // Update instance
          if (tokens.access_token) this.account.accessToken = update.accessToken;
          if (tokens.refresh_token) this.account.refreshToken = update.refreshToken;
          if (tokens.expiry_date) this.account.expiresAt = update.expiresAt;
        }
      } catch (err) {
        console.error('Failed to persist refreshed tokens', err);
      }
    });

    return client;
  }

  /**
   * Normalizes Google API errors into domain errors.
   */
  private normalizeError(error: any): Error {
    const code = error.code || error.response?.status;
    const message = error.message || 'Unknown error';

    // Conflict errors
    if (code === 409 || code === 412) {
      return createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 409, message);
    }

    // Permission errors
    if (code === 401 || code === 403) {
      return createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 403, message);
    }

    // Auth expired (invalid_grant from refresh token)
    if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
      return createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 401, message);
    }

    // Generic provider error
    return createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 502, message, { originalCode: code, data: error.response?.data?.error?.message });
  }
}
