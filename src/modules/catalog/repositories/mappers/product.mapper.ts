// import { IMapper } from '../../../core/database/mapper.interface';
// import { IProduct } from '../models/product.model.ts';

import { IMapper } from "../../../../core/database/mapper.interface";
import { IProduct } from "../../models";
import { ProductMode, ProductSuspension, VectorisationStatus } from "../../models/product.model";

// Domain Entity (Simplified for now, matching IProduct structure but purely decoupled if needed later)
// For Phase 3, we can reuse the interface logic or define a specific class. 
// The requirement says "Repositories must Return domain types or DTOs... Never Mongoose Documents".
// We will define a Domain Product Type here that mimics IProduct but uses string ID.

export interface Product {
  id: string;
  vendorId: string;
  type: 'physical' | 'digital' | 'service';
  status: 'draft' | 'active' | 'archived' | 'pending_review' | 'suspended';
  /** Authoring mode — see ProductMode in product.model.ts. Never undefined here. */
  mode: ProductMode;
  title: string;
  description: string;
  slug: string;

  category: string;
  tags: string[];

  seo: {
    title?: string;
    description?: string;
  };
  hasVariants: boolean;
  defaultVariantId?: string;
  fileIds: string[];  // File references converted to string IDs

  // Service config + pricing live on the single service variant (Variant.serviceConfig).

  // Digital-specific config (product-wide kill switch only; per-variant asset/limits live on the variant)
  digitalConfig?: {
    isActive: boolean;
  };

  // Physical-specific delivery config. Null agencyId means the vendor's default applies at order time.
  delivery?: {
    agencyId: string | null;
    freeDelivery: boolean;
    pickupLocation: {
      source: 'vendor_address' | 'agency_storage';
      vendorAddressId: string | null;
    } | null;
  };

  // System-driven suspension snapshot. Undefined/null unless currently suspended by a cascade.
  suspension?: ProductSuspension | null;

  // ─── Vectorisation tracking ───────────────────────────────────────────────
  vectorisationEnabled: boolean;
  vectorisationStatus: VectorisationStatus;
  vectorisedDataId: string | null;

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
      // Products created before `mode` existed have no such key — coerce here so
      // the domain type can stay non-optional and no migration is needed.
      mode: doc.mode ?? 'advanced',
      title: doc.title,
      description: doc.description,
      slug: doc.slug,
      category: doc.category,
      tags: doc.tags || [],
      seo: doc.seo,
      hasVariants: doc.hasVariants,
      defaultVariantId: doc.defaultVariantId?.toString(),
      fileIds: doc.fileIds?.map((id: any) => id.toString()) || [],
      digitalConfig: doc.digitalConfig ? {
        isActive: doc.digitalConfig.isActive ?? true,
      } : undefined,
      delivery: doc.delivery
        ? {
          agencyId: doc.delivery.agency_id?.toString() ?? null,
          freeDelivery: doc.delivery.free_delivery ?? false,
          pickupLocation: doc.delivery.pickup_location
            ? {
              source: doc.delivery.pickup_location.source,
              vendorAddressId: doc.delivery.pickup_location.vendor_address_id?.toString() ?? null,
            }
            : null,
        }
        : undefined,
      suspension: doc.suspension
        ? {
          reason: doc.suspension.reason,
          previousStatus: doc.suspension.previousStatus,
          suspendedAt: doc.suspension.suspendedAt,
        }
        : null,
      vectorisationEnabled: doc.vectorisationEnabled ?? false,
      vectorisationStatus: doc.vectorisationStatus ?? 'not_started',
      vectorisedDataId: doc.vectorisedDataId ?? null,
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
      _id: domain.id,
      vendorId: domain.vendorId,
      type: domain.type,
      status: domain.status,
      mode: domain.mode,
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
