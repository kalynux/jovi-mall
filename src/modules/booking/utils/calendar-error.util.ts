import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CalendarNotConnectedError } from '../../integrations/calendar/errors/calendar.errors';

/**
 * Whether a thrown value means "this vendor has no calendar connected".
 *
 * WHY A HELPER: `CalendarClientFactory.forVendor` throws
 * `createAppError(GOOGLE_CALENDAR_NOT_CONNECTED, 400)` — an `AppError` — while
 * the hand-rolled `CalendarNotConnectedError` class is **never thrown anywhere**
 * (only its commented-out predecessor in the factory used it). Code written as
 * `catch (e) { if (e instanceof CalendarNotConnectedError) … }` therefore never
 * matched, and silently took the rethrow branch instead.
 *
 * Both forms are accepted here so the check keeps working if the factory is ever
 * reverted to throwing the typed class.
 */
export function isCalendarNotConnected(error: unknown): boolean {
  if (error instanceof CalendarNotConnectedError) return true;
  return (
    error instanceof AppError &&
    error.code === ERROR_CODES.GOOGLE_CALENDAR_NOT_CONNECTED
  );
}
