import {
  Model,
  Document,
  FilterQuery,
  UpdateQuery,
  ClientSession,
  Types,
  PipelineStage,
} from 'mongoose';
import { IMapper } from '../database/mapper.interface';
import { NotFoundError } from '../errors';

export interface RepositoryOptions {
  session?: ClientSession;
}

export interface PaginationOptions {
  page: number;
  limit: number;
  sort?: Record<string, 1 | -1>;
}

export interface Page<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export abstract class BaseRepository<
  T extends Document,
  DomainT
> {
  constructor(
    protected readonly model: Model<T>,
    protected readonly mapper: IMapper<DomainT, T>
  ) {}

  /**
   * PROTECTED: Find one document by filter.
   * Enforces soft delete check ({ deletedAt: null }).
   */
  protected async findOne(
    filter: FilterQuery<T>,
    options?: RepositoryOptions
  ): Promise<DomainT | null> {
    const query = this.model.findOne({ ...filter, deletedAt: null });
    if (options?.session) {
      query.session(options.session);
    }
    const doc = await query.exec();
    return doc ? this.mapper.toDomain(doc) : null;
  }

  /**
   * PROTECTED: Find document by ID.
   * Enforces soft delete check.
   */
  protected async findById(
    id: string,
    options?: RepositoryOptions
  ): Promise<DomainT | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.findOne({ _id: id } as FilterQuery<T>, options);
  }

  /**
   * PROTECTED: Paginate results.
   * Enforces soft delete check.
   */
  protected async paginate(
    filter: FilterQuery<T>,
    paginationOptions: PaginationOptions,
    options?: RepositoryOptions
  ): Promise<Page<DomainT>> {
    const { page = 1, limit = 10, sort = { createdAt: -1 } } = paginationOptions;
    const skip = (page - 1) * limit;

    const queryFilter = { ...filter, deletedAt: null };

    const countQuery = this.model.countDocuments(queryFilter);
    const findQuery = this.model
      .find(queryFilter)
      .sort(sort)
      .skip(skip)
      .limit(limit);

    if (options?.session) {
      countQuery.session(options.session);
      findQuery.session(options.session);
    }

    const [total, docs] = await Promise.all([
      countQuery.exec(),
      findQuery.exec(),
    ]);

    const domainObjects = docs.map((doc) => this.mapper.toDomain(doc));

    return {
      data: domainObjects,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Create a new entity.
   */
  async create(
    entity: DomainT,
    options?: RepositoryOptions
  ): Promise<DomainT> {
    const persistenceEntity = this.mapper.toPersistence(entity);
    // Mongoose create accepts array or single obj. We pass array for session support easily or single obj.
    // simpler:
    const [createdDoc] = await this.model.create(
      [persistenceEntity],
      options?.session ? { session: options.session } : {}
    );
    
    // create returns the doc, which we map back to domain (ensuring we have the ID etc)
    return this.mapper.toDomain(createdDoc as T);
  }

  /**
   * Soft delete a document by ID.
   * Can be exposed by subclasses or wrapped.
   */
  protected async softDelete(
    id: string,
    options?: RepositoryOptions
  ): Promise<void> {
     if (!Types.ObjectId.isValid(id)) return;
     
    const update = {
      deletedAt: new Date(),
    } as UpdateQuery<T>;

    const query = this.model.updateOne(
      { _id: id, deletedAt: null } as FilterQuery<T>,
      update
    );

    if (options?.session) {
      query.session(options.session);
    }

    await query.exec();
  }

  /**
   * Restore a soft-deleted document.
   */
  async restore(
    id: string,
    options?: RepositoryOptions
  ): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;

    const update = {
      deletedAt: null,
    } as UpdateQuery<T>;

    const query = this.model.updateOne(
      { _id: id, deletedAt: { $ne: null } } as FilterQuery<T>,
      update
    );

    if (options?.session) {
      query.session(options.session);
    }

    await query.exec();
  }

  /**
   * PROTECTED: Hard delete by ID.
   */
  protected async hardDelete(
    id: string,
    options?: RepositoryOptions
  ): Promise<void> {
     if (!Types.ObjectId.isValid(id)) return;

    const query = this.model.deleteOne({ _id: id } as FilterQuery<T>);

    if (options?.session) {
      query.session(options.session);
    }

    await query.exec();
  }
}
