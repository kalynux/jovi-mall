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
  // Service config + pricing — only set on the single variant of a service product.
  // `price` is the base price per `serviceConfig.durationMinutes`.
  serviceConfig?: {
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    bookingMode: 'calendar' | 'manual' | 'capacity';
    maxBookings?: number;
    peakHours?: {
      daysOfWeek: number[];
      startTime: string;
      endTime: string;
      priceType: 'fixed' | 'percentage';
      value: number;
    };
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
      serviceConfig: doc.serviceConfig ? {
        durationMinutes: doc.serviceConfig.durationMinutes,
        bufferBeforeMinutes: doc.serviceConfig.bufferBeforeMinutes ?? 0,
        bufferAfterMinutes: doc.serviceConfig.bufferAfterMinutes ?? 0,
        bookingMode: doc.serviceConfig.bookingMode,
        maxBookings: doc.serviceConfig.maxBookings,
        peakHours: doc.serviceConfig.peakHours ? {
          daysOfWeek: doc.serviceConfig.peakHours.daysOfWeek ?? [],
          startTime: doc.serviceConfig.peakHours.startTime,
          endTime: doc.serviceConfig.peakHours.endTime,
          priceType: doc.serviceConfig.peakHours.priceType,
          value: doc.serviceConfig.peakHours.value,
        } : undefined,
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
