/**
 * Read-model wire types for vendor product/variant detail endpoints.
 *
 * These types are used only at the HTTP boundary (controller responses).
 * They are separate from the core domain types (Product, Variant) so that
 * mappers and repositories remain clean.
 */

import { ErrorCode } from '../../../core/error-codes';
import { ProductMode, ProductStatus, ProductType, VectorisationStatus } from '../models/product.model';

/**
 * One unmet requirement standing between a product and `status: 'active'`.
 *
 * Produced by ProductStatusValidationService.collectActivationBlockers() and
 * returned by the simple-product endpoints so a vendor sees the whole publish
 * checklist at once instead of discovering it one 422 at a time. `message` is
 * the AppError's message verbatim — which is why those default messages have to
 * read as instructions to a vendor (see defaultMessages in core/errors.ts).
 */
export interface ActivationBlocker {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface FileDetail {
  id: string;
  key: string;
  url: string;           // Computed via storageProvider.getPublicUrl(key)
  mimeType: string;
  size: number;
  originalName?: string;
}

export interface AssetDetail {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  // No url — digital assets are not publicly accessible;
  // access is gated through the customer entitlement + download-link flow
}

/**
 * Lean list-view payload for the vendor products grid/list UI.
 * Only the fields used by the grid/list rendering and row actions are exposed.
 * `fileIds` is populated with resolved FileDetail objects (id, key, url, ...).
 */
export interface ProductListItem {
  id: string;
  title: string;
  type: ProductType;
  status: ProductStatus;
  /** Tells the UI which editor to open for this row — simple or advanced. */
  mode: ProductMode;
  category: string;
  fileIds: FileDetail[];
  hasVariants: boolean;
  vectorisationEnabled: boolean;
  vectorisationStatus: VectorisationStatus;
}

/**
 * Intermediate projection returned by the repository for the list view.
 * Keeps the raw file IDs so the service layer can batch-resolve them into
 * FileDetail objects through a single File query.
 */
export interface ProductListProjection {
  id: string;
  title: string;
  type: ProductType;
  status: ProductStatus;
  mode: ProductMode;
  category: string;
  fileIds: string[];
  hasVariants: boolean;
  vectorisationEnabled: boolean;
  vectorisationStatus: VectorisationStatus;
}
