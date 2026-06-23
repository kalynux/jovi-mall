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
  DELIVERY_AGENCY: 'DeliveryAgency',
  DELIVERY_AGENT: 'DeliveryAgent',

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

  // Integrations
  CONNECTED_CALENDAR_ACCOUNT: 'ConnectedCalendarAccount',
  TELEGRAM_LINK: 'TelegramLink',

  // Billing (pricing plans & credit wallet)
  PRICING_PLAN: 'PricingPlan',
  VENDOR_PLAN: 'VendorPlan',
  CREDIT_WALLET: 'CreditWallet',
  CREDIT_TRANSACTION: 'CreditTransaction',
  CREDIT_TOPUP: 'CreditTopup',
  PLAN_PURCHASE: 'PlanPurchase',

  // Earnings (commission, escrow & payout ledger)
  EARNINGS_ACCOUNT: 'EarningsAccount',
  EARNINGS_ALLOCATION: 'EarningsAllocation',
  EARNINGS_LEDGER: 'EarningsLedger',
} as const);

export const COLLECTIONS = Object.freeze({
  // Users & roles
  USER: 'users',
  ADMIN: 'admins',
  CUSTOMER: 'customers',
  VENDOR: 'vendors',

  // Store
  STORE: 'stores',

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
  DELIVERY_AGENCY: 'delivery_agencies',
  DELIVERY_AGENT: 'delivery_agents',

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

  // Integrations
  CONNECTED_CALENDAR_ACCOUNT: 'connected_calendar_accounts',
  TELEGRAM_LINK: 'telegram_links',

  // Billing (pricing plans & credit wallet)
  PRICING_PLAN: 'pricing_plans',
  VENDOR_PLAN: 'vendor_plans',
  CREDIT_WALLET: 'credit_wallets',
  CREDIT_TRANSACTION: 'credit_transactions',
  CREDIT_TOPUP: 'credit_topups',
  PLAN_PURCHASE: 'plan_purchases',

  // Earnings (commission, escrow & payout ledger)
  EARNINGS_ACCOUNT: 'earnings_accounts',
  EARNINGS_ALLOCATION: 'earnings_allocations',
  EARNINGS_LEDGER: 'earnings_ledgers',
} as const);

export type ModelName = (typeof MODELS)[keyof typeof MODELS];
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
