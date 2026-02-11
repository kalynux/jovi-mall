import { StockReservation } from '../mappers/stock-reservation.mapper';
import { RepositoryOptions } from '../types';
import { ReservationStatus } from '../../models/stock-reservation.model';

export interface IStockReservationRepository {
  create(reservation: Omit<StockReservation, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<StockReservation>;

  findByReservationId(reservationId: string, options?: RepositoryOptions): Promise<StockReservation | null>;
  findById(id: string, options?: RepositoryOptions): Promise<StockReservation | null>;

  updateStatus(reservationId: string, status: ReservationStatus, options?: RepositoryOptions): Promise<StockReservation | null>;

  // Cleanup utilities
  findExpired(before: Date, options?: RepositoryOptions): Promise<StockReservation[]>;
  deleteExpired(before: Date, options?: RepositoryOptions): Promise<void>;

  // Query for limits
  countActiveByVariant(variantId: string, options?: RepositoryOptions): Promise<number>;
  countActiveAndCommittedByDigitalAsset(digitalAssetId: string, options?: RepositoryOptions): Promise<number>;

  // Vendor inventory queries
  findByVendor(vendorId: string, filters: { variantId?: string; status?: string }, pagination: { page: number; limit: number }, options?: RepositoryOptions): Promise<StockReservation[]>;
  countByVendor(vendorId: string, filters: { variantId?: string; status?: string }, options?: RepositoryOptions): Promise<number>;
}
