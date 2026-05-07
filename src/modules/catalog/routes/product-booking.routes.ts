import { Router, Request, Response, NextFunction } from 'express';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { ProductBookingService } from '../domain/services/booking/ProductBookingService';
import { SlotLockFacade } from '../domain/services/booking/SlotLockFacade';
import { AvailabilityService } from '../../booking/services/availability.service';
import { SlotGeneratorService } from '../../booking/services/slot-generator.service';
import { BookingService } from '../../booking/services/booking.service';
import { BookingPriceResolver } from '../domain/services/booking/BookingPriceResolver';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

const router = Router();

// Initialize services
const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();
const availabilityService = new AvailabilityService();
const slotGenerator = new SlotGeneratorService();
const bookingService = new BookingService();
const priceResolver = new BookingPriceResolver(variantRepository);
const slotLockFacade = new SlotLockFacade();

const productBookingService = new ProductBookingService(
  productRepository,
  availabilityService,
  slotGenerator,
  bookingService,
  priceResolver
);

/**
 * GET /api/products/:productId/availability
 * 
 * Get available booking slots for a service product
 * Query params: fromDate (ISO string), toDate (ISO string)
 */
router.get('/:productId/availability', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    res.json({ slots });
  } catch (error: any) {
    if (error.name === 'ValidationError') {
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, error.message));
    }

    console.error('Error fetching availability:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to fetch availability'));
  }
}));

/**
 * POST /api/products/:productId/slots/:slotId/lock
 * 
 * Lock a slot for booking (requires authentication)
 */
router.post('/:productId/slots/:slotId/lock', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slotId } = req.params;
    const userId = req.auth?.user?.id;

    if (!userId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User not authenticated'));
    }

    const locked = await slotLockFacade.lockSlot(slotId, userId);

    if (!locked) {
      return next(createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 409, 'This slot is already locked by another user'));
    }

    // Calculate expiration time (15 minutes from now)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    res.json({
      locked: true,
      slotId,
      expiresAt,
    });
  } catch (error) {
    console.error('Error locking slot:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to lock slot'));
  }
}));

/**
 * POST /api/products/:productId/book
 * 
 * Book a service product (requires authentication)
 * Body: { slotId, metadata? }
 */
router.post('/:productId/book', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
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
      booking: result.booking,
      price: result.price,
    });
  } catch (error: any) {
    if (error.name === 'ValidationError') {
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, error.message));
    }

    if (error.message?.includes('not locked')) {
      return next(createAppError(ERROR_CODES.BOOKING_SLOT_NOT_LOCKED, 409, 'Slot must be locked before booking'));
    }

    if (error.message?.includes('locked by another')) {
      return next(createAppError(ERROR_CODES.BOOKING_FORBIDDEN, 409, 'Slot is locked by another user'));
    }

    console.error('Error creating booking:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to create booking'));
  }
}));

/**
 * POST /api/products/:productId/slots/:slotId/unlock
 * 
 * Release a slot lock (requires authentication)
 */
router.post('/:productId/slots/:slotId/unlock', requireAuth, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { slotId } = req.params;
    
    const userId = req.auth?.user?.id;

    if (!userId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'User not authenticated'));
    }

    const released = await slotLockFacade.releaseSlot(slotId, userId);

    res.json({
      released,
      slotId,
    });
  } catch (error) {
    console.error('Error releasing slot lock:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to release slot lock'));
  }
}));

export const productBookingRouter = router;
