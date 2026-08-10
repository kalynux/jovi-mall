/**
 * Two-sided stock adjustment for agency-warehoused SKUs.
 *
 * On an `agency_storage` product neither the vendor nor the agency writes
 * `ProductVariant.stock` alone: one proposes, the other approves, and the number
 * moves in the same transaction that records the approval.
 *
 * **Routes are deliberately NOT re-exported here.** Both routers pull in
 * `auth.middleware`, and the API layer imports them directly from `routes/*` — the
 * same rule the agents module documents, where re-exporting routes from the barrel
 * closed a require cycle that crashed at boot.
 */
export {
  StockAdjustmentRequestModel,
  type IStockAdjustmentRequest,
  type StockRequestParty,
  type StockRequestStatus,
} from './models/stock-adjustment-request.model';

export { StockAdjustmentRequestRepository } from './repositories/stock-adjustment-request.repository';

export {
  StockRequestService,
  stockRequestService,
  type StockRequestActor,
  type RaiseStockRequestCommand,
} from './services/stock-request.service';

/** The seam the three vendor stock write paths call. */
export {
  StockChangeGate,
  stockChangeGate,
  type StockChangeIntent,
} from './services/stock-change-gate';

export {
  StockRequestMapper,
  resolveAvailableActions,
  type StockRequestDto,
  type StockRequestAction,
} from './dto/stock-adjustment-request.dto';
