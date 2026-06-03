/**
 * Read-model wire types for vendor product/variant detail endpoints.
 *
 * These types are used only at the HTTP boundary (controller responses).
 * They are separate from the core domain types (Product, Variant) so that
 * mappers and repositories remain clean.
 */

import { ProductStatus, ProductType, VectorisationStatus } from '../models/product.model';

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
  category: string;
  fileIds: string[];
  hasVariants: boolean;
  vectorisationEnabled: boolean;
  vectorisationStatus: VectorisationStatus;
}
