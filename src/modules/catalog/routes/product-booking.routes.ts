import { Router, Request, Response } from 'express';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { ProductBookingService } from '../domain/services/booking/ProductBookingService';
import { SlotLockFacade } from '../domain/services/booking/SlotLockFacade';
import { AvailabilityService } from '../../booking/services/availability.service';
import { SlotGeneratorService } from '../../booking/services/slot-generator.service';
import { BookingService } from '../../booking/services/booking.service';
import { BookingPriceResolver } from '../domain/services/booking/BookingPriceResolver';
import { requireAuth } from '../../../api/middlewares/auth.middleware';

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
router.get('/:productId/availability', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'fromDate and toDate query parameters are required',
      });
    }

    const from = new Date(fromDate as string);
    const to = new Date(toDate as string);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Invalid date format. Use ISO 8601 format',
      });
    }

    const slots = await productBookingService.getAvailability(productId, from, to);

    res.json({ slots });
  } catch (error: any) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: error.message,
      });
    }

    console.error('Error fetching availability:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to fetch availability',
    });
  }
});

/**
 * POST /api/products/:productId/slots/:slotId/lock
 * 
 * Lock a slot for booking (requires authentication)
 */
router.post('/:productId/slots/:slotId/lock', requireAuth, async (req: Request, res: Response) => {
  try {
    const { slotId } = req.params;
    // @ts-ignore - userId is set by requireAuth middleware
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not authenticated',
      });
    }

    const locked = await slotLockFacade.lockSlot(slotId, userId);

    if (!locked) {
      return res.status(409).json({
        error: 'SLOT_ALREADY_LOCKED',
        message: 'This slot is already locked by another user',
      });
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
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to lock slot',
    });
  }
});

/**
 * POST /api/products/:productId/book
 * 
 * Book a service product (requires authentication)
 * Body: { slotId, metadata? }
 */
router.post('/:productId/book', requireAuth, async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const { slotId, metadata } = req.body;
    // @ts-ignore - userId is set by requireAuth middleware
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not authenticated',
      });
    }

    if (!slotId) {
      return res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'slotId is required in request body',
      });
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
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: error.message,
      });
    }

    if (error.message?.includes('not locked')) {
      return res.status(409).json({
        error: 'SLOT_NOT_LOCKED',
        message: 'Slot must be locked before booking',
      });
    }

    if (error.message?.includes('locked by another')) {
      return res.status(409).json({
        error: 'SLOT_LOCKED_BY_ANOTHER',
        message: 'Slot is locked by another user',
      });
    }

    console.error('Error creating booking:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create booking',
    });
  }
});

/**
 * POST /api/products/:productId/slots/:slotId/unlock
 * 
 * Release a slot lock (requires authentication)
 */
router.post('/:productId/slots/:slotId/unlock', requireAuth, async (req: Request, res: Response) => {
  try {
    const { slotId } = req.params;
    // @ts-ignore - userId is set by requireAuth middleware
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not authenticated',
      });
    }

    const released = await slotLockFacade.releaseSlot(slotId, userId);

    res.json({
      released,
      slotId,
    });
  } catch (error) {
    console.error('Error releasing slot lock:', error);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to release slot lock',
    });
  }
});

export const productBookingRouter = router;
