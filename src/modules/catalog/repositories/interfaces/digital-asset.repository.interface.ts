import { DigitalAsset } from '../mappers/digital-asset.mapper';
import { RepositoryOptions } from '../types';

/**
 * IDigitalAssetRepository
 * 
 * Repository interface for managing digital assets linked to products.
 * Digital assets represent downloadable files for digital products.
 * 
 * Used by:
 * - DigitalFileLinkService: Link files to digital assets
 * - DigitalStockLimiterService: Check digital asset limits
 * - StockReservationService: Find digital assets for products
 * - StockReleaseService: (Reserved for future use)
 */
export interface IDigitalAssetRepository {
    /**
     * Create a new digital asset
     */
    create(
        digitalAsset: Omit<DigitalAsset, 'id' | 'createdAt' | 'updatedAt'>,
        options?: RepositoryOptions
    ): Promise<DigitalAsset>;

    /**
     * Find digital asset by ID
     * Used by: DigitalFileLinkService, DigitalStockLimiterService
     */
    findById(id: string, options?: RepositoryOptions): Promise<DigitalAsset | null>;

    /**
     * Find all digital assets for a product
     * Used by: StockReservationService
     */
    findByProduct(productId: string, options?: RepositoryOptions): Promise<DigitalAsset[]>;

    /**
     * Find digital asset by media/file ID
     * Useful for checking if a file is already linked to an asset
     */
    findByMediaId(mediaId: string, options?: RepositoryOptions): Promise<DigitalAsset | null>;

    /**
     * Update digital asset fields
     * Used by: DigitalFileLinkService to update mediaId
     */
    update(
        id: string,
        updates: Partial<DigitalAsset>,
        options?: RepositoryOptions
    ): Promise<DigitalAsset | null>;

    /**
     * Soft delete a digital asset
     */
    softDelete(id: string, options?: RepositoryOptions): Promise<void>;

    /**
     * Check if a product has any digital assets
     */
    existsByProduct(productId: string, options?: RepositoryOptions): Promise<boolean>;
}
