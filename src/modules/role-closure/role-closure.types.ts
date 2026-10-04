/**
 * Role closure — ADR-A10. Shared vocabulary for the request, the blockers and the manifest.
 *
 * An administrator asks to close ONE role a user holds; the user confirms while signed in as
 * that role; only then is the role anonymised. Closing the last role a user holds closes the
 * whole account, exactly as ADR-A02 self-closure does.
 */

/** Roles an administrator may close. `admin` is not a platform role any more. */
export const CLOSABLE_ROLES = ['customer', 'vendor', 'agency', 'agent'] as const;
export type ClosableRole = (typeof CLOSABLE_ROLES)[number];

export function isClosableRole(value: unknown): value is ClosableRole {
  return typeof value === 'string' && (CLOSABLE_ROLES as readonly string[]).includes(value);
}

export const ROLE_CLOSURE_REQUEST_STATUSES = [
  'pending',
  'confirmed',
  'declined',
  'cancelled',
  'expired',
] as const;
export type RoleClosureRequestStatus = (typeof ROLE_CLOSURE_REQUEST_STATUSES)[number];

/** O-3: the user has seven days to answer. */
export const ROLE_CLOSURE_REQUEST_TTL_DAYS = 7;

/**
 * One reason the role cannot close yet (O-2). The codes are a closed vocabulary — a dashboard
 * and wi-admin render copy per code — so add one here, in the evaluator, and in the api-doc
 * table together.
 */
export const ROLE_CLOSURE_BLOCKER_CODES = [
  // customer
  'orders_in_flight',
  'bookings_upcoming',
  // vendor
  'vendor_orders_in_flight',
  'vendor_bookings_open',
  'cod_collections_pending',
  'payout_request_held',
  'earnings_balance',
  'earnings_allocations_held',
  'agency_stock_held',
  'storage_invoices_open',
  'negotiations_open',
  'stock_requests_pending',
  // agency
  'shipments_unterminated',
  'cod_cash_held',
  'cod_remittances_declared',
  'cod_discrepancies_open',
  // agent
  'shipments_active',
  'shipments_handover_held',
  'offers_pending',
  'cod_deposits_declared',
] as const;
export type RoleClosureBlockerCode = (typeof ROLE_CLOSURE_BLOCKER_CODES)[number];

export interface RoleClosureBlocker {
  code: RoleClosureBlockerCode;
  /** How many rows hold the role open. */
  count: number;
  /** For money blockers: the amount at stake, in `currency`. */
  amount?: number;
  currency?: string;
}

/** O-6: things the user LOSES on closure. Shown before confirming, never blocking. */
export const ROLE_CLOSURE_WARNING_CODES = ['prepaid_plan_forfeited', 'credit_balance_forfeited'] as const;
export type RoleClosureWarningCode = (typeof ROLE_CLOSURE_WARNING_CODES)[number];

export interface RoleClosureWarning {
  code: RoleClosureWarningCode;
  /** The plan's code, for `prepaid_plan_forfeited`. */
  planCode?: string;
  /** When the forfeited term would have ended. */
  expiresAt?: Date;
  /** For `credit_balance_forfeited`: the credits lost. */
  amount?: number;
}

/** What the confirmation did, recorded on the request. */
export interface RoleClosureOutcome {
  closedAt: Date;
  /** True when this was the last role, so the whole account was closed (ADR-A02). */
  accountClosed: boolean;
  /** Contracts / connections ended automatically (O-5). */
  endedRelationships: number;
}
