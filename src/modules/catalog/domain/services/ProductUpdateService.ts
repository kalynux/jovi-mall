import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';
import { assertProductImageLimit } from './media/image-limits';
import { ConnectionRepository } from '../../../agency-connections/connection.repository';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { PickupLocationValidationService } from './PickupLocationValidationService';

// Per-variant asset/limits live on ProductVariant.digitalConfig now.
// Only the product-wide `isActive` kill switch is updatable here.
export interface UpdateDigitalConfigDto {
  isActive?: boolean;
}

export interface UpdateDeliveryConfigDto {
  agencyId?: string | null;
  freeDelivery?: boolean;
  pickupLocation?: {
    source: 'vendor_address' | 'agency_storage';
    vendorAddressId?: string | null;
  } | null;
}

export interface UpdateProductCommand {
  title?: string;
  description?: string;
  fileIds?: string[];            // Full array replacement for product media
  category?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  digitalConfig?: UpdateDigitalConfigDto;
  delivery?: UpdateDeliveryConfigDto;
  regenerateSlug?: boolean;
}

/**
 * ProductUpdateService: Update existing products with state and ownership validation
 */
export class ProductUpdateService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly slugService: SlugService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly connectionRepository: ConnectionRepository = new ConnectionRepository(),
    private readonly vendorRepository: VendorRepository = new VendorRepository(),
    private readonly deliveryAgencyRepository: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly pickupLocationValidationService: PickupLocationValidationService = new PickupLocationValidationService(),
  ) { }

  async execute(
    productId: string,
    vendorId: string,
    command: UpdateProductCommand
  ): Promise<Product> {
    const product = await this.productRepository.findById(productId, vendorId);

    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    if (product.vendorId !== vendorId) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
    }

    // 'suspended' is editable on purpose: suspension is system-driven (a delivery
    // agency became unusable), and editing is often the vendor's only way OUT of
    // it — e.g. repointing delivery.agencyId at a working agency, which the
    // controller follows with a restore attempt (handleProductAgencyOverrideChange).
    if (product.status !== 'draft' && product.status !== 'active' && product.status !== 'suspended') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });
    }

    const updates: Partial<Product> = {};

    if (command.title !== undefined) {
      updates.title = command.title.trim();
      if (command.regenerateSlug) {
        updates.slug = await this.slugService.generate(updates.title, vendorId);
      }
    }

    if (command.description !== undefined) updates.description = command.description;
    if (command.category !== undefined) updates.category = command.category;
    if (command.tags !== undefined) updates.tags = command.tags;

    // Full array replacement — frontend must send the complete desired array
    if (command.fileIds !== undefined) {
      assertProductImageLimit(product.type, command.fileIds.length);
      updates.fileIds = command.fileIds;
    }

    if (command.seoTitle !== undefined || command.seoDescription !== undefined) {
      updates.seo = {
        ...product.seo,
        ...(command.seoTitle !== undefined && { title: command.seoTitle }),
        ...(command.seoDescription !== undefined && { description: command.seoDescription }),
      };
    }

    if (command.digitalConfig !== undefined && product.type === 'digital') {
      updates.digitalConfig = { ...product.digitalConfig, ...command.digitalConfig } as any;
    }

    if (command.delivery !== undefined) {
      if (product.type !== 'physical') {
        throw createAppError(
          ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
          400,
          'Delivery configuration only applies to physical products',
        );
      }
      // Setting a non-null override agency requires an active, approved connection
      // between this vendor and that agency — mirrors the same gate on
      // VendorProfileService.setDefaultDeliveryAgency(). Clearing to null needs no check.
      if (command.delivery.agencyId) {
        const connection = await this.connectionRepository.findByVendorAndAgency(vendorId, command.delivery.agencyId);
        if (!connection || connection.status !== 'active') {
          throw createAppError(
            ERROR_CODES.CONNECTION_NOT_ACTIVE,
            422,
            'You need an active, approved connection with this delivery agency before assigning it to a product.',
          );
        }
      }

      // Each sub-field is independently optional, so merge against the existing
      // persisted value instead of replacing — otherwise setting one field would
      // silently wipe the other. Persistence uses snake_case — see product.model.ts schema.
      const existingDelivery = product.delivery;
      const resolvedAgencyId = command.delivery.agencyId !== undefined
        ? command.delivery.agencyId
        : (existingDelivery?.agencyId ?? null);

      let pickupLocationUpdate: { source: string; vendor_address_id: string | null } | null | undefined = undefined;
      if (command.delivery.pickupLocation !== undefined) {
        if (command.delivery.pickupLocation === null) {
          pickupLocationUpdate = null;
        } else {
          const { source, vendorAddressId } = command.delivery.pickupLocation;

          // Resolve whichever agency actually ends up handling delivery — the
          // product's own override (possibly just set above) if any, otherwise
          // the vendor's default — same resolution used at activation time and
          // at order-creation time.
          const vendor = await this.vendorRepository.findById(vendorId);
          const effectiveAgencyId = resolvedAgencyId ?? vendor?.default_delivery_agency_id?.toString();
          if (!vendor || !effectiveAgencyId) {
            throw createAppError(
              ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY,
              422,
              'Set a delivery agency (default or product override) before choosing a pickup location.',
            );
          }

          const agency = await this.deliveryAgencyRepository.findById(effectiveAgencyId);
          if (!agency) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY, 422, 'The resolved delivery agency was not found.');
          }

          this.pickupLocationValidationService.assertValid(
            { source, vendorAddressId: vendorAddressId ?? null },
            agency,
            vendor,
          );

          pickupLocationUpdate = {
            source,
            vendor_address_id: source === 'agency_storage' ? null : (vendorAddressId ?? null),
          };
        }
      }

      (updates as any).delivery = {
        agency_id: resolvedAgencyId,
        free_delivery: command.delivery.freeDelivery !== undefined
          ? command.delivery.freeDelivery
          : (existingDelivery?.freeDelivery ?? false),
        pickup_location: pickupLocationUpdate !== undefined
          ? pickupLocationUpdate
          : (existingDelivery?.pickupLocation
            ? { source: existingDelivery.pickupLocation.source, vendor_address_id: existingDelivery.pickupLocation.vendorAddressId }
            : null),
      };
    }

    // Keep file references in sync with the replaced media array. Runs before the
    // product write so an unauthorized file reference is rejected before it is
    // ever persisted.
    if (command.fileIds !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: product.fileIds ?? [],
        nextFileIds: command.fileIds,
        actor: { type: 'vendor', id: vendorId },
        entityType: 'product',
        entityId: productId,
      });
    }

    const updatedProduct = await this.productRepository.update(productId, vendorId, updates);

    if (!updatedProduct) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    return updatedProduct;
  }
}
