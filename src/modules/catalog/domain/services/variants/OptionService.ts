import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from '../../../../../core/errors';
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
  values: string[]; // Initial option values
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
 * 
 * Business Rules:
 * - Max 3 options per product (Shopify-like)
 * - Option names must be unique per product
 * - Option values must be unique per option
 * - Only DRAFT or ACTIVE products can have options modified
 * - Vendor ownership validated via product
 */
export class OptionService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly optionRepository: IOptionRepository,
    private readonly optionValueRepository: IOptionValueRepository,
    private readonly transactionManager: TransactionManager
  ) {}

  /**
   * Create a new option with initial values
   */
  async createOption(command: CreateOptionCommand): Promise<ProductOption> {
    return this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      // Vendor ownership check
      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      // State validation
      if (product.status !== 'draft' && product.status !== 'active') {
        throw new ForbiddenError(`Cannot modify options for product in ${product.status.toUpperCase()} state`);
      }

      // 2. Check max options limit
      const existingCount = await this.optionRepository.countByProduct(command.productId, { session });
      
      if (existingCount >= MAX_OPTIONS_PER_PRODUCT) {
        throw new ValidationError(`Cannot add more than ${MAX_OPTIONS_PER_PRODUCT} options per product`);
      }

      // 3. Check for duplicate option name
      const existingOptions = await this.optionRepository.findByProduct(command.productId, { session });
      const nameExists = existingOptions.some(
        opt => opt.name.toLowerCase() === command.name.trim().toLowerCase()
      );

      if (nameExists) {
        throw new ConflictError(`Option "${command.name}" already exists for this product`);
      }

      // 4. Validate option values
      if (!command.values || command.values.length === 0) {
        throw new ValidationError('Option must have at least one value');
      }

      const trimmedValues = command.values.map(v => v.trim()).filter(v => v.length > 0);
      
      if (trimmedValues.length === 0) {
        throw new ValidationError('Option must have at least one non-empty value');
      }

      // Check for duplicate values
      const uniqueValues = [...new Set(trimmedValues.map(v => v.toLowerCase()))];
      if (uniqueValues.length !== trimmedValues.length) {
        throw new ValidationError('Option values must be unique');
      }

      // 5. Create option with position
      const option = await this.optionRepository.create({
        productId: command.productId,
        name: command.name.trim(),
        position: existingCount + 1, // 1-indexed position
        deletedAt: null,
        purgeAt: null,
      }, { session });

      // 6. Create option values
      await this.optionValueRepository.createMany(
        trimmedValues.map(value => ({
          optionId: option.id,
          value,
          deletedAt: null,
          purgeAt: null,
        })),
        { session }
      );

      return option;
    });
  }

  /**
   * Add values to an existing option
   */
  async addOptionValues(command: AddOptionValuesCommand): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      if (product.status !== 'draft' && product.status !== 'active') {
        throw new ForbiddenError(`Cannot modify options for product in ${product.status.toUpperCase()} state`);
      }

      // 2. Load option
      const option = await this.optionRepository.findById(command.optionId, { session });
      
      if (!option) {
        throw new NotFoundError('Option not found');
      }

      if (option.productId !== command.productId) {
        throw new ForbiddenError('Option does not belong to this product');
      }

      // 3. Validate new values
      if (!command.values || command.values.length === 0) {
        throw new ValidationError('Must provide at least one value to add');
      }

      const trimmedValues = command.values.map(v => v.trim()).filter(v => v.length > 0);
      
      if (trimmedValues.length === 0) {
        throw new ValidationError('Must provide at least one non-empty value');
      }

      // 4. Check for existing values
      const existingValues = await this.optionValueRepository.findByOption(command.optionId, { session });
      const existingValueSet = new Set(existingValues.map(v => v.value.toLowerCase()));

      const newValues = trimmedValues.filter(v => !existingValueSet.has(v.toLowerCase()));

      if (newValues.length === 0) {
        throw new ConflictError('All provided values already exist for this option');
      }

      // 5. Create new values
      await this.optionValueRepository.createMany(
        newValues.map(value => ({
          optionId: command.optionId,
          value,
          deletedAt: null,
          purgeAt: null,
        })),
        { session }
      );
    });
  }

  /**
   * Delete an option and its values
   * WARNING: Should trigger variant reconciliation afterward
   */
  async deleteOption(command: DeleteOptionCommand): Promise<void> {
    await this.transactionManager.runInTransaction(async (session) => {
      // 1. Load and validate product
      const product = await this.productRepository.findById(command.productId, command.vendorId, { session });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }

      if (product.vendorId !== command.vendorId) {
        throw new ForbiddenError('You do not have permission to modify this product');
      }

      if (product.status !== 'draft' && product.status !== 'active') {
        throw new ForbiddenError(`Cannot modify options for product in ${product.status.toUpperCase()} state`);
      }

      // 2. Load option
      const option = await this.optionRepository.findById(command.optionId, { session });
      
      if (!option) {
        throw new NotFoundError('Option not found');
      }

      if (option.productId !== command.productId) {
        throw new ForbiddenError('Option does not belong to this product');
      }

      // 3. Soft delete option and its values
      await this.optionValueRepository.deleteByOption(command.optionId, { session });
      await this.optionRepository.delete(command.optionId, { session });
    });
  }
}
