// import { IMapper } from '../../../core/database/mapper.interface';
// import { IProduct } from '../models/product.model.ts';

import { IMapper } from "../../../../core/database/mapper.interface";
import { IProduct } from "../../models";

// Domain Entity (Simplified for now, matching IProduct structure but purely decoupled if needed later)
// For Phase 3, we can reuse the interface logic or define a specific class. 
// The requirement says "Repositories must Return domain types or DTOs... Never Mongoose Documents".
// We will define a Domain Product Type here that mimics IProduct but uses string ID.

export interface Product {
  id: string;
  vendorId: string;
  type: 'physical' | 'digital' | 'service';
  status: 'draft' | 'active' | 'archived' | 'pending_review' | 'suspended';
  title: string;
  description: string;
  slug: string;
  seo: {
    title?: string;
    description?: string;
  };
  hasVariants: boolean;
  defaultVariantId?: string;
  fileIds: string[];  // File references converted to string IDs

  // Service-specific config
  serviceConfig?: {
    durationMinutes: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    bookingMode: 'calendar' | 'manual' | 'capacity';
  };

  // Digital-specific config
  digitalConfig?: {
    assetId: string;
    maxDownloads: number | null;
    expiresAfterDays: number | null;
    isActive: boolean;
  };

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

export class ProductMapper implements IMapper<Product, IProduct> {
  toDomain(persistence: IProduct): Product {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      vendorId: doc.vendorId.toString(),
      type: doc.type,
      status: doc.status,
      title: doc.title,
      description: doc.description,
      slug: doc.slug,
      seo: doc.seo,
      hasVariants: doc.hasVariants,
      defaultVariantId: doc.defaultVariantId?.toString(),
      fileIds: doc.fileIds?.map((id: any) => id.toString()) || [],
      serviceConfig: doc.serviceConfig,
      digitalConfig: doc.digitalConfig,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: Product): IProduct {
    // This is a partial implementation effectively, as we don't always create from full domain objects
    // But for a rigorous mapper:
    return {
      // @ts-ignore: _id is optional in creation usually, handled by Mongoose
      _id: domain.id,
      vendorId: domain.vendorId,
      type: domain.type,
      status: domain.status,
      title: domain.title,
      description: domain.description,
      slug: domain.slug,
      seo: domain.seo,
      hasVariants: domain.hasVariants,
      defaultVariantId: domain.defaultVariantId,
      // dates usually managed by timestamps, but can be passed
    } as any;
  }
}
