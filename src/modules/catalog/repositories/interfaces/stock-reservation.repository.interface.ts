import { StockReservation } from '../mappers/stock-reservation.mapper';
import { RepositoryOptions } from '../types';
import { ReservationStatus } from '../../models/stock-reservation.model';

export interface IStockReservationRepository {
  create(reservation: Omit<StockReservation, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<StockReservation>;

  findByReservationId(reservationId: string, options?: RepositoryOptions): Promise<StockReservation | null>;
  findById(id: string, options?: RepositoryOptions): Promise<StockReservation | null>;

  updateStatus(reservationId: string, status: ReservationStatus, options?: RepositoryOptions): Promise<StockReservation | null>;

  /**
   * Mark committed AND push the TTL out, in one write.
   *
   * Separate from `updateStatus` because the two fields must move together: the TTL index
   * deletes on `expiresAt` regardless of status, so a committed row left on its original
   * hold window is a completed sale scheduled for deletion.
   */
  commit(reservationId: string, retentionDays: number, options?: RepositoryOptions): Promise<StockReservation | null>;

  // Cleanup utilities
  findExpired(before: Date, options?: RepositoryOptions): Promise<StockReservation[]>;
  deleteExpired(before: Date, options?: RepositoryOptions): Promise<void>;

  // Query for limits
  /**
   * Units (not rows) of a variant currently held mid-checkout — the `activeReservations`
   * term in `available = stock − activeReservations`. Excludes expired rows rather than
   * waiting for the TTL sweep, so a lapsed hold frees its units immediately.
   */
  countActiveByVariant(variantId: string, options?: RepositoryOptions): Promise<number>;
  countActiveAndCommittedByDigitalAsset(digitalAssetId: string, options?: RepositoryOptions): Promise<number>;

  // Vendor inventory queries
  findByVendor(vendorId: string, filters: { variantId?: string; status?: string }, pagination: { page: number; limit: number }, options?: RepositoryOptions): Promise<StockReservation[]>;
  countByVendor(vendorId: string, filters: { variantId?: string; status?: string }, options?: RepositoryOptions): Promise<number>;
}
