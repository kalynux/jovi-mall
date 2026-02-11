import { IMapper } from '../../../../core/database/mapper.interface';
import { IProductOptionValue } from '../../models';

export interface ProductOptionValue {
  id: string;
  optionId: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

export class ProductOptionValueMapper implements IMapper<ProductOptionValue, IProductOptionValue> {
  toDomain(persistence: IProductOptionValue): ProductOptionValue {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      optionId: doc.optionId.toString(),
      value: doc.value,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: ProductOptionValue): IProductOptionValue {
    return {
      _id: domain.id,
      optionId: domain.optionId,
      value: domain.value,
    } as any;
  }
}
