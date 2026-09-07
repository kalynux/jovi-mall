import { Router, Request, Response, NextFunction } from 'express';
import { productBookingService } from '../domain/services/booking/product-booking.instance';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

const router = Router();

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
 * Body: { slotId, metadata? }
 */
router.post('/:productId/book', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const { productId } = req.params;
  const { slotId, metadata } = req.body;

  const userId = req.auth?.user?.id;

  if (!userId) {
    return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User not authenticated'));
  }

  if (!slotId) {
    return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'slotId is required in request body'));
  }

  const result = await productBookingService.bookProduct(
    productId,
    slotId,
    userId,
    userId, // lockOwnerId is same as userId
    metadata
  );

  res.status(201).json({
    success: true,
    data: {
      booking: result.booking,
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
