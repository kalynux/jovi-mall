import { Router, Request, Response, NextFunction } from 'express';
import { productBookingService } from '../domain/services/booking/product-booking.instance';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { toCustomerBookingShape } from '../../booking/domain/appointment';

const router = Router();

/** The customer's booking note — the same cap as the bot door (`BotBookingCreateSchema.notes`). */
export const BOOKING_NOTES_MAX = 500;

/**
 * ⚠ The seven-dependency assembly that used to sit here moved to
 * `product-booking.instance.ts` when the bot surface needed the same service. Two
 * hand-wired copies is two chances to hand it a differently-configured
 * `AvailabilityService`, which would surface as the two doors disagreeing about when a
 * product is free.
 */

/**
 * GET /api/products/:productId/availability
 * 
 * Get available booking slots for a service product
 * Query params: fromDate (ISO string), toDate (ISO string)
 */
router.get('/:productId/availability', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { productId } = req.params;
  const { fromDate, toDate } = req.query;

  if (!fromDate || !toDate) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'fromDate and toDate query parameters are required'));
  }

  const from = new Date(fromDate as string);
  const to = new Date(toDate as string);

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Invalid date format. Use ISO 8601 format'));
  }

  const slots = await productBookingService.getAvailability(productId, from, to);

  res.json({ success: true, data: { slots } });
}));

/**
 * POST /api/products/:productId/slots/:slotId/lock
 * 
 * Lock a slot for booking (requires authentication)
 */
router.post('/:productId/slots/:slotId/lock', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { slotId } = req.params;
  const userId = req.auth?.user?.id;

  if (!userId) {
    return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User not authenticated'));
  }

  const { productId } = req.params;
  const locked = await productBookingService.lockSlot(productId, slotId, userId);

  if (!locked) {
    return next(createAppError(ERROR_CODES.BOOKING_SLOT_LOCKED, 409, 'This slot is already locked by another user'));
  }

  // Calculate expiration time (15 minutes from now)
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  res.json({
    success: true,
    data: {
      locked: true,
      slotId,
      expiresAt,
    },
  });
}));

/**
 * POST /api/products/:productId/book
 * 
 * Book a service product (requires authentication)
 * Body: { slotId | slotIds, metadata?, addressId? }
 *   slotIds — consecutive slots, each locked by the caller, booked as one appointment from the
 *   first slot's start to the last one's end and priced over the whole interval. Not for a group
 *   class (`422 BOOKING_MULTI_SLOT_NOT_SUPPORTED`).
 *   addressId — one of the customer's saved addresses; REQUIRED when the service happens at the
 *   customer's address (`422 BOOKING_ADDRESS_REQUIRED`), ignored otherwise.
 */
router.post('/:productId/book', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { productId } = req.params;
  const { slotId, metadata } = req.body;
  const addressId = typeof req.body?.addressId === 'string' ? req.body.addressId : null;

  const userId = req.auth?.user?.id;

  if (!userId) {
    return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User not authenticated'));
  }

  /**
   * `slotIds` (2026-10-26): CONSECUTIVE slots booked as ONE appointment, each locked first by the
   * caller. Exactly one of `slotId` / `slotIds` — both at once is ambiguous about which was meant,
   * and an older client sending only `slotId` keeps working unchanged. The run itself (contiguous,
   * every slot offered, the count bounded) is checked by `assertOfferedSlot`.
   */
  const { slotIds } = req.body;
  if (slotIds !== undefined && slotId) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Send slotId or slotIds, not both', { field: 'slotIds' }));
  }
  if (slotIds !== undefined && (
    !Array.isArray(slotIds)
    || slotIds.length === 0
    || !slotIds.every((id: unknown) => typeof id === 'string' && id.length > 0)
  )) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'slotIds must be a non-empty list of slot ids', { field: 'slotIds' }));
  }

  if (!slotId && slotIds === undefined) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'slotId is required in request body'));
  }

  /**
   * The customer's note travels further than the booking row since 2026-10-26: the vendor app,
   * the vendor's Google Calendar event, and a capacity class's SHARED event listing every seat.
   * So it is held to the bot door's rule — a trimmed string, at most 500 characters — and a
   * blank one is dropped rather than stored as "Notes: ".
   */
  if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'metadata must be an object'));
  }
  const cleanMetadata: Record<string, unknown> | undefined = metadata ? { ...metadata } : undefined;
  if (cleanMetadata && 'notes' in cleanMetadata) {
    const notes = cleanMetadata.notes;
    if (notes !== null && notes !== undefined && typeof notes !== 'string') {
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'metadata.notes must be text', { field: 'metadata.notes' }));
    }
    const trimmed = typeof notes === 'string' ? notes.trim() : '';
    if (trimmed.length > BOOKING_NOTES_MAX) {
      return next(createAppError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        `metadata.notes must be at most ${BOOKING_NOTES_MAX} characters`,
        { field: 'metadata.notes', max: BOOKING_NOTES_MAX },
      ));
    }
    if (trimmed.length > 0) cleanMetadata.notes = trimmed;
    else delete cleanMetadata.notes;
  }

  const result = await productBookingService.bookProduct(
    productId,
    (slotIds as string[] | undefined) ?? slotId,
    userId,
    userId, // lockOwnerId is same as userId
    cleanMetadata,
    addressId
  );

  res.status(201).json({
    success: true,
    data: {
      // ⛔ Never the raw document: it carries the meeting link in clear (`access`).
      booking: toCustomerBookingShape(
        result.booking.toJSON() as Record<string, unknown>,
        result.booking as unknown as Parameters<typeof toCustomerBookingShape>[1],
      ),
      price: result.price,
    },
  });
}));

/**
 * POST /api/products/:productId/slots/:slotId/unlock
 * 
 * Release a slot lock (requires authentication)
 */
router.post('/:productId/slots/:slotId/unlock', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { slotId } = req.params;

  const userId = req.auth?.user?.id;

  if (!userId) {
    return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User not authenticated'));
  }

  const { productId } = req.params;
  const released = await productBookingService.unlockSlot(productId, slotId, userId);

  res.json({
    success: true,
    data: {
      released,
      slotId,
    },
  });
}));

export const productBookingRouter = router;
