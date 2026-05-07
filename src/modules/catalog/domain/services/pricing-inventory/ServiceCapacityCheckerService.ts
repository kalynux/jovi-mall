import { IAvailabilityRepository } from '../../../repositories/interfaces/availability.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

/**
 * ServiceCapacityCheckerService: Ensure service bookings don't exceed capacity
 * 
 * Integration: Works through StockReservationService
 * 
 * Business Rules:
 * - ServiceAvailability has maxBookings or capacity
 * - Track current bookings (active + committed reservations)
 * - Prevent overbooking during reservation
 */
export class ServiceCapacityCheckerService {
  constructor(
    private readonly availabilityRepository: IAvailabilityRepository,
    private readonly reservationRepository: IStockReservationRepository
  ) { }

  /**
   * Check if service slot can accommodate additional bookings
   * 
   * NOTE: Simplified version - full implementation would:
   * 1. Load specific time slot
   * 2. Check maxBookings field on availability
   * 3. Count active reservations for that slot
   */
  async canReserve(
    availabilitySlotId: string,
    requestedQuantity: number,
    session?: any
  ): Promise<void> {
    // Load availability slot
    const slot = await this.availabilityRepository.findById(availabilitySlotId, { session });

    if (!slot) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Availability slot not found');
    }

    // Simplified: Always allow (no maxBookings enforcement in current schema)
    // Full implementation would check slot.maxBookings here
  }
}
