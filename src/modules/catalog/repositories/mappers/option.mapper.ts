import { IMapper } from '../../../../core/database/mapper.interface';
import { IProductOption } from '../../models';

export interface ProductOption {
  id: string;
  productId: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

export class ProductOptionMapper implements IMapper<ProductOption, IProductOption> {
  toDomain(persistence: IProductOption): ProductOption {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      productId: doc.productId.toString(),
      name: doc.name,
      position: doc.position,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: ProductOption): IProductOption {
    return {
      _id: domain.id,
      productId: domain.productId,
      name: domain.name,
      position: domain.position,
    } as any;
  }
}
