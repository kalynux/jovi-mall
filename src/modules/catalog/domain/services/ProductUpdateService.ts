import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import type { RichDoc } from '../../../../core/richtext';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';
import { assertProductImageLimit } from './media/image-limits';
import { ConnectionRepository } from '../../../agency-connections/connection.repository';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
import { PickupLocationValidationService } from './PickupLocationValidationService';
import { mergeDeliveryConfig } from './delivery-config.merge';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { VariantRepositoryMongo } from '../../repositories/mongo/variant.repository.mongo';
import {
  assertCountableStockForAgencyStorage,
  requiresCountableStock,
} from './agency-storage-stock.rule';

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
    /** Which agency depot, for `agency_storage`. Omitted/null = the primary. */
    agencyAddressId?: string | null;
  } | null;
}

export interface UpdateProductCommand {
  title?: string;
  description?: string;
  /**
   * Three-valued, and the `null` is load-bearing: absent leaves the stored
   * document alone, `null` clears it. Omitting the clear on an emptied
   * description would leave the old document in place while `description` was
   * replaced, and the next read would resurrect formatting the vendor deleted.
   */
  descriptionRich?: RichDoc | null;
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
    // The agency's depot list lives on the Magazin, not the DeliveryAgency.
    private readonly magazinRepository: MagazinRepository = new MagazinRepository(),
    // Read only when pickup becomes `agency_storage` — the countable-stock rule is
    // the one delivery check that needs variants.
    private readonly variantRepository: IVariantRepository = new VariantRepositoryMongo(),
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
    // `!== undefined` rather than a truthiness check, so an explicit `null`
    // reaches the repository's `$set` and actually clears the column. A `!command`
    // guard here would silently turn "the vendor deleted their formatting" into
    // "leave it alone" — the one case this field exists to get right.
    if (command.descriptionRich !== undefined) updates.descriptionRich = command.descriptionRich;
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
      // silently wipe the other. mergeDeliveryConfig owns that merge (and the
      // camelCase → snake_case mapping) and is shared with the simple-product path.
      const merged = mergeDeliveryConfig(product.delivery, command.delivery);

      // Validate a newly-supplied pickup location against whichever agency will
      // actually handle delivery — the product's own override (possibly just set
      // above) if any, otherwise the vendor's default. Same resolution used at
      // activation time and at order-creation time. Only a NEW location is
      // checked; one carried over from the existing config was validated when it
      // was set, and the activation gate re-checks it anyway.
      if (command.delivery.pickupLocation) {
        const vendor = await this.vendorRepository.findById(vendorId);
        const effectiveAgencyId = merged.agency_id ?? vendor?.default_delivery_agency_id?.toString();
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

        // The agency's depot list, loaded ONLY when a depot was actually named —
        // so a vendor-address pickup, or a storage pickup that takes the primary,
        // costs no extra query.
        const agencyAddressId = command.delivery.pickupLocation.agencyAddressId ?? null;
        const agencyDepotIds = agencyAddressId
          ? await this.magazinRepository.findHqAddressIdsByAgencyId(effectiveAgencyId)
          : null;

        this.pickupLocationValidationService.assertValid(
          {
            source: command.delivery.pickupLocation.source,
            vendorAddressId: command.delivery.pickupLocation.vendorAddressId ?? null,
            agencyAddressId,
          },
          agency,
          vendor,
          agencyDepotIds,
        );

        // Refuse rather than demote. Moving pickup to `agency_storage` while a
        // variant has unlimited stock breaks the activation gate, and
        // `revalidateActiveStatus` (wired into this very update path) would answer
        // that by quietly dropping a live product to `draft`. A vendor who edited an
        // address and found their product unpublished with no explanation would have
        // no way to know why — so the write is what fails, with the reason.
        if (requiresCountableStock(command.delivery.pickupLocation.source)) {
          const variants = await this.variantRepository.findByProduct(productId);
          assertCountableStockForAgencyStorage(command.delivery.pickupLocation.source, variants);
        }
      }

      (updates as any).delivery = merged;
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
