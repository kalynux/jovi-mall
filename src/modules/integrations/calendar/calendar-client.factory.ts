import { ICalendarClient } from './interfaces/calendar-client.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ConnectedCalendarAccount } from './google/connected-account.model';
import { GoogleCalendarClient } from './google/google-calendar.client';
import { VendorModel } from "../../vendors/vendor.model";

export class CalendarClientFactory {
  /**
   * Creates a calendar client for the specified user.
   * Throws CalendarNotConnectedError if no account is connected.
   */
  static async forUser(userId: string): Promise<ICalendarClient> {
    const account = await ConnectedCalendarAccount.findOne({
      userId,
    });

    if (!account) {
      throw createAppError(
        ERROR_CODES.GOOGLE_CALENDAR_NOT_CONNECTED,
        400,
        `User ${userId} has not connected a calendar`
      );
    }

    // Switch by provider
    if (account.provider === 'google') {
      return new GoogleCalendarClient(account);
    }

    throw createAppError(
      ERROR_CODES.INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER,
      400,
      `Unsupported calendar provider: ${account.provider}`
    );
  }

  /**
   * Creates a calendar client for the specified vendor.
   * Optimized path that avoids fetching the Vendor record.
   * Throws CalendarNotConnectedError if no account is connected.
   */
  // static async forVendor(vendorId: string): Promise<ICalendarClient> {
  //   const account = await ConnectedCalendarAccount.findOne({
  //     vendorId,
  //   });

  //   if (!account) {
  //     throw new CalendarNotConnectedError(`Vendor ${vendorId} has not connected a calendar`);
  //   }

  //   // Switch by provider
  //   if (account.provider === 'google') {
  //     return new GoogleCalendarClient(account);
  //   }

  //   throw new Error(`Unsupported calendar provider: ${account.provider}`);
  // }

  static async forVendor(vendorId: string): Promise<ICalendarClient> {
    let account = await ConnectedCalendarAccount.findOne({ vendorId });

    if (!account) {
      // Fallback: lookup via vendor → userId
      const vendor = await VendorModel.findById(vendorId);
      if (vendor) {
        account = await ConnectedCalendarAccount.findOne({ userId: vendor.user_id });
        if (account && !account.vendorId) {
          // Backfill vendorId
          account.vendorId = vendor._id;
          await account.save();
        }
      }
    }

    if (!account) {
      throw createAppError(
        ERROR_CODES.GOOGLE_CALENDAR_NOT_CONNECTED,
        400,
        `Vendor ${vendorId} has not connected a calendar`
      );
    }
    return new GoogleCalendarClient(account);
  }
}
