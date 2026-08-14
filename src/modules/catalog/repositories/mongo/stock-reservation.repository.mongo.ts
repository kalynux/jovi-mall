import { Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IStockReservation, StockReservationModel, ReservationStatus } from '../../models/stock-reservation.model';
import { IStockReservationRepository } from '../interfaces/stock-reservation.repository.interface';
import { StockReservation, StockReservationMapper } from '../mappers/stock-reservation.mapper';

export class StockReservationRepositoryMongo extends BaseRepository<IStockReservation, StockReservation> implements IStockReservationRepository {
  constructor() {
    super(StockReservationModel, new StockReservationMapper());
  }

  async create(reservation: Omit<StockReservation, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<StockReservation> {
    const [doc] = await this.model.create([reservation as any], options?.session ? { session: options.session } : {});
    return this.mapper.toDomain(doc);
  }

  async findByReservationId(reservationId: string, options?: RepositoryOptions): Promise<StockReservation | null> {
    const doc = await this.model.findOne({ reservationId, deletedAt: null })
      .session(options?.session || null)
      .exec();
    return doc ? this.mapper.toDomain(doc) : null;
  }

  async findById(id: string, options?: RepositoryOptions): Promise<StockReservation | null> {
    return super.findById(id, options);
  }

  async updateStatus(reservationId: string, status: ReservationStatus, options?: RepositoryOptions): Promise<StockReservation | null> {
    const doc = await this.model.findOneAndUpdate(
      { reservationId, deletedAt: null },
      { $set: { status } },
      { new: true, session: options?.session }
    ).exec();

    return doc ? this.mapper.toDomain(doc) : null;
  }

  async findExpired(before: Date, options?: RepositoryOptions): Promise<StockReservation[]> {
    const docs = await this.model.find({
      expiresAt: { $lt: before },
      status: 'active',
      deletedAt: null
    })
      .session(options?.session || null)
      .exec();

    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async deleteExpired(before: Date, options?: RepositoryOptions): Promise<void> {
    await this.model.deleteMany(
      {
        expiresAt: { $lt: before },
        status: { $in: ['released', 'expired'] },
        deletedAt: null
      },
      options?.session ? { session: options.session } : {}
    ).exec();
  }

  /**
   * Mark a reservation committed and push its TTL out.
   *
   * Two writes that must not be separable. The model's
   * `{ expiresAt: 1 }, { expireAfterSeconds: 0 }` index deletes on that field **regardless
   * of status**, so committing without moving the date leaves a record of a completed sale
   * scheduled for deletion the moment its original hold window elapses. Doing both in one
   * `$set` is what stops a future edit from moving one and forgetting the other — the same
   * rule `UserRepository.updatePassword` follows for the hash and its epoch stamp.
   */
  async commit(
    reservationId: string,
    retentionDays: number,
    options?: RepositoryOptions,
  ): Promise<StockReservation | null> {
    const retainUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
    const doc = await this.model.findOneAndUpdate(
      { reservationId, deletedAt: null },
      { $set: { status: 'committed', expiresAt: retainUntil } },
      { new: true, session: options?.session }
    ).exec();

    return doc ? this.mapper.toDomain(doc) : null;
  }

  /**
   * How many units of a variant are currently held by somebody mid-checkout.
   *
   * This is the `activeReservations` term in
   * `InventoryAvailabilityCalculator` (`available = stock − activeReservations`), so it has
   * to answer for **units, not rows** — two reservations of three each hold six.
   *
   * ⚠️ **Expired rows are excluded here rather than left to the TTL.** Mongo's TTL monitor
   * runs about once a minute, so a row can sit expired-but-present for up to that long; if
   * the count included it, an abandoned checkout would keep the last unit off sale for a
   * minute after its hold lapsed. Filtering on `expiresAt` makes expiry take effect at the
   * instant it happens and demotes the TTL index to what it should be — cleanup, not
   * correctness.
   */
  async countActiveByVariant(variantId: string, options?: RepositoryOptions): Promise<number> {
    const [row] = await this.model.aggregate<{ units: number }>([
      {
        $match: {
          variantId: new Types.ObjectId(variantId),
          status: 'active',
          expiresAt: { $gt: new Date() },
          deletedAt: null,
        },
      },
      { $group: { _id: null, units: { $sum: '$quantity' } } },
    ]).session(options?.session || null).exec();

    return row?.units ?? 0;
  }

  async countActiveAndCommittedByDigitalAsset(digitalAssetId: string, options?: RepositoryOptions): Promise<number> {
    return this.model.countDocuments({
      digitalAssetId,
      status: { $in: ['active', 'committed'] },
      deletedAt: null
    }).session(options?.session || null);
  }

  async findByVendor(
    vendorId: string,
    filters: { variantId?: string; status?: string },
    pagination: { page: number; limit: number },
    options?: RepositoryOptions
  ): Promise<StockReservation[]> {
    const query: any = {
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null
    };

    if (filters.variantId) {
      query.variantId = new Types.ObjectId(filters.variantId);
    }

    if (filters.status) {
      if (filters.status === 'expired') {
        query.expiresAt = { $lt: new Date() };
      } else {
        query.status = filters.status;
      }
    }

    const skip = (pagination.page - 1) * pagination.limit;

    const docs = await this.model.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pagination.limit)
      .session(options?.session || null)
      .exec();

    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async countByVendor(
    vendorId: string,
    filters: { variantId?: string; status?: string },
    options?: RepositoryOptions
  ): Promise<number> {
    const query: any = {
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null
    };

    if (filters.variantId) {
      query.variantId = new Types.ObjectId(filters.variantId);
    }

    if (filters.status) {
      if (filters.status === 'expired') {
        query.expiresAt = { $lt: new Date() };
      } else {
        query.status = filters.status;
      }
    }

    return this.model.countDocuments(query).session(options?.session || null);
  }
}

