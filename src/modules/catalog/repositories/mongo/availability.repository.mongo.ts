import { FilterQuery, Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IServiceAvailability, ServiceAvailabilityModel } from '../../models';
import { IAvailabilityRepository } from '../interfaces/availability.repository.interface';
import { Availability, AvailabilityMapper } from '../mappers/availability.mapper';

export class AvailabilityRepositoryMongo extends BaseRepository<IServiceAvailability, Availability> implements IAvailabilityRepository {
  constructor() {
    super(ServiceAvailabilityModel, new AvailabilityMapper());
  }

  async findByServiceConfig(serviceConfigId: string, options?: RepositoryOptions): Promise<Availability[]> {
    const docs = await this.model.find({ serviceConfigId, deletedAt: null }).session(options?.session || null).exec();
    return docs.map(doc => this.mapper.toDomain(doc));
  }

  async findById(id: string, options?: RepositoryOptions): Promise<Availability | null> {
    return super.findById(id, options);
  }

  async update(id: string, updates: Partial<Availability>, options?: RepositoryOptions): Promise<Availability | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await this.model.findOneAndUpdate(
       { _id: id, deletedAt: null },
       { $set: updates },
       { new: true, session: options?.session }
    );
    return doc ? this.mapper.toDomain(doc) : null;
  }

  async delete(id: string, options?: RepositoryOptions): Promise<void> {
    return this.softDelete(id, options);
  }

  async deleteByServiceConfig(serviceConfigId: string, options?: RepositoryOptions): Promise<void> {
     await this.model.updateMany(
         { serviceConfigId, deletedAt: null },
         { deletedAt: new Date() },
         options?.session ? { session: options.session } : {}
     ).exec();
  }
}
