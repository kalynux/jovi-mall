import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IOptionRepository } from '../../../repositories/interfaces/option.repository.interface';
import { IOptionValueRepository } from '../../../repositories/interfaces/option-value.repository.interface';
import { ProductOption } from '../../../repositories/mappers/option.mapper';
import { MAX_OPTIONS_PER_PRODUCT } from './constants';

export interface CreateOptionCommand {
  productId: string;
  vendorId: string;
  name: string;
  values: string[];
}

export interface AddOptionValuesCommand {
  optionId: string;
  productId: string;
  vendorId: string;
  values: string[];
}

export interface DeleteOptionCommand {
  optionId: string;
  productId: string;
  vendorId: string;
}

/**
 * OptionService: Manage product options and option values
 */
export class OptionService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly optionRepository: IOptionRepository,
    private readonly optionValueRepository: IOptionValueRepository,
    private readonly transactionManager: TransactionManager
  ) { }

  async createOption(command: CreateOptionCommand): Promise<ProductOption> {
    return this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (product.status !== 'draft' && product.status !== 'active') {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });
      }

      const existingCount = await this.optionRepository.countByProduct(command.productId, { session });
      if (existingCount >= MAX_OPTIONS_PER_PRODUCT) {
        throw createAppError(ERROR_CODES.CATALOG_OPTION_LIMIT_EXCEEDED, 422, undefined, { max: MAX_OPTIONS_PER_PRODUCT });
      }

      const existingOptions = await this.optionRepository.findByProduct(command.productId, { session });
      const nameExists = existingOptions.some(opt => opt.name.toLowerCase() === command.name.trim().toLowerCase());

      if (nameExists) throw createAppError(ERROR_CODES.CATALOG_OPTION_DUPLICATE_NAME, 409, undefined, { name: command.name });

      if (!command.values || command.values.length === 0) {
        throw createAppError(ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES, 422);
      }

      const trimmedValues = command.values.map(v => v.trim()).filter(v => v.length > 0);
      if (trimmedValues.length === 0) throw createAppError(ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES, 422);

      const uniqueValues = [...new Set(trimmedValues.map(v => v.toLowerCase()))];
      if (uniqueValues.length !== trimmedValues.length) {
        throw createAppError(ERROR_CODES.CATALOG_OPTION_DUPLICATE_VALUE, 422);
      }

      const option = await this.optionRepository.create({
        productId: command.productId,
        name: command.name.trim(),
        position: existingCount + 1,
        deletedAt: null,
        purgeAt: null,
      }, { session });

      await this.optionValueRepository.createMany(
        trimmedValues.map(value => ({ optionId: option.id, value, deletedAt: null, purgeAt: null })),
        { session }
      );

      return option;
    });
  }

  async addOptionValues(command: AddOptionValuesCommand): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (product.status !== 'draft' && product.status !== 'active') {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });
      }

      const option = await this.optionRepository.findById(command.optionId, { session });

      if (!option) throw createAppError(ERROR_CODES.CATALOG_OPTION_NOT_FOUND, 404);
      if (option.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_OPTION_ACCESS_DENIED, 403);

      if (!command.values || command.values.length === 0) {
        throw createAppError(ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES, 422);
      }

      const trimmedValues = command.values.map(v => v.trim()).filter(v => v.length > 0);
      if (trimmedValues.length === 0) throw createAppError(ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES, 422);

      const existingValues = await this.optionValueRepository.findByOption(command.optionId, { session });
      const existingValueSet = new Set(existingValues.map(v => v.value.toLowerCase()));
      const newValues = trimmedValues.filter(v => !existingValueSet.has(v.toLowerCase()));

      if (newValues.length === 0) throw createAppError(ERROR_CODES.CATALOG_OPTION_VALUES_EXIST, 409);

      await this.optionValueRepository.createMany(
        newValues.map(value => ({ optionId: command.optionId, value, deletedAt: null, purgeAt: null })),
        { session }
      );
    });
  }

  async deleteOption(command: DeleteOptionCommand): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });

      if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
      if (product.status !== 'draft' && product.status !== 'active') {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });
      }

      const option = await this.optionRepository.findById(command.optionId, { session });

      if (!option) throw createAppError(ERROR_CODES.CATALOG_OPTION_NOT_FOUND, 404);
      if (option.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_OPTION_ACCESS_DENIED, 403);

      await this.optionValueRepository.deleteByOption(command.optionId, { session });
      await this.optionRepository.delete(command.optionId, { session });
    });
  }
}
