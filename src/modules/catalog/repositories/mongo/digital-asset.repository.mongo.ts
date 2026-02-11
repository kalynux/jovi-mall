import { Types } from 'mongoose';
import { BaseRepository, RepositoryOptions } from '../../../../core/repositories/base.repository';
import { IDigitalAsset, DigitalAssetModel } from '../../models/digital-asset.model';
import { IDigitalAssetRepository } from '../interfaces/digital-asset.repository.interface';
import { DigitalAsset, DigitalAssetMapper } from '../mappers/digital-asset.mapper';

/**
 * DigitalAssetRepositoryMongo
 * 
 * MongoDB implementation of the IDigitalAssetRepository interface.
 * Handles persistence of digital assets linked to products.
 */
export class DigitalAssetRepositoryMongo
    extends BaseRepository<IDigitalAsset, DigitalAsset>
    implements IDigitalAssetRepository {
    constructor() {
        super(DigitalAssetModel, new DigitalAssetMapper());
    }

    /**
     * Create a new digital asset
     */
    async create(
        digitalAsset: Omit<DigitalAsset, 'id' | 'createdAt' | 'updatedAt'>,
        options?: RepositoryOptions
    ): Promise<DigitalAsset> {
        const doc = await this.model.create(
            [digitalAsset],
            options?.session ? { session: options.session } : {}
        );
        return this.mapper.toDomain(doc[0]);
    }

    /**
     * Find digital asset by ID
     */
    async findById(id: string, options?: RepositoryOptions): Promise<DigitalAsset | null> {
        if (!Types.ObjectId.isValid(id)) return null;

        const doc = await this.model
            .findOne({ _id: id, deletedAt: null })
            .session(options?.session || null)
            .exec();

        return doc ? this.mapper.toDomain(doc) : null;
    }

    /**
     * Find all digital assets for a product
     */
    async findByProduct(productId: string, options?: RepositoryOptions): Promise<DigitalAsset[]> {
        if (!Types.ObjectId.isValid(productId)) return [];

        const docs = await this.model
            .find({ productId: new Types.ObjectId(productId), deletedAt: null })
            .session(options?.session || null)
            .exec();

        return docs.map(doc => this.mapper.toDomain(doc));
    }

    /**
     * Find digital asset by media/file ID
     */
    async findByMediaId(mediaId: string, options?: RepositoryOptions): Promise<DigitalAsset | null> {
        if (!Types.ObjectId.isValid(mediaId)) return null;

        const doc = await this.model
            .findOne({ mediaId: new Types.ObjectId(mediaId), deletedAt: null })
            .session(options?.session || null)
            .exec();

        return doc ? this.mapper.toDomain(doc) : null;
    }

    /**
     * Update digital asset fields
     */
    async update(
        id: string,
        updates: Partial<DigitalAsset>,
        options?: RepositoryOptions
    ): Promise<DigitalAsset | null> {
        if (!Types.ObjectId.isValid(id)) return null;

        const doc = await this.model.findOneAndUpdate(
            { _id: id, deletedAt: null },
            { $set: updates },
            { new: true, session: options?.session }
        );

        return doc ? this.mapper.toDomain(doc) : null;
    }

    /**
     * Soft delete a digital asset
     */
    async softDelete(id: string, options?: RepositoryOptions): Promise<void> {
        if (!Types.ObjectId.isValid(id)) return;

        await this.model.updateOne(
            { _id: id, deletedAt: null },
            { deletedAt: new Date() },
            options?.session ? { session: options.session } : {}
        );
    }

    /**
     * Check if a product has any digital assets
     */
    async existsByProduct(productId: string, options?: RepositoryOptions): Promise<boolean> {
        if (!Types.ObjectId.isValid(productId)) return false;

        const count = await this.model
            .countDocuments({ productId: new Types.ObjectId(productId), deletedAt: null })
            .session(options?.session || null)
            .exec();

        return count > 0;
    }
}
