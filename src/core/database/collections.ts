/**
 * Central Database Naming Registry
 *
 * Single source of truth for:
 *  - MODELS:      Mongoose model registration names. Used as the first argument
 *                 to `model()` AND in every `ref:` for populate(). Changing a
 *                 value here renames the model everywhere it is referenced.
 *  - COLLECTIONS: Physical MongoDB collection names. Passed as the third argument
 *                 to `model()` so the on-disk collection name is explicit and
 *                 decoupled from Mongoose's default pluralization rules.
 *
 * Rules:
 *  - Keys mirror the model name in SCREAMING_SNAKE_CASE.
 *  - COLLECTION values are snake_case and plural.
 *  - Object.freeze prevents mutation at runtime.
 *
 * To rename a collection in the DB: change only the COLLECTIONS value.
 * To rename a model in code:        change only the MODELS value.
 */

export const MODELS = Object.freeze({
  // Users & roles
  USER: 'User',
  ADMIN: 'Admin',
  CUSTOMER: 'Customer',
  VENDOR: 'Vendor',

  // Store
  STORE: 'Store',

  // Magazin (delivery agency's business surface — the Store-equivalent for agencies)
  AGENCY_MAGAZIN: 'AgencyMagazin',

  // Catalog
  PRODUCT: 'Product',
  PRODUCT_VARIANT: 'ProductVariant',
  PRODUCT_OPTION: 'ProductOption',
  PRODUCT_OPTION_VALUE: 'ProductOptionValue',
  SHIPPING_CONFIG: 'ShippingConfig',
  SERVICE_CONFIG: 'ServiceConfig',
  SERVICE_AVAILABILITY: 'ServiceAvailability',
  STOCK_RESERVATION: 'StockReservation',
  STOCK_AUDIT_LOG: 'StockAuditLog',
  // What an agency stores, per depot. Distinct from STOCK_RESERVATION (which is
  // vendor-global and has no location) — see modules/inventory.
  AGENCY_STOCK_LEVEL: 'AgencyStockLevel',
  // A proposed change to `ProductVariant.stock` on an agency-warehoused SKU,
  // awaiting the other party's approval — see modules/stock-requests.
  STOCK_ADJUSTMENT_REQUEST: 'StockAdjustmentRequest',
  FILE: 'File',
  FILE_REFERENCE: 'FileReference',
  FILE_CLEANUP_AUDIT: 'FileCleanupAudit',
  CATALOG_DIGITAL_ASSET: 'CatalogDigitalAsset',

  // Cart
  CART: 'Cart',

  // Orders
  ORDER: 'Order',
  ORDER_TIMELINE: 'OrderTimeline',
  VENDOR_ORDER_NOTE: 'VendorOrderNote',

  // Shipments & delivery
  SHIPMENT: 'Shipment',
  SHIPMENT_ASSIGNMENT_OFFER: 'ShipmentAssignmentOffer',
  SHIPMENT_ASSIGNMENT_SESSION: 'ShipmentAssignmentSession',
  DELIVERY_AGENCY: 'DeliveryAgency',
  DELIVERY_AGENT: 'DeliveryAgent',

  // Agent domain (agent ↔ agency contracts; an agent may serve many agencies,
  // each contract sub-allocating a slice of the agent's global COD threshold)
  AGENT_AGENCY_CONTRACT: 'AgentAgencyContract',
  AGENT_MEMBERSHIP_EVENT: 'AgentMembershipEvent',
  CONTRACT_STATUS_REQUEST: 'ContractStatusRequest',
  CONTRACT_TERMS_PROPOSAL: 'ContractTermsProposal',
  // No CONTRACT_SETTLEMENT: agent→agency cash settles through AgentDeposit +
  // CodCashLedger, and the platform pays the agent through the earnings module.
  // A third ledger for the same movements was removed rather than filled in.

  // Vendor <-> agency connections
  VENDOR_AGENCY_CONNECTION: 'VendorAgencyConnection',

  // Live-tracking integration (outbox → geo-tracker service)
  TRACKING_OUTBOX: 'TrackingOutbox',

  // System operations — the maintenance-mode singleton
  SYSTEM_STATE: 'SystemState',

  /**
   * System logs (Phase 15) — a CAPPED collection with no Mongoose model, deliberately.
   *
   * It is listed here so the collection registry stays the single source of truth for physical
   * names, but `core/logging/mongo-sink.ts` reaches it through the raw driver. Compiling a
   * Mongoose model for it would let `autoIndex` create the collection UNCAPPED before
   * `enableLogPersistence()` gets to create it properly — and a capped collection cannot be
   * converted afterwards. See that file's header.
   */
  SYSTEM_LOG: 'SystemLog',

  // Payments
  PAYMENT_TRANSACTION: 'PaymentTransaction',
  REFUND_TRANSACTION: 'RefundTransaction',
  USER_PAYMENT_METHOD: 'UserPaymentMethod',

  // Booking
  BOOKING: 'Booking',
  AVAILABILITY_RULE: 'AvailabilityRule',
  EXTERNAL_CALENDAR_BLOCK: 'ExternalCalendarBlock',

  // Digital delivery
  DIGITAL_ASSET: 'DigitalAsset',
  CUSTOMER_DIGITAL_ENTITLEMENT: 'CustomerDigitalEntitlement',

  // Tickets
  TICKET: 'Ticket',
  TICKET_NOTE: 'TicketNote',
  TICKET_FOLLOWER: 'TicketFollower',
  TICKET_ATTACHMENT: 'TicketAttachment',

  // Vendor analytics & settings
  VENDOR_SETTINGS: 'VendorSettings',
  VENDOR_CUSTOMER: 'VendorCustomer',
  VENDOR_DAILY_METRICS: 'VendorDailyMetrics',
  VENDOR_VARIANT_DAILY_METRICS: 'VendorVariantDailyMetrics',

  // Notifications
  VENDOR_NOTIFICATION: 'VendorNotification',
  VENDOR_NOTIFICATION_PREFERENCE: 'VendorNotificationPreference',
  AGENCY_NOTIFICATION: 'AgencyNotification',
  AGENCY_NOTIFICATION_PREFERENCE: 'AgencyNotificationPreference',
  AGENT_NOTIFICATION: 'AgentNotification',
  AGENT_NOTIFICATION_PREFERENCE: 'AgentNotificationPreference',
  CUSTOMER_NOTIFICATION: 'CustomerNotification',
  CUSTOMER_NOTIFICATION_PREFERENCE: 'CustomerNotificationPreference',
  DEVICE_TOKEN: 'DeviceToken',

  // Integrations
  CONNECTED_CALENDAR_ACCOUNT: 'ConnectedCalendarAccount',
  CHANNEL_CONNECTION: 'ChannelConnection',

  // Billing (pricing plans & credit wallet)
  PRICING_PLAN: 'PricingPlan',
  SUBSCRIBER_PLAN: 'SubscriberPlan',
  CREDIT_WALLET: 'CreditWallet',
  CREDIT_TRANSACTION: 'CreditTransaction',
  CREDIT_TOPUP: 'CreditTopup',
  PLAN_PURCHASE: 'PlanPurchase',
  BILLING_SETTINGS: 'BillingSettings',

  // Earnings (commission, escrow & payout ledger)
  EARNINGS_ACCOUNT: 'EarningsAccount',
  EARNINGS_ALLOCATION: 'EarningsAllocation',
  EARNINGS_LEDGER: 'EarningsLedger',
  EARNINGS_RESERVE_HOLD: 'EarningsReserveHold',
  PAYOUT_REQUEST: 'PayoutRequest',

  // Blog / editorial (the marketing site's article pages)
  ARTICLE: 'Article',
  ARTICLE_AUTHOR: 'ArticleAuthor',

  // COD (cash on delivery: collections, cash liabilities, reconciliation)
  CASH_COLLECTION: 'CashCollection',
  COD_CASH_ACCOUNT: 'CodCashAccount',
  COD_CASH_LEDGER: 'CodCashLedger',
  AGENT_DEPOSIT: 'AgentDeposit',
  AGENCY_REMITTANCE: 'AgencyRemittance',
  COD_DISCREPANCY: 'CodDiscrepancy',
  COD_TRUST_EVENT: 'CodTrustEvent',
} as const);

export const COLLECTIONS = Object.freeze({
  // Users & roles
  USER: 'users',
  ADMIN: 'admins',
  CUSTOMER: 'customers',
  VENDOR: 'vendors',

  // Store
  STORE: 'stores',

  // Magazin (delivery agency's business surface — the Store-equivalent for agencies)
  AGENCY_MAGAZIN: 'agency_magazins',

  // Catalog
  PRODUCT: 'products',
  PRODUCT_VARIANT: 'product_variants',
  PRODUCT_OPTION: 'product_options',
  PRODUCT_OPTION_VALUE: 'product_option_values',
  SHIPPING_CONFIG: 'shipping_configs',
  SERVICE_CONFIG: 'service_configs',
  SERVICE_AVAILABILITY: 'service_availabilities',
  STOCK_RESERVATION: 'stock_reservations',
  STOCK_AUDIT_LOG: 'stock_audit_logs',
  AGENCY_STOCK_LEVEL: 'agency_stock_levels',
  STOCK_ADJUSTMENT_REQUEST: 'stock_adjustment_requests',
  FILE: 'files',
  FILE_REFERENCE: 'file_references',
  FILE_CLEANUP_AUDIT: 'file_cleanup_audit',
  CATALOG_DIGITAL_ASSET: 'catalog_digital_assets',

  // Cart
  CART: 'carts',

  // Orders
  ORDER: 'orders',
  ORDER_TIMELINE: 'order_timelines',
  VENDOR_ORDER_NOTE: 'vendor_order_notes',

  // Shipments & delivery
  SHIPMENT: 'shipments',
  SHIPMENT_ASSIGNMENT_OFFER: 'shipment_assignment_offers',
  SHIPMENT_ASSIGNMENT_SESSION: 'shipment_assignment_sessions',
  DELIVERY_AGENCY: 'delivery_agencies',
  DELIVERY_AGENT: 'delivery_agents',

  // Agent domain (agent ↔ agency contracts; an agent may serve many agencies,
  // each contract sub-allocating a slice of the agent's global COD threshold)
  AGENT_AGENCY_CONTRACT: 'agent_agency_contracts',
  AGENT_MEMBERSHIP_EVENT: 'agent_membership_events',
  CONTRACT_STATUS_REQUEST: 'contract_status_requests',
  CONTRACT_TERMS_PROPOSAL: 'contract_terms_proposals',

  // Vendor <-> agency connections
  VENDOR_AGENCY_CONNECTION: 'vendor_agency_connections',

  // Live-tracking integration (outbox → geo-tracker service)
  TRACKING_OUTBOX: 'tracking_outbox',

  // System operations — the maintenance-mode singleton
  SYSTEM_STATE: 'system_state',

  /** Capped, driver-managed. See the MODELS entry above for why there is no Mongoose model. */
  SYSTEM_LOG: 'system_logs',

  // Payments
  PAYMENT_TRANSACTION: 'payment_transactions',
  REFUND_TRANSACTION: 'refund_transactions',
  USER_PAYMENT_METHOD: 'user_payment_methods',

  // Booking
  BOOKING: 'bookings',
  AVAILABILITY_RULE: 'availability_rules',
  EXTERNAL_CALENDAR_BLOCK: 'external_calendar_blocks',

  // Digital delivery
  DIGITAL_ASSET: 'digital_assets',
  CUSTOMER_DIGITAL_ENTITLEMENT: 'customer_digital_entitlements',

  // Tickets
  TICKET: 'tickets',
  TICKET_NOTE: 'ticket_notes',
  TICKET_FOLLOWER: 'ticket_followers',
  TICKET_ATTACHMENT: 'ticket_attachments',

  // Vendor analytics & settings
  VENDOR_SETTINGS: 'vendor_settings',
  VENDOR_CUSTOMER: 'vendor_customers',
  VENDOR_DAILY_METRICS: 'vendor_daily_metrics',
  VENDOR_VARIANT_DAILY_METRICS: 'vendor_variant_daily_metrics',

  // Notifications
  VENDOR_NOTIFICATION: 'vendor_notifications',
  VENDOR_NOTIFICATION_PREFERENCE: 'vendor_notification_preferences',
  AGENCY_NOTIFICATION: 'agency_notifications',
  AGENCY_NOTIFICATION_PREFERENCE: 'agency_notification_preferences',
  AGENT_NOTIFICATION: 'agent_notifications',
  AGENT_NOTIFICATION_PREFERENCE: 'agent_notification_preferences',
  CUSTOMER_NOTIFICATION: 'customer_notifications',
  CUSTOMER_NOTIFICATION_PREFERENCE: 'customer_notification_preferences',
  DEVICE_TOKEN: 'device_tokens',

  // Integrations
  CONNECTED_CALENDAR_ACCOUNT: 'connected_calendar_accounts',
  CHANNEL_CONNECTION: 'channel_connections',

  // Billing (pricing plans & credit wallet)
  PRICING_PLAN: 'pricing_plans',
  SUBSCRIBER_PLAN: 'subscriber_plans',
  CREDIT_WALLET: 'credit_wallets',
  CREDIT_TRANSACTION: 'credit_transactions',
  CREDIT_TOPUP: 'credit_topups',
  PLAN_PURCHASE: 'plan_purchases',
  BILLING_SETTINGS: 'billing_settings',

  // Earnings (commission, escrow & payout ledger)
  EARNINGS_ACCOUNT: 'earnings_accounts',
  EARNINGS_ALLOCATION: 'earnings_allocations',
  EARNINGS_LEDGER: 'earnings_ledgers',
  EARNINGS_RESERVE_HOLD: 'earnings_reserve_holds',
  PAYOUT_REQUEST: 'payout_requests',

  // Blog / editorial (the marketing site's article pages)
  ARTICLE: 'articles',
  ARTICLE_AUTHOR: 'article_authors',

  // COD (cash on delivery: collections, cash liabilities, reconciliation)
  CASH_COLLECTION: 'cash_collections',
  COD_CASH_ACCOUNT: 'cod_cash_accounts',
  COD_CASH_LEDGER: 'cod_cash_ledgers',
  AGENT_DEPOSIT: 'agent_deposits',
  AGENCY_REMITTANCE: 'agency_remittances',
  COD_DISCREPANCY: 'cod_discrepancies',
  COD_TRUST_EVENT: 'cod_trust_events',

  /**
   * Administrative actions performed on THIS service (Phase 12).
   *
   * Interim: it exists because the dashboard still calls `/api/admin/*` here until the
   * cutover, and those actions were recorded nowhere. wi-admin reads it directly and serves
   * it on a separate, labelled endpoint — it is NOT the compliance record, which is
   * `admin_audit_log` in the `wi-admin` database.
   *
   * Deleted with the legacy surface at cutover.
   */
  ADMIN_ACTION_LOG: 'admin_action_log',
} as const);

export type ModelName = (typeof MODELS)[keyof typeof MODELS];
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
