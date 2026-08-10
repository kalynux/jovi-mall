import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { TransactionManager, transactionManager } from '../../../core/database/transaction.manager';
import { Page, PaginationOptions } from '../../../core/repositories/base.repository';

// Concrete repository files, never a module barrel: catalog services import THIS
// module, so pulling in `catalog/index.ts` here would close a require cycle that
// crashes at boot. Same trap the agents module documents.
import { IProductRepository } from '../../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../../catalog/repositories/mongo/product.repository.mongo';
import { IVariantRepository } from '../../catalog/repositories/interfaces/variant.repository.interface';
import { VariantRepositoryMongo } from '../../catalog/repositories/mongo/variant.repository.mongo';
import { IStockAuditLogRepository } from '../../catalog/repositories/interfaces/stock-audit-log.repository.interface';
import { StockAuditLogRepositoryMongo } from '../../catalog/repositories/mongo/stock-audit-log.repository.mongo';
import { Product } from '../../catalog/repositories/mappers/product.mapper';
import { Variant } from '../../catalog/repositories/mappers/variant.mapper';
import {
  isWarehousedBy,
  resolveEffectiveAgencyId,
} from '../../catalog/domain/services/effective-delivery-agency';
import { VendorRepository } from '../../vendors/vendor.repository';

import {
  IStockAdjustmentRequest,
  StockRequestParty,
} from '../models/stock-adjustment-request.model';
import {
  StockAdjustmentRequestRepository,
  StockRequestListFilters,
} from '../repositories/stock-adjustment-request.repository';
import {
  StockRequestDto,
  StockRequestMapper,
  resolveAvailableActions,
} from '../dto/stock-adjustment-request.dto';
import { emitStockRequestEvent } from './stock-request.events';

/** Who is acting, and on whose behalf. */
export interface StockRequestActor {
  role: StockRequestParty;
  /** The role entity id — vendor id or agency id. */
  ownerId: string;
  userId: string | null;
}

export interface RaiseStockRequestCommand {
  productId: string;
  variantId: string;
  /**
   * The absolute target. Optional here (though **required** over HTTP) so
   * `StockChangeGate` can propose a change to the infinite flag alone without
   * having to read the variant itself just to restate the quantity it already has.
   */
  quantity?: number;
  isInfiniteStock?: boolean;
  note?: string | null;
}

/**
 * The two-sided stock-adjustment flow for agency-warehoused SKUs.
 *
 * ## The invariant
 *
 * On an `agency_storage` product, **nobody writes `variant.stock` alone.** One party
 * proposes, the other approves, and the number moves inside the same transaction
 * that records the approval. See the model docstring for why the number needs two
 * signatures.
 *
 * ## The authority table
 *
 * | verb | from | who |
 * |---|---|---|
 * | raise | — | either party |
 * | approve / reject | `pending` | the **counterparty** only |
 * | withdraw | `pending` | the **author** only |
 *
 * It lives once, in `resolveAvailableActions` (the DTO module), and both the
 * enforcement here and the buttons a dashboard renders read it. A second copy is
 * how a client ends up offering a verb the API refuses.
 *
 * ## Why approval applies the change transactionally
 *
 * A request marked `approved` whose stock never landed leaves the two parties
 * believing different things about a warehouse — the agency thinks it is holding
 * 90, the vendor's catalogue is still selling 120. The write, the audit row and the
 * status flip are therefore one commit.
 */
export class StockRequestService {
  constructor(
    private readonly requests: StockAdjustmentRequestRepository = new StockAdjustmentRequestRepository(),
    private readonly products: IProductRepository = new ProductRepositoryMongo(),
    private readonly variants: IVariantRepository = new VariantRepositoryMongo(),
    private readonly auditLogs: IStockAuditLogRepository = new StockAuditLogRepositoryMongo(),
    private readonly vendors: VendorRepository = new VendorRepository(),
    private readonly transactions: TransactionManager = transactionManager,
  ) { }

  // ─── Commands ──────────────────────────────────────────────────────────────

  /**
   * Raise a request. Symmetric: the same command from either role.
   *
   * Ownership is checked from the actor's own side — a vendor may only propose on
   * their own product, an agency only on a product it warehouses — and the
   * counterparty is *derived*, never supplied, so neither party can address a
   * request to an agency that has nothing to do with the goods.
   */
  async raise(actor: StockRequestActor, command: RaiseStockRequestCommand): Promise<StockRequestDto> {
    const { product, variant, agencyId } = await this.loadStorageContext(
      actor,
      command.productId,
      command.variantId,
    );

    const requestedInfinite = command.isInfiniteStock ?? variant.isInfiniteStock;
    const requestedQuantity = command.quantity ?? variant.stock;

    // Refused at CREATION, not at approval. An approvable request that would break
    // the product's own activation gate is a trap: the approver signs off, the
    // write lands, and the product silently stops being publishable. See
    // agency-storage-stock.rule.ts.
    if (requestedInfinite) {
      throw createAppError(
        ERROR_CODES.CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK,
        422,
        'This product is warehoused by an agency, so its stock must stay countable. Unlimited stock cannot be requested for it.',
        { variant: variant.name || variant.sku },
      );
    }

    if (requestedQuantity === variant.stock && requestedInfinite === variant.isInfiniteStock) {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_NO_CHANGE,
        422,
        'This is already the recorded quantity — there is nothing for the other party to approve.',
        { quantity: variant.stock },
      );
    }

    const open = await this.requests.findPendingByVariant(command.variantId);
    if (open) {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_ALREADY_PENDING,
        409,
        'A stock adjustment for this SKU is already awaiting a decision.',
        {
          requestId: open._id.toString(),
          requestedByRole: open.requested_by_role,
          hint: open.requested_by_role === actor.role
            ? 'Withdraw it before proposing a different quantity.'
            : 'Approve or reject it before proposing a different quantity.',
        },
      );
    }

    const now = new Date();
    let doc: IStockAdjustmentRequest;
    try {
      doc = await this.requests.create({
        vendor_id: product.vendorId as never,
        agency_id: agencyId as never,
        product_id: product.id as never,
        variant_id: variant.id as never,
        requested_by_role: actor.role,
        requested_by_user_id: (actor.userId ?? null) as never,
        requested_at: now,
        quantity_before: variant.stock,
        infinite_before: variant.isInfiniteStock,
        requested_quantity: requestedQuantity,
        requested_infinite: requestedInfinite,
        status: 'pending',
        note: command.note ?? null,
        status_history: [{
          status: 'pending',
          changed_at: now,
          changed_by_role: actor.role,
          changed_by_user_id: (actor.userId ?? null) as never,
          note: command.note ?? null,
        }],
      });
    } catch (error) {
      // The one-open-per-SKU unique index, lost race. The pre-check above closes
      // the common case; this closes the window between it and the insert.
      if ((error as { code?: number }).code === 11000) {
        throw createAppError(
          ERROR_CODES.STOCK_REQUEST_ALREADY_PENDING,
          409,
          'A stock adjustment for this SKU is already awaiting a decision.',
          { variantId: variant.id },
        );
      }
      throw error;
    }

    emitStockRequestEvent(
      'storage.stock_request.received',
      doc,
      this.counterpartyOf(actor.role),
      { productTitle: product.title, sku: variant.sku },
    );

    return StockRequestMapper.toDto(doc, actor.role, {
      quantity: variant.stock,
      isInfinite: variant.isInfiniteStock,
    });
  }

  /**
   * Approve — and apply. One transaction covers the variant write, the audit row
   * and the status flip, so the three cannot disagree.
   *
   * `runInTransactionWithRetry` rather than the plain variant: two dashboards
   * answering the same request at the same instant is a legitimate race, and the
   * compare-and-set below re-evaluates correctly on a retry (the loser sees a
   * non-pending row and gets the honest conflict).
   */
  async approve(actor: StockRequestActor, requestId: string): Promise<StockRequestDto> {
    const request = await this.loadForActor(actor, requestId);
    this.assertMayAct(actor, request, 'approve');

    const doc = await this.transactions.runInTransactionWithRetry(async (session) => {
      // Re-derive the storage arrangement inside the transaction. A product
      // re-pointed at a different agency (or switched off agency storage) while the
      // request stood must not be settled by an agency that no longer holds it.
      await this.assertStillWarehoused(request, session);

      const variant = await this.variants.findById(request.variant_id.toString(), { session });
      if (!variant) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404, 'The SKU this request refers to no longer exists.');
      }

      const previousQuantity = variant.stock;

      const updated = await this.variants.update(
        variant.id,
        { stock: request.requested_quantity, isInfiniteStock: request.requested_infinite },
        { session },
      );
      if (!updated) {
        throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404, 'The SKU this request refers to no longer exists.');
      }

      await this.auditLogs.create({
        variantId: variant.id,
        productId: request.product_id.toString(),
        vendorId: request.vendor_id.toString(),
        previousQuantity,
        newQuantity: request.requested_quantity,
        delta: request.requested_quantity - previousQuantity,
        operation: 'adjustment',
        // The APPROVER is the actor: they are the one who authorised the movement.
        // `metadata.requestId` is what ties the row back to who proposed it.
        actorType: actor.role,
        actorId: actor.ownerId,
        metadata: { requestId: request._id.toString(), reason: request.note ?? undefined },
        timestamp: new Date(),
        deletedAt: null,
        purgeAt: null,
      }, { session });

      const resolvedAt = new Date();
      const settled = await this.requests.applyTransition(
        request._id.toString(),
        {
          status: 'approved',
          set: {
            approval: {
              by_role: actor.role,
              by_user_id: (actor.userId ?? null) as never,
              at: resolvedAt,
              quantity_at_apply: previousQuantity,
            },
          } as never,
          historyEntry: {
            status: 'approved',
            changed_at: resolvedAt,
            changed_by_role: actor.role,
            changed_by_user_id: (actor.userId ?? null) as never,
            note: null,
          },
        },
        session,
      );

      // A null return is a CONFLICT: the row exists, somebody else resolved it
      // first. Throwing aborts the transaction, so the stock write above is rolled
      // back with it — which is the point of doing both in one commit.
      if (!settled) {
        throw createAppError(
          ERROR_CODES.STOCK_REQUEST_NOT_PENDING,
          409,
          'This request was already resolved. Reload it before acting again.',
        );
      }

      return settled;
    });

    emitStockRequestEvent(
      'storage.stock_request.approved',
      doc,
      this.counterpartyOf(actor.role),
      await this.describe(doc),
    );

    return StockRequestMapper.toDto(doc, actor.role, {
      quantity: doc.requested_quantity,
      isInfinite: doc.requested_infinite,
    });
  }

  /** Reject — the counterparty declines. Nothing is written to the variant. */
  async reject(actor: StockRequestActor, requestId: string, reason?: string | null): Promise<StockRequestDto> {
    const request = await this.loadForActor(actor, requestId);
    this.assertMayAct(actor, request, 'reject');

    const at = new Date();
    const doc = await this.requests.applyTransition(request._id.toString(), {
      status: 'rejected',
      set: {
        rejection: {
          by_role: actor.role,
          by_user_id: (actor.userId ?? null) as never,
          at,
          reason: reason ?? null,
        },
      } as never,
      historyEntry: {
        status: 'rejected',
        changed_at: at,
        changed_by_role: actor.role,
        changed_by_user_id: (actor.userId ?? null) as never,
        note: reason ?? null,
      },
    });

    if (!doc) {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_NOT_PENDING,
        409,
        'This request was already resolved. Reload it before acting again.',
      );
    }

    emitStockRequestEvent(
      'storage.stock_request.rejected',
      doc,
      this.counterpartyOf(actor.role),
      await this.describe(doc),
    );

    return StockRequestMapper.toDto(doc, actor.role);
  }

  /**
   * Withdraw — the author retracts their own ask.
   *
   * No notification, matching the `connection.*` precedent: retracting a request
   * the other side had not acted on is not news they need pushed to them, and the
   * row stays in both inboxes either way.
   */
  async withdraw(actor: StockRequestActor, requestId: string): Promise<StockRequestDto> {
    const request = await this.loadForActor(actor, requestId);
    this.assertMayAct(actor, request, 'withdraw');

    const at = new Date();
    const doc = await this.requests.applyTransition(request._id.toString(), {
      status: 'withdrawn',
      set: {
        withdrawal: { by_role: actor.role, by_user_id: (actor.userId ?? null) as never, at },
      } as never,
      historyEntry: {
        status: 'withdrawn',
        changed_at: at,
        changed_by_role: actor.role,
        changed_by_user_id: (actor.userId ?? null) as never,
        note: null,
      },
    });

    if (!doc) {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_NOT_PENDING,
        409,
        'This request was already resolved. Reload it before acting again.',
      );
    }

    return StockRequestMapper.toDto(doc, actor.role);
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  async list(
    actor: StockRequestActor,
    filters: StockRequestListFilters,
    pagination: PaginationOptions,
  ): Promise<Page<StockRequestDto>> {
    const page = await this.requests.listForParty(actor.role, actor.ownerId, filters, pagination);

    // One batched variant read for the whole page, so `currentQuantity` (the drift
    // an approver needs to see) costs one query rather than one per row.
    const live = await this.loadLiveState(page.data);

    return {
      data: page.data.map(doc =>
        StockRequestMapper.toDto(doc, actor.role, live.get(doc.variant_id.toString()) ?? null),
      ),
      meta: page.meta,
    };
  }

  async getById(actor: StockRequestActor, requestId: string): Promise<StockRequestDto> {
    const request = await this.loadForActor(actor, requestId);
    const variant = await this.variants.findById(request.variant_id.toString());
    return StockRequestMapper.toDto(
      request,
      actor.role,
      variant ? { quantity: variant.stock, isInfinite: variant.isInfiniteStock } : null,
    );
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private counterpartyOf(role: StockRequestParty): StockRequestParty {
    return role === 'vendor' ? 'agency' : 'vendor';
  }

  /**
   * Product title + SKU for notification copy. Two extra reads on a resolve path,
   * paid so the recipient is told *which* SKU moved rather than an id — the
   * alternative is denormalising both onto the request, and a title that goes stale
   * the moment the vendor renames the product is worse than a lookup.
   */
  private async describe(
    request: IStockAdjustmentRequest,
  ): Promise<{ productTitle: string; sku: string }> {
    const [product, variant] = await Promise.all([
      this.products.findByIdUnscoped(request.product_id.toString()),
      this.variants.findById(request.variant_id.toString()),
    ]);
    return { productTitle: product?.title ?? '', sku: variant?.sku ?? '' };
  }

  /**
   * Load a request the actor is a party to. Scoped in the predicate itself, so
   * somebody else's request **404s rather than 403s** — whether a given request id
   * exists is not information this caller is owed.
   */
  private async loadForActor(actor: StockRequestActor, requestId: string): Promise<IStockAdjustmentRequest> {
    const request = await this.requests.findById(requestId);
    const ownField = actor.role === 'vendor' ? request?.vendor_id : request?.agency_id;

    if (!request || ownField?.toString() !== actor.ownerId) {
      throw createAppError(ERROR_CODES.STOCK_REQUEST_NOT_FOUND, 404, 'Stock adjustment request not found.');
    }
    return request;
  }

  /** The authority table, enforced from its single definition. */
  private assertMayAct(
    actor: StockRequestActor,
    request: IStockAdjustmentRequest,
    action: 'approve' | 'reject' | 'withdraw',
  ): void {
    if (request.status !== 'pending') {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_NOT_PENDING,
        409,
        `This request is ${request.status} and can no longer be changed.`,
        { status: request.status },
      );
    }

    const allowed = resolveAvailableActions(request.status, request.requested_by_role, actor.role);
    if (!allowed.includes(action)) {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_NOT_YOURS,
        403,
        request.requested_by_role === actor.role
          ? 'You raised this request — you may withdraw it, but the other party decides it.'
          : 'Only the party that raised this request may withdraw it.',
        { availableActions: allowed },
      );
    }
  }

  /**
   * Resolve (and authorise) the storage arrangement a request is about.
   *
   * The counterparty is derived here for both roles, from the same
   * override-then-default order used at activation and at checkout, so a vendor
   * cannot name an agency and an agency cannot claim a product.
   */
  private async loadStorageContext(
    actor: StockRequestActor,
    productId: string,
    variantId: string,
  ): Promise<{ product: Product; variant: Variant; agencyId: string }> {
    const notStored = (): never => {
      throw createAppError(
        ERROR_CODES.INVENTORY_PRODUCT_NOT_STORED_HERE,
        404,
        'No agency-storage arrangement was found for this product.',
      );
    };

    // A vendor reads their own product (scoped, so another vendor's 404s). An
    // agency has to read across vendors — its authorisation is the storage
    // arrangement checked below, not product ownership.
    const product = actor.role === 'vendor'
      ? await this.products.findById(productId, actor.ownerId)
      : await this.products.findByIdUnscoped(productId);
    if (!product) notStored();

    const vendor = await this.vendors.findById(product!.vendorId);
    const effectiveAgencyId = resolveEffectiveAgencyId(
      product!,
      vendor?.default_delivery_agency_id?.toString() ?? null,
    );

    const agencyId = actor.role === 'agency' ? actor.ownerId : effectiveAgencyId;
    if (!agencyId) notStored();

    if (!isWarehousedBy(product!, vendor?.default_delivery_agency_id?.toString() ?? null, agencyId!)) {
      notStored();
    }

    const variant = await this.variants.findById(variantId);
    if (!variant || variant.productId !== product!.id) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404, 'No such SKU on this product.');
    }
    if (variant.status !== 'active') {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422, 'This SKU is archived — its stock is not warehoused.');
    }

    return { product: product!, variant, agencyId: agencyId! };
  }

  /** Re-check on resolution that the arrangement the request assumed still holds. */
  private async assertStillWarehoused(
    request: IStockAdjustmentRequest,
    session: ClientSession,
  ): Promise<void> {
    const product = await this.products.findById(
      request.product_id.toString(),
      request.vendor_id.toString(),
      { session },
    );
    const vendor = await this.vendors.findById(request.vendor_id.toString(), session);

    if (
      !product ||
      !isWarehousedBy(
        product,
        vendor?.default_delivery_agency_id?.toString() ?? null,
        request.agency_id.toString(),
      )
    ) {
      throw createAppError(
        ERROR_CODES.STOCK_REQUEST_STALE,
        409,
        'This product is no longer warehoused by that agency, so the request can no longer be applied.',
      );
    }
  }

  /** Live variant state for a page of requests, keyed by variant id. */
  private async loadLiveState(
    docs: IStockAdjustmentRequest[],
  ): Promise<Map<string, { quantity: number; isInfinite: boolean }>> {
    const result = new Map<string, { quantity: number; isInfinite: boolean }>();
    if (docs.length === 0) return result;

    const productIds = [...new Set(docs.map(d => d.product_id.toString()))];
    const wanted = new Set(docs.map(d => d.variant_id.toString()));

    // Fetched per product rather than per variant: `IVariantRepository` exposes
    // `findByProduct` but no `findByIds`, and a page of requests is dominated by a
    // handful of products. Adding a batch method to that interface for this one
    // read would touch every implementation of it.
    for (const productId of productIds) {
      for (const variant of await this.variants.findByProduct(productId)) {
        if (wanted.has(variant.id)) {
          result.set(variant.id, { quantity: variant.stock, isInfinite: variant.isInfiniteStock });
        }
      }
    }

    return result;
  }
}

export const stockRequestService = new StockRequestService();
