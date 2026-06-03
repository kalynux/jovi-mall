import { IMapper } from '../../../../core/database/mapper.interface';
import { IProductVariant } from '../../models';

export interface Variant {
  id: string;
  productId: string;
  sku: string;
  name?: string; // Variant name (required for digital/service)
  status: 'active' | 'archived';
  optionSignature: string;
  price: number;
  compareAtPrice?: number;
  stock: number;
  isInfiniteStock: boolean;
  lowStockThreshold: number | null;
  allowOversell: boolean;
  weight?: number;
  length?: number;
  width?: number;
  height?: number;
  optionValueIds: string[];
  fileIds: string[];
  deliveryAgencyId?: string;
  digitalConfig?: {
    assetId?: string;
    // Optional in the domain type so partial PATCH updates can include only one of the fields.
    // Persistence layer (mapper/repository) normalizes missing → null on read.
    maxDownloads?: number | null;
    expiresAfterDays?: number | null;
  };
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

export class VariantMapper implements IMapper<Variant, IProductVariant> {
  toDomain(persistence: IProductVariant): Variant {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      productId: doc.productId.toString(),
      sku: doc.sku,
      name: doc.name,
      status: doc.status,
      optionSignature: doc.optionSignature,
      price: doc.price,
      compareAtPrice: doc.compareAtPrice,
      stock: doc.stock,
      isInfiniteStock: doc.isInfiniteStock,
      lowStockThreshold: doc.low_stock_threshold,
      allowOversell: doc.allow_oversell,
      weight: doc.weight,
      length: doc.length,
      width: doc.width,
      height: doc.height,
      optionValueIds: doc.optionValueIds.map((id: any) => id.toString()),
      fileIds: doc.fileIds?.map((id: any) => id.toString()) || [],
      deliveryAgencyId: doc.deliveryAgencyId?.toString(),
      digitalConfig: doc.digitalConfig ? {
        assetId: doc.digitalConfig.assetId?.toString(),
        maxDownloads: doc.digitalConfig.maxDownloads ?? null,
        expiresAfterDays: doc.digitalConfig.expiresAfterDays ?? null,
      } : undefined,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: Variant): IProductVariant {
    return {
      _id: domain.id,
      productId: domain.productId,
      sku: domain.sku,
      price: domain.price,
      compareAtPrice: domain.compareAtPrice,
      stock: domain.stock,
      isInfiniteStock: domain.isInfiniteStock,
      weight: domain.weight,
      length: domain.length,
      width: domain.width,
      height: domain.height,
      optionValueIds: domain.optionValueIds,
      fileIds: domain.fileIds,
      deliveryAgencyId: domain.deliveryAgencyId,
    } as any;
  }
}
