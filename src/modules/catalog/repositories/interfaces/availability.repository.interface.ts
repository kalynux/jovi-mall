import { Availability } from '../mappers/availability.mapper';
import { RepositoryOptions } from '../types';

export interface IAvailabilityRepository {
  create(availability: Omit<Availability, 'id' | 'createdAt' | 'updatedAt'>, options?: RepositoryOptions): Promise<Availability>;
  
  findByServiceConfig(serviceConfigId: string, options?: RepositoryOptions): Promise<Availability[]>;
  findById(id: string, options?: RepositoryOptions): Promise<Availability | null>;
  
  update(id: string, updates: Partial<Availability>, options?: RepositoryOptions): Promise<Availability | null>;
  delete(id: string, options?: RepositoryOptions): Promise<void>;
  deleteByServiceConfig(serviceConfigId: string, options?: RepositoryOptions): Promise<void>;
}
