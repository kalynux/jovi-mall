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

  async countActiveByVariant(variantId: string, options?: RepositoryOptions): Promise<number> {
    return this.model.countDocuments({
      variantId,
      status: 'active',
      deletedAt: null
    }).session(options?.session || null);
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

