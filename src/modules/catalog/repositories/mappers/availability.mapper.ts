import { IMapper } from '../../../../core/database/mapper.interface';
import { IServiceAvailability } from '../../models';

export interface Availability {
  id: string;
  serviceConfigId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isDisabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export class AvailabilityMapper implements IMapper<Availability, IServiceAvailability> {
  toDomain(persistence: IServiceAvailability): Availability {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      serviceConfigId: doc.serviceConfigId.toString(),
      dayOfWeek: doc.dayOfWeek,
      startTime: doc.startTime,
      endTime: doc.endTime,
      isDisabled: doc.isDisabled,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
    };
  }

  toPersistence(domain: Availability): IServiceAvailability {
    return {
      _id: domain.id,
      serviceConfigId: domain.serviceConfigId,
      dayOfWeek: domain.dayOfWeek,
      startTime: domain.startTime,
      endTime: domain.endTime,
      isDisabled: domain.isDisabled,
    } as any;
  }
}
