import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import type { RichDoc } from '../../../../core/richtext';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';
import { assertProductImageLimit } from './media/image-limits';
import {
  categoryResolutionService,
  CategoryResolutionService,
  CategoryInputRef,
} from '../../../categories/services/category-resolution.service';

export interface CreateProductInput {
  vendorId: string;
  type: 'physical' | 'digital' | 'service';
  title: string;
  description?: string;
  /** The structured description. Optional — a client may send only `description`. */
  descriptionRich?: RichDoc | null;
  /**
   * 1–5 categories — ids picked from the shared list, or names the vendor typed.
   * Resolved (and, for a genuinely new name, created) by `CategoryResolutionService`
   * before anything is written; a look-alike name refuses the whole create with
   * `422 CATEGORY_SIMILAR_EXISTS`.
   */
  categories: CategoryInputRef[];
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  fileIds?: string[];
}

/**
 * ProductDraftService: Create new products in DRAFT state
 */
export class ProductDraftService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly slugService: SlugService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly categoryResolver: CategoryResolutionService = categoryResolutionService,
  ) { }

  async execute(input: CreateProductInput): Promise<Product> {
    const trimmedTitle = input.title.trim();

    if (!trimmedTitle) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE, 422, 'Product title cannot be empty');
    }

    if (trimmedTitle.length < 3) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE, 422, 'Product title must be at least 3 characters long');
    }

    const fileIds = input.fileIds ?? [];
    assertProductImageLimit(input.type, fileIds.length);

    // Before the slug and the insert: a "did you mean" refusal must leave nothing behind.
    const categoryIds = (
      await this.categoryResolver.resolveForWrite(input.categories, { source: 'vendor', vendorId: input.vendorId })
    ).map((id) => id.toString());

    const slug = await this.slugService.generate(trimmedTitle, input.vendorId);

    const productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
      vendorId: input.vendorId,
      type: input.type,
      // The multi-step flow is the advanced editor by definition — the simple
      // one-shot editor has its own service (see domain/services/simple/).
      mode: 'advanced',
      status: 'draft',
      title: trimmedTitle,
      description: input.description ?? '',
      // Stored verbatim beside its projection, never derived from it: a client
      // with no formatting editor sends `description` alone and must not have a
      // document invented for it.
      descriptionRich: input.descriptionRich ?? null,
      slug,
      categoryIds,
      tags: input.tags ?? [],
      seo: {
        title: input.seoTitle ?? '',
        description: input.seoDescription ?? '',
      },
      hasVariants: false,
      deletedAt: null,
      // Media is attached after the product exists, but only once the files are
      // authorized — never persist an unauthorized reference.
      fileIds: [],
      // Vectorisation defaults — never enabled on a fresh draft
      vectorisationEnabled: false,
      vectorisationStatus: 'not_started',
      vectorisedDataId: null,
    };

    const product = await this.productRepository.create(productData);

    if (fileIds.length === 0) return product;

    // Authorize + count the media (throws before the array is persisted if a
    // file is not vendor-owned), then attach it to the product.
    await this.fileReferenceService.reconcile({
      previousFileIds: [],
      nextFileIds: fileIds,
      actor: { type: 'vendor', id: input.vendorId },
      entityType: 'product',
      entityId: product.id,
    });

    const withFiles = await this.productRepository.update(product.id, input.vendorId, { fileIds });
    return withFiles ?? product;
  }
}
