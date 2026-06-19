import { ErrorCode, ERROR_CODES } from './error-codes';

/**
 * Base error class for all application errors.
 *
 * - `code`    — machine-readable, domain-prefixed identifier (from ERROR_CODES registry)
 * - `statusCode` — HTTP status code
 * - `isOperational` — true for expected domain errors; false for programming/infra bugs
 * - `details` — optional supplemental data (typed as Record<string, unknown>)
 *
 * The global error handler uses `isOperational` to decide log severity and
 * whether to mask the message in production.
 */
export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    public readonly isOperational = true,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * createAppError — primary factory for throwing domain errors.
 *
 * Use this in services and middleware instead of `throw new Error(...)`.
 *
 * @example
 *   throw createAppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401);
 *   throw createAppError(ERROR_CODES.PAYMENT_ORDER_NOT_FOUND, 404, undefined, { orderId });
 */

// export const defaultMessages: Partial<Record<ErrorCode, string>> = {
//     [ERROR_CODES.INTERNAL_SERVER_ERROR]: 'Something went wrong',
//     [ERROR_CODES.NOT_FOUND]: 'Resource not found',
//     [ERROR_CODES.VALIDATION_ERROR]: 'Validation failed',

//     [ERROR_CODES.AUTH_INVALID_CREDENTIALS]: 'Invalid credentials',
//     [ERROR_CODES.AUTH_TOKEN_EXPIRED]: 'Access token expired',
//     [ERROR_CODES.AUTH_TOKEN_INVALID]: 'Invalid token',
//     [ERROR_CODES.AUTH_MISSING_TOKEN]: 'Authentication token required',
//     [ERROR_CODES.AUTH_ROLE_NOT_FOUND]: 'User does not have this role',
//     [ERROR_CODES.AUTH_ROLE_ALREADY_EXISTS]: 'User already has this role',
//     [ERROR_CODES.AUTH_ROLE_REQUIRED]: 'Role selection required',
//     [ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND]: 'Account not found',
//     [ERROR_CODES.AUTH_PHONE_TAKEN]: 'User with this phone already exists',
//     [ERROR_CODES.AUTH_EMAIL_TAKEN]: 'User with this email already exists',
//     [ERROR_CODES.AUTH_EMAIL_ALREADY_VERIFIED]: 'Email is already verified',
//     [ERROR_CODES.AUTH_EMAIL_MISSING]: 'No email address to verify',
//     [ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID]: 'Invalid or expired verification token',
//     [ERROR_CODES.AUTH_WA_ALREADY_VERIFIED]: 'WhatsApp already verified for this role',
//     [ERROR_CODES.AUTH_PROFILE_NOT_FOUND]: 'Role profile not found',
//     [ERROR_CODES.AUTH_PHONE_REQUIRED_FOR_WA]: 'A phone number is required to verify WhatsApp',
//     [ERROR_CODES.AUTH_UNSUPPORTED_ROLE]: 'This role is not supported',
//     [ERROR_CODES.AUTH_REFRESH_TOKEN_INVALID]: 'Invalid or expired refresh token',
//     [ERROR_CODES.AUTH_SESSION_EXPIRED]: 'Session expired, please log in again',
//     [ERROR_CODES.AUTH_USER_NOT_FOUND]: 'User not found',
//     [ERROR_CODES.AUTH_ROLE_PROFILE_NOT_FOUND]: 'Role profile not found',
//     [ERROR_CODES.AUTH_WA_PHONE_ID_REQUIRED]: 'wa_phone_id is required',

//     [ERROR_CODES.PAYMENT_ORDER_NOT_FOUND]: 'Order not found',
//     [ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID]: 'Order is already paid',
//     [ERROR_CODES.PAYMENT_INVALID_ORDER_STATUS]: 'Invalid order status for payment',
//     [ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED]: 'Payment gateway not supported',
//     [ERROR_CODES.PAYMENT_INITIATION_FAILED]: 'Payment initiation failed',
//     [ERROR_CODES.PAYMENT_VERIFICATION_FAILED]: 'Payment verification failed',
//     [ERROR_CODES.PAYMENT_BOOKING_NOT_FOUND]: 'Booking not found',
//     [ERROR_CODES.PAYMENT_BOOKING_CANCELLED]: 'Cannot pay for a cancelled booking',
//     [ERROR_CODES.PAYMENT_BOOKING_NO_PAYMENT_REQUIRED]: 'This booking does not require payment',
//     [ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID]: 'Booking is already paid',
//     [ERROR_CODES.PAYMENT_BOOKING_IN_PROGRESS]: 'Payment already in progress',
//     [ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND]: 'Payment transaction not found',
//     [ERROR_CODES.PAYMENT_WEBHOOK_INVALID_PAYLOAD]: 'Could not extract gateway reference from webhook payload',
//     [ERROR_CODES.PAYMENT_MISSING_BOOKING_ID]: 'Transaction does not have a bookingId',
//     [ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED]: 'Payment gateway not yet implemented',
//     [ERROR_CODES.PAYMENT_CARD_DECLINED]: 'Card was declined',

//     [ERROR_CODES.BOOKING_NOT_FOUND]: 'Booking not found',
//     [ERROR_CODES.BOOKING_INVALID_STATUS_TRANSITION]: 'Invalid status transition',

//     [ERROR_CODES.TICKET_NOT_FOUND]: 'Ticket not found',
//     [ERROR_CODES.TICKET_UPDATE_FAILED]: 'Failed to update ticket status',
//     [ERROR_CODES.TICKET_ASSIGN_FAILED]: 'Failed to assign ticket',
//     [ERROR_CODES.TICKET_PRIORITY_UPDATE_FAILED]: 'Failed to update priority',
//     [ERROR_CODES.TICKET_CLOSE_FAILED]: 'Failed to close ticket',
//     [ERROR_CODES.TICKET_REOPEN_FAILED]: 'Failed to reopen ticket',
//     [ERROR_CODES.TICKET_GENERAL_UPDATE_FAILED]: 'Failed to update ticket',
//     [ERROR_CODES.TICKET_ACCESS_DENIED]: 'Access to this ticket is denied',
//     [ERROR_CODES.TICKET_FOLLOWER_LIMIT_EXCEEDED]: 'Maximum of 5 non-admin followers per ticket exceeded',
//     [ERROR_CODES.TICKET_ATTACHMENT_LIMIT_EXCEEDED]: 'Maximum of 5 attachments per ticket exceeded',
//     [ERROR_CODES.TICKET_ATTACHMENT_MISSING]: 'Attachment file is required',
//     [ERROR_CODES.TICKET_PRIORITY_LOCKED]: 'Priority is locked and cannot be modified',
//     [ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION]: 'Invalid status transition',
//     [ERROR_CODES.TICKET_CUSTOMER_PRIVATE_NOTE_FORBIDDEN]: 'Customers can only create public notes',

//     [ERROR_CODES.DIGITAL_INVALID_ENTITLEMENT_ID]: 'Invalid entitlement ID',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND]: 'Entitlement not found',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_UNAUTHORIZED]: 'This entitlement does not belong to you',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_REVOKED]: 'This entitlement has been revoked',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED]: 'This entitlement has expired',
//     [ERROR_CODES.DIGITAL_DOWNLOAD_LIMIT_EXCEEDED]: 'Download limit exceeded',
//     [ERROR_CODES.DIGITAL_TOKEN_INVALID]: 'Invalid, expired, or already used token',

//     [ERROR_CODES.WHATSAPP_ROLE_NOT_SUPPORTED]: 'This role does not support WhatsApp linking',
//     [ERROR_CODES.WHATSAPP_NOT_LINKED]: 'No WhatsApp account linked',

//     [ERROR_CODES.TELEGRAM_NOT_LINKED]: 'No Telegram account linked',
//     [ERROR_CODES.TELEGRAM_LINK_FAILED]: 'Failed to create or update Telegram link',
//     [ERROR_CODES.TELEGRAM_LINK_NOT_FOUND]: 'Telegram link not found',

//     [ERROR_CODES.GOOGLE_MISSING_CLIENT_ID]: 'GOOGLE_CLIENT_ID is not configured',
//     [ERROR_CODES.GOOGLE_MISSING_CLIENT_SECRET]: 'GOOGLE_CLIENT_SECRET is not configured',
//     [ERROR_CODES.GOOGLE_MISSING_REDIRECT_URI]: 'GOOGLE_REDIRECT_URI is not configured',
//     [ERROR_CODES.GOOGLE_PROFILE_FETCH_FAILED]: 'Failed to retrieve user profile from Google',
//     [ERROR_CODES.GOOGLE_NO_ACCESS_TOKEN]: 'No access token received from Google',
//     [ERROR_CODES.GOOGLE_NO_REFRESH_TOKEN]: 'No refresh token received. Please reconnect Google.',
//     [ERROR_CODES.GOOGLE_CALENDAR_NOT_CONNECTED]: 'Google Calendar is not connected',
//     [ERROR_CODES.GOOGLE_EVENT_MISSING_ID]: 'Google event is missing an ID',
//     [ERROR_CODES.GOOGLE_EVENT_MISSING_DATETIME]: 'Google event is missing start/end dateTime',
//     [ERROR_CODES.GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING]: 'GOOGLE_TOKEN_ENCRYPTION_KEY is not defined',
//     [ERROR_CODES.GOOGLE_TOKEN_INVALID_FORMAT]: 'Invalid encrypted token format',
//     [ERROR_CODES.INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER]: 'Unsupported calendar provider',

//     [ERROR_CODES.DATABASE_UNAVAILABLE]: 'Database connection not available',
//     [ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION]: 'A record with this value already exists',

//     [ERROR_CODES.ORDER_NOT_FOUND]: 'Order not found',
//     [ERROR_CODES.ORDER_PAYMENT_FAILED]: 'Order payment failed',

//     [ERROR_CODES.CONFIG_MISSING_WA_ACCESS_TOKEN]: 'WHATSAPP_ACCESS_TOKEN environment variable is required',
//     [ERROR_CODES.CONFIG_MISSING_WA_PHONE_ID]: 'WHATSAPP_PHONE_NUMBER_ID environment variable is required',

//     [ERROR_CODES.MAIL_TEMPLATE_NOT_FOUND]: 'Mail template not found',

//     [ERROR_CODES.VENDOR_FISCAL_CALENDAR_INVALID]: 'Invalid fiscal calendar configuration',

//     [ERROR_CODES.CATALOG_INSUFFICIENT_STOCK]: 'Insufficient stock available',
//     [ERROR_CODES.CATALOG_OVERSALE_NOT_ALLOWED]: 'Operation would result in negative stock. Overselling not allowed.',
//     [ERROR_CODES.CATALOG_INVALID_CSV_FORMAT]: 'Invalid CSV format. Required headers: variantId, quantity',
//     [ERROR_CODES.CATALOG_BULK_VALIDATION_FAILED]: 'Bulk validation failed',
//     [ERROR_CODES.CATALOG_RESERVATION_EXPIRED]: 'Reservation has expired',
//     [ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED]: 'Bulk update limit exceeded',
//     [ERROR_CODES.CATALOG_TRANSACTION_LIMIT_EXCEEDED]: 'Batch size too large. Please reduce to fewer rows.',

//     [ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE]: 'Invalid date range provided',
//     [ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE]: 'Timezone is not supported',
//     [ERROR_CODES.ANALYTICS_AGGREGATION_NOT_READY]: 'Analytics data not yet available for requested period',
//     [ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED]: 'Date range cannot exceed the maximum allowed',

//     [ERROR_CODES.AUTH_FORBIDDEN]: 'auth forbidden',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_ALREADY_REVOKED]: 'digital entitlement already revoked',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_REVOKED]: 'digital entitlement not revoked',
//     [ERROR_CODES.DATABASE_CONNECTION_ERROR]: 'database connection error',
//     [ERROR_CODES.ORDER_TERMINAL_STATE]: 'order terminal state',
//     [ERROR_CODES.ORDER_INVALID_TRANSITION]: 'order invalid transition',
//     [ERROR_CODES.ORDER_PAYMENT_REQUIRED]: 'order payment required',
//     [ERROR_CODES.ORDER_PAYMENT_FAILED_STATE]: 'order payment failed state',
//     [ERROR_CODES.ORDER_WRONG_TYPE]: 'order wrong type',
//     [ERROR_CODES.ORDER_DELIVERY_AGENCY_NOT_FOUND]: 'order delivery agency not found',
//     [ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER]: 'config missing storage provider',
//     [ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER]: 'config invalid storage provider',
//     [ERROR_CODES.STORAGE_UPLOAD_FAILED]: 'storage upload failed',
//     [ERROR_CODES.UPLOAD_POLICY_VIOLATION]: 'upload policy violation',
//     [ERROR_CODES.VENDOR_UNSUPPORTED_FISCAL_CALENDAR]: 'vendor unsupported fiscal calendar',
//     [ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND]: 'catalog product not found',
//     [ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED]: 'catalog product access denied',
//     [ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE]: 'catalog product invalid state',
//     [ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE]: 'catalog product invalid title',
//     [ERROR_CODES.CATALOG_PRODUCT_ALREADY_PUBLISHED]: 'catalog product already published',
//     [ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS]: 'catalog product no variants',
//     [ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT]: 'catalog product no default variant',
//     [ERROR_CODES.CATALOG_PRODUCT_DIGITAL_NO_ASSET]: 'catalog product digital no asset',
//     [ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION]: 'catalog product service no duration',
//     [ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE]: 'catalog product variant zero price',
//     [ERROR_CODES.CATALOG_PRODUCT_NOT_DIGITAL]: 'catalog product not digital',
//     [ERROR_CODES.CATALOG_PRODUCT_NO_DIGITAL_CONFIG]: 'catalog product no digital config',
//     [ERROR_CODES.CATALOG_VARIANT_NOT_FOUND]: 'catalog variant not found',
//     [ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED]: 'catalog variant access denied',
//     [ERROR_CODES.CATALOG_VARIANT_ARCHIVED]: 'catalog variant archived',
//     [ERROR_CODES.CATALOG_VARIANT_INVALID_STOCK]: 'catalog variant invalid stock',
//     [ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE]: 'catalog variant invalid price',
//     [ERROR_CODES.CATALOG_VARIANT_COMPARE_PRICE_INVALID]: 'catalog variant compare price invalid',
//     [ERROR_CODES.CATALOG_VARIANT_LIMIT_EXCEEDED]: 'catalog variant limit exceeded',
//     [ERROR_CODES.CATALOG_VARIANT_NO_OPTIONS]: 'catalog variant no options',
//     [ERROR_CODES.CATALOG_VARIANT_OPTION_EMPTY]: 'catalog variant option empty',
//     [ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK]: 'catalog variant insufficient stock',
//     [ERROR_CODES.CATALOG_VARIANT_UNSUPPORTED_TYPE]: 'catalog variant unsupported type',
//     [ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET]: 'catalog variant no digital asset',
//     [ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY]: 'catalog variant invalid quantity',
//     [ERROR_CODES.CATALOG_VARIANT_STOCK_ONLY_PHYSICAL]: 'catalog variant stock only physical',
//     [ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT]: 'catalog variant reservation conflict',
//     [ERROR_CODES.CATALOG_OPTION_NOT_FOUND]: 'catalog option not found',
//     [ERROR_CODES.CATALOG_OPTION_ACCESS_DENIED]: 'catalog option access denied',
//     [ERROR_CODES.CATALOG_OPTION_LIMIT_EXCEEDED]: 'catalog option limit exceeded',
//     [ERROR_CODES.CATALOG_OPTION_DUPLICATE_NAME]: 'catalog option duplicate name',
//     [ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES]: 'catalog option requires values',
//     [ERROR_CODES.CATALOG_OPTION_DUPLICATE_VALUE]: 'catalog option duplicate value',
//     [ERROR_CODES.CATALOG_OPTION_VALUES_EXIST]: 'catalog option values exist',
//     [ERROR_CODES.CATALOG_OPTION_REQUIRES_NO_OPTIONS]: 'catalog option requires no options',
//     [ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE]: 'catalog product invalid type',
//     [ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS]: 'catalog variant sku exists',
//     [ERROR_CODES.CATALOG_INVALID_OPTION_ID]: 'catalog invalid option id',
//     [ERROR_CODES.CATALOG_INVALID_CSV]: 'catalog invalid csv',
//     [ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS]: 'catalog digital asset already exists',
//     [ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING]: 'catalog digital asset missing',
//     [ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING]: 'catalog digital config missing',
//     [ERROR_CODES.CATALOG_FILE_TOO_LARGE]: 'catalog file too large',
//     [ERROR_CODES.CATALOG_FILE_TYPE_INVALID]: 'catalog file type invalid',
//     [ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING_FILE]: 'catalog digital asset missing file',
//     [ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND]: 'catalog digital asset not found',
//     [ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND]: 'catalog variant reservation not found',
//     [ERROR_CODES.CATALOG_FILE_NOT_FOUND]: 'catalog file not found',
//     [ERROR_CODES.CATALOG_FILE_ALREADY_ATTACHED]: 'catalog file already attached',
//     [ERROR_CODES.CATALOG_FILE_STILL_REFERENCED]: 'catalog file still referenced',
//     [ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND]: 'catalog booking product not found',
//     [ERROR_CODES.CATALOG_BOOKING_INVALID_PRODUCT_TYPE]: 'catalog booking invalid product type',
//     [ERROR_CODES.CATALOG_BOOKING_MISSING_SERVICE_CONFIG]: 'catalog booking missing service config',
//     [ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_ACTIVE]: 'catalog booking product not active',
//     [ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE]: 'catalog booking invalid price',
//     [ERROR_CODES.CATALOG_BOOKING_NOT_IMPLEMENTED]: 'catalog booking not implemented',
//     [ERROR_CODES.CATALOG_BULK_EMPTY]: 'catalog bulk empty',
//     [ERROR_CODES.CATALOG_BULK_TRANSACTION_LIMIT]: 'catalog bulk transaction limit',
//     [ERROR_CODES.CATALOG_BULK_UPDATE_FAILED]: 'catalog bulk update failed',
//     [ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND]: 'delivery agency not found',
//     [ERROR_CODES.DELIVERY_AGENT_NOT_FOUND]: 'delivery agent not found',
//     [ERROR_CODES.CUSTOMER_NOT_FOUND]: 'customer not found',
//     [ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND]: 'customer address not found',
//     [ERROR_CODES.CUSTOMER_PAYMENT_METHOD_NOT_FOUND]: 'customer payment method not found',
//     [ERROR_CODES.USER_NOT_FOUND]: 'user not found',
//     [ERROR_CODES.USER_INVALID_PASSWORD]: 'user invalid password',
//     [ERROR_CODES.STORE_NOT_FOUND]: 'store not found',
//     [ERROR_CODES.STORE_SLUG_TAKEN]: 'store slug taken',
//     [ERROR_CODES.VENDOR_NOTIFICATION_NOT_FOUND]: 'vendor notification not found',
//     [ERROR_CODES.ORDER_CART_EMPTY]: 'order cart empty',
//     [ERROR_CODES.ORDER_CART_INVALID]: 'order cart invalid',
//     [ERROR_CODES.ORDER_PRODUCT_NOT_FOUND]: 'order product not found',
//     [ERROR_CODES.ORDER_VENDOR_NOT_FOUND]: 'order vendor not found',
//     [ERROR_CODES.ORDER_NO_DELIVERY_AGENCY]: 'order no delivery agency',
//     [ERROR_CODES.CART_VARIANT_REQUIRED]: 'cart variant required',
//     [ERROR_CODES.CART_PRODUCT_NOT_FOUND]: 'cart product not found',
//     [ERROR_CODES.CART_SERVICE_PRODUCT_NOT_ALLOWED]: 'cart service product not allowed',
//     [ERROR_CODES.CART_VARIANT_NOT_FOUND]: 'cart variant not found',
//     [ERROR_CODES.CART_VARIANT_PRODUCT_MISMATCH]: 'cart variant product mismatch',
//     [ERROR_CODES.CART_DIGITAL_QUANTITY_MUST_BE_ONE]: 'cart digital quantity must be one',
//     [ERROR_CODES.CART_MIXED_PRODUCT_TYPES]: 'cart mixed product types',
//     [ERROR_CODES.CART_DIGITAL_LIMIT_REACHED]: 'cart digital limit reached',
//     [ERROR_CODES.CART_NOT_FOUND]: 'cart not found',
//     [ERROR_CODES.CART_EMPTY_CHECKOUT]: 'cart empty checkout',
//     [ERROR_CODES.BOOKING_PRODUCT_NOT_FOUND]: 'booking product not found',
//     [ERROR_CODES.BOOKING_USER_NOT_FOUND]: 'booking user not found',
//     [ERROR_CODES.BOOKING_UNAUTHORIZED]: 'booking unauthorized',
//     [ERROR_CODES.BOOKING_ALREADY_CANCELLED]: 'booking already cancelled',
//     [ERROR_CODES.BOOKING_CALENDAR_SYNC_FAILED]: 'booking calendar sync failed',
//     [ERROR_CODES.BOOKING_PAYMENT_NOT_REQUIRED]: 'booking payment not required',
//     [ERROR_CODES.BOOKING_ALREADY_PAID]: 'booking already paid',
//     [ERROR_CODES.BOOKING_INVALID_PAYMENT_METHOD]: 'booking invalid payment method',
//     [ERROR_CODES.BOOKING_TERMINAL_STATE]: 'booking terminal state',
//     [ERROR_CODES.BOOKING_SLOT_NOT_LOCKED]: 'booking slot not locked',
//     [ERROR_CODES.BOOKING_FORBIDDEN]: 'booking forbidden',
//     [ERROR_CODES.BOOKING_INVALID_SLOT_ID]: 'booking invalid slot id',
//     [ERROR_CODES.ADMIN_NOT_FOUND]: 'admin not found',
//     [ERROR_CODES.ADMIN_FORBIDDEN]: 'admin forbidden',
//     [ERROR_CODES.AUTH_OAUTH_STATE_INVALID]: 'auth oauth state invalid',
//     [ERROR_CODES.AUTH_OAUTH_STATE_EXPIRED]: 'auth oauth state expired',
//     [ERROR_CODES.STORAGE_FILE_NOT_FOUND]: 'storage file not found',
//     [ERROR_CODES.STORAGE_DELETE_FAILED]: 'storage delete failed',
//     [ERROR_CODES.CATALOG_DIGITAL_ASSET_ACCESS_DENIED]: 'catalog digital asset access denied',
//     [ERROR_CODES.CATALOG_SHIPPING_NOT_FOUND]: 'catalog shipping not found',
//     [ERROR_CODES.CATALOG_SHIPPING_ACCESS_DENIED]: 'catalog shipping access denied',
//     [ERROR_CODES.COMMAND_ALREADY_REGISTERED]: 'command already registered',
//     [ERROR_CODES.COMMAND_NOT_FOUND]: 'command not found',
//     [ERROR_CODES.WHATSAPP_LINK_FAILED]: 'whatsapp link failed',
//     [ERROR_CODES.WHATSAPP_INVALID_PAYLOAD]: 'whatsapp invalid payload',
//     [ERROR_CODES.WHATSAPP_POLICY_VIOLATION]: 'whatsapp policy violation',
//     [ERROR_CODES.WHATSAPP_PROVIDER_REJECTED]: 'whatsapp provider rejected',
//     [ERROR_CODES.WHATSAPP_VALIDATION_ERROR]: 'whatsapp validation error',
//     [ERROR_CODES.WHATSAPP_IDEMPOTENCY_REQUIRED]: 'whatsapp idempotency required',
//     [ERROR_CODES.WHATSAPP_DUPLICATE_MESSAGE]: 'whatsapp duplicate message',
//     [ERROR_CODES.WHATSAPP_UNSUPPORTED_MESSAGE_TYPE]: 'whatsapp unsupported message type',
//     [ERROR_CODES.DIGITAL_ASSET_NOT_FOUND]: 'digital asset not found',
//     [ERROR_CODES.DIGITAL_ASSET_ACCESS_DENIED]: 'digital asset access denied',
//     [ERROR_CODES.DIGITAL_ASSET_IN_USE]: 'digital asset in use',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_MISSING]: 'digital entitlement config missing',
//     [ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_INACTIVE]: 'digital entitlement config inactive',
//   };

export function createAppError(
  code: ErrorCode,
  statusCode: number,
  message?: string,
  details?: Record<string, unknown>
): AppError {
  // Default messages keyed to code — keeps throw-sites terse
  const defaultMessages: Partial<Record<ErrorCode, string>> = {
    [ERROR_CODES.INTERNAL_SERVER_ERROR]: 'Something went wrong',
    [ERROR_CODES.NOT_FOUND]: 'Resource not found',
    [ERROR_CODES.VALIDATION_ERROR]: 'Validation failed',

    [ERROR_CODES.AUTH_INVALID_CREDENTIALS]: 'Invalid credentials',
    [ERROR_CODES.AUTH_TOKEN_EXPIRED]: 'Access token expired',
    [ERROR_CODES.AUTH_TOKEN_INVALID]: 'Invalid token',
    [ERROR_CODES.AUTH_MISSING_TOKEN]: 'Authentication token required',
    [ERROR_CODES.AUTH_ROLE_NOT_FOUND]: 'User does not have this role',
    [ERROR_CODES.AUTH_ROLE_ALREADY_EXISTS]: 'User already has this role',
    [ERROR_CODES.AUTH_ROLE_REQUIRED]: 'Role selection required',
    [ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND]: 'Account not found',
    [ERROR_CODES.AUTH_PHONE_TAKEN]: 'User with this phone already exists',
    [ERROR_CODES.AUTH_EMAIL_TAKEN]: 'User with this email already exists',
    [ERROR_CODES.AUTH_EMAIL_ALREADY_VERIFIED]: 'Email is already verified',
    [ERROR_CODES.AUTH_EMAIL_MISSING]: 'No email address to verify',
    [ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID]: 'Invalid or expired verification token',
    [ERROR_CODES.AUTH_WA_ALREADY_VERIFIED]: 'WhatsApp already verified for this role',
    [ERROR_CODES.AUTH_PROFILE_NOT_FOUND]: 'Role profile not found',
    [ERROR_CODES.AUTH_PHONE_REQUIRED_FOR_WA]: 'A phone number is required to verify WhatsApp',
    [ERROR_CODES.AUTH_UNSUPPORTED_ROLE]: 'This role is not supported',
    [ERROR_CODES.AUTH_REFRESH_TOKEN_INVALID]: 'Invalid or expired refresh token',
    [ERROR_CODES.AUTH_SESSION_EXPIRED]: 'Session expired, please log in again',
    [ERROR_CODES.AUTH_USER_NOT_FOUND]: 'User not found',
    [ERROR_CODES.AUTH_ROLE_PROFILE_NOT_FOUND]: 'Role profile not found',
    [ERROR_CODES.AUTH_WA_PHONE_ID_REQUIRED]: 'wa_phone_id is required',

    [ERROR_CODES.PAYMENT_ORDER_NOT_FOUND]: 'Order not found',
    [ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID]: 'Order is already paid',
    [ERROR_CODES.PAYMENT_INVALID_ORDER_STATUS]: 'Invalid order status for payment',
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED]: 'Payment gateway not supported',
    [ERROR_CODES.PAYMENT_INITIATION_FAILED]: 'Payment initiation failed',
    [ERROR_CODES.PAYMENT_VERIFICATION_FAILED]: 'Payment verification failed',
    [ERROR_CODES.PAYMENT_BOOKING_NOT_FOUND]: 'Booking not found',
    [ERROR_CODES.PAYMENT_BOOKING_CANCELLED]: 'Cannot pay for a cancelled booking',
    [ERROR_CODES.PAYMENT_BOOKING_NO_PAYMENT_REQUIRED]: 'This booking does not require payment',
    [ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID]: 'Booking is already paid',
    [ERROR_CODES.PAYMENT_BOOKING_IN_PROGRESS]: 'Payment already in progress',
    [ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND]: 'Payment transaction not found',
    [ERROR_CODES.PAYMENT_WEBHOOK_INVALID_PAYLOAD]: 'Could not extract gateway reference from webhook payload',
    [ERROR_CODES.PAYMENT_MISSING_BOOKING_ID]: 'Transaction does not have a bookingId',
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED]: 'Payment gateway not yet implemented',
    [ERROR_CODES.PAYMENT_CARD_DECLINED]: 'Card was declined',

    [ERROR_CODES.BOOKING_NOT_FOUND]: 'Booking not found',
    [ERROR_CODES.BOOKING_INVALID_STATUS_TRANSITION]: 'Invalid status transition',

    [ERROR_CODES.TICKET_NOT_FOUND]: 'Ticket not found',
    [ERROR_CODES.TICKET_UPDATE_FAILED]: 'Failed to update ticket status',
    [ERROR_CODES.TICKET_ASSIGN_FAILED]: 'Failed to assign ticket',
    [ERROR_CODES.TICKET_PRIORITY_UPDATE_FAILED]: 'Failed to update priority',
    [ERROR_CODES.TICKET_CLOSE_FAILED]: 'Failed to close ticket',
    [ERROR_CODES.TICKET_REOPEN_FAILED]: 'Failed to reopen ticket',
    [ERROR_CODES.TICKET_GENERAL_UPDATE_FAILED]: 'Failed to update ticket',
    [ERROR_CODES.TICKET_ACCESS_DENIED]: 'Access to this ticket is denied',
    [ERROR_CODES.TICKET_FOLLOWER_LIMIT_EXCEEDED]: 'Maximum of 5 non-admin followers per ticket exceeded',
    [ERROR_CODES.TICKET_ATTACHMENT_LIMIT_EXCEEDED]: 'Maximum of 5 attachments per ticket exceeded',
    [ERROR_CODES.TICKET_ATTACHMENT_MISSING]: 'Attachment file is required',
    [ERROR_CODES.TICKET_PRIORITY_LOCKED]: 'Priority is locked and cannot be modified',
    [ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION]: 'Invalid status transition',
    [ERROR_CODES.TICKET_CUSTOMER_PRIVATE_NOTE_FORBIDDEN]: 'Customers can only create public notes',

    [ERROR_CODES.DIGITAL_INVALID_ENTITLEMENT_ID]: 'Invalid entitlement ID',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND]: 'Entitlement not found',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_UNAUTHORIZED]: 'This entitlement does not belong to you',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_REVOKED]: 'This entitlement has been revoked',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED]: 'This entitlement has expired',
    [ERROR_CODES.DIGITAL_DOWNLOAD_LIMIT_EXCEEDED]: 'Download limit exceeded',
    [ERROR_CODES.DIGITAL_TOKEN_INVALID]: 'Invalid, expired, or already used token',

    [ERROR_CODES.WHATSAPP_ROLE_NOT_SUPPORTED]: 'This role does not support WhatsApp linking',
    [ERROR_CODES.WHATSAPP_NOT_LINKED]: 'No WhatsApp account linked',

    [ERROR_CODES.TELEGRAM_NOT_LINKED]: 'No Telegram account linked',
    [ERROR_CODES.TELEGRAM_LINK_FAILED]: 'Failed to create or update Telegram link',
    [ERROR_CODES.TELEGRAM_LINK_NOT_FOUND]: 'Telegram link not found',

    [ERROR_CODES.GOOGLE_MISSING_CLIENT_ID]: 'GOOGLE_CLIENT_ID is not configured',
    [ERROR_CODES.GOOGLE_MISSING_CLIENT_SECRET]: 'GOOGLE_CLIENT_SECRET is not configured',
    [ERROR_CODES.GOOGLE_MISSING_REDIRECT_URI]: 'GOOGLE_REDIRECT_URI is not configured',
    [ERROR_CODES.GOOGLE_PROFILE_FETCH_FAILED]: 'Failed to retrieve user profile from Google',
    [ERROR_CODES.GOOGLE_NO_ACCESS_TOKEN]: 'No access token received from Google',
    [ERROR_CODES.GOOGLE_NO_REFRESH_TOKEN]: 'No refresh token received. Please reconnect Google.',
    [ERROR_CODES.GOOGLE_CALENDAR_NOT_CONNECTED]: 'Google Calendar is not connected',
    [ERROR_CODES.GOOGLE_EVENT_MISSING_ID]: 'Google event is missing an ID',
    [ERROR_CODES.GOOGLE_EVENT_MISSING_DATETIME]: 'Google event is missing start/end dateTime',
    [ERROR_CODES.GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING]: 'GOOGLE_TOKEN_ENCRYPTION_KEY is not defined',
    [ERROR_CODES.GOOGLE_TOKEN_INVALID_FORMAT]: 'Invalid encrypted token format',
    [ERROR_CODES.INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER]: 'Unsupported calendar provider',

    [ERROR_CODES.DATABASE_UNAVAILABLE]: 'Database connection not available',
    [ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION]: 'A record with this value already exists',

    [ERROR_CODES.ORDER_NOT_FOUND]: 'Order not found',
    [ERROR_CODES.ORDER_PAYMENT_FAILED]: 'Order payment failed',

    [ERROR_CODES.CONFIG_MISSING_WA_ACCESS_TOKEN]: 'WHATSAPP_ACCESS_TOKEN environment variable is required',
    [ERROR_CODES.CONFIG_MISSING_WA_PHONE_ID]: 'WHATSAPP_PHONE_NUMBER_ID environment variable is required',

    [ERROR_CODES.MAIL_TEMPLATE_NOT_FOUND]: 'Mail template not found',

    [ERROR_CODES.VENDOR_FISCAL_CALENDAR_INVALID]: 'Invalid fiscal calendar configuration',
    [ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION]: 'Vendor profile was modified by another request. Please refresh and try again.',

    [ERROR_CODES.CATALOG_INSUFFICIENT_STOCK]: 'Insufficient stock available',
    [ERROR_CODES.CATALOG_OVERSALE_NOT_ALLOWED]: 'Operation would result in negative stock. Overselling not allowed.',
    [ERROR_CODES.CATALOG_INVALID_CSV_FORMAT]: 'Invalid CSV format. Required headers: variantId, quantity',
    [ERROR_CODES.CATALOG_BULK_VALIDATION_FAILED]: 'Bulk validation failed',
    [ERROR_CODES.CATALOG_RESERVATION_EXPIRED]: 'Reservation has expired',
    [ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED]: 'Bulk update limit exceeded',
    [ERROR_CODES.CATALOG_TRANSACTION_LIMIT_EXCEEDED]: 'Batch size too large. Please reduce to fewer rows.',

    [ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE]: 'Invalid date range provided',
    [ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE]: 'Timezone is not supported',
    [ERROR_CODES.ANALYTICS_AGGREGATION_NOT_READY]: 'Analytics data not yet available for requested period',
    [ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED]: 'Date range cannot exceed the maximum allowed',

    [ERROR_CODES.AUTH_FORBIDDEN]: 'auth forbidden',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_ALREADY_REVOKED]: 'digital entitlement already revoked',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_REVOKED]: 'digital entitlement not revoked',
    [ERROR_CODES.DATABASE_CONNECTION_ERROR]: 'database connection error',
    [ERROR_CODES.ORDER_TERMINAL_STATE]: 'order terminal state',
    [ERROR_CODES.ORDER_INVALID_TRANSITION]: 'order invalid transition',
    [ERROR_CODES.ORDER_PAYMENT_REQUIRED]: 'order payment required',
    [ERROR_CODES.ORDER_PAYMENT_FAILED_STATE]: 'order payment failed state',
    [ERROR_CODES.ORDER_WRONG_TYPE]: 'order wrong type',
    [ERROR_CODES.ORDER_DELIVERY_AGENCY_NOT_FOUND]: 'order delivery agency not found',
    [ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER]: 'config missing storage provider',
    [ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER]: 'config invalid storage provider',
    [ERROR_CODES.STORAGE_UPLOAD_FAILED]: 'storage upload failed',
    [ERROR_CODES.UPLOAD_POLICY_VIOLATION]: 'upload policy violation',
    [ERROR_CODES.VENDOR_UNSUPPORTED_FISCAL_CALENDAR]: 'vendor unsupported fiscal calendar',
    [ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND]: 'catalog product not found',
    [ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED]: 'catalog product access denied',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE]: 'catalog product invalid state',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE]: 'catalog product invalid title',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DESCRIPTION]: 'A description is required to activate or publish a product',
    [ERROR_CODES.CATALOG_PRODUCT_ALREADY_PUBLISHED]: 'catalog product already published',
    [ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS]: 'catalog product no variants',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT]: 'catalog product no default variant',
    [ERROR_CODES.CATALOG_PRODUCT_DIGITAL_NO_ASSET]: 'catalog product digital no asset',
    [ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION]: 'catalog product service no duration',
    [ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY]: 'Service products require at least one active availability rule to be activated',
    [ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE]: 'catalog product variant zero price',
    [ERROR_CODES.CATALOG_PRODUCT_NOT_DIGITAL]: 'catalog product not digital',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DIGITAL_CONFIG]: 'catalog product no digital config',
    [ERROR_CODES.CATALOG_VARIANT_NOT_FOUND]: 'catalog variant not found',
    [ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED]: 'catalog variant access denied',
    [ERROR_CODES.CATALOG_VARIANT_ARCHIVED]: 'catalog variant archived',
    [ERROR_CODES.CATALOG_VARIANT_INVALID_STOCK]: 'catalog variant invalid stock',
    [ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE]: 'catalog variant invalid price',
    [ERROR_CODES.CATALOG_VARIANT_COMPARE_PRICE_INVALID]: 'catalog variant compare price invalid',
    [ERROR_CODES.CATALOG_VARIANT_LIMIT_EXCEEDED]: 'catalog variant limit exceeded',
    [ERROR_CODES.CATALOG_VARIANT_NO_OPTIONS]: 'catalog variant no options',
    [ERROR_CODES.CATALOG_VARIANT_OPTION_EMPTY]: 'catalog variant option empty',
    [ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK]: 'catalog variant insufficient stock',
    [ERROR_CODES.CATALOG_VARIANT_UNSUPPORTED_TYPE]: 'catalog variant unsupported type',
    [ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET]: 'catalog variant no digital asset',
    [ERROR_CODES.CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED]: 'Digital products are limited to 5 active variants',
    [ERROR_CODES.CATALOG_SERVICE_VARIANT_EXISTS]: 'Service products may only have one variant',
    [ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY]: 'catalog variant invalid quantity',
    [ERROR_CODES.CATALOG_VARIANT_STOCK_ONLY_PHYSICAL]: 'catalog variant stock only physical',
    [ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT]: 'catalog variant reservation conflict',
    [ERROR_CODES.CATALOG_OPTION_NOT_FOUND]: 'catalog option not found',
    [ERROR_CODES.CATALOG_OPTION_ACCESS_DENIED]: 'catalog option access denied',
    [ERROR_CODES.CATALOG_OPTION_LIMIT_EXCEEDED]: 'catalog option limit exceeded',
    [ERROR_CODES.CATALOG_OPTION_DUPLICATE_NAME]: 'catalog option duplicate name',
    [ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES]: 'catalog option requires values',
    [ERROR_CODES.CATALOG_OPTION_DUPLICATE_VALUE]: 'catalog option duplicate value',
    [ERROR_CODES.CATALOG_OPTION_VALUES_EXIST]: 'catalog option values exist',
    [ERROR_CODES.CATALOG_OPTION_REQUIRES_NO_OPTIONS]: 'catalog option requires no options',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE]: 'catalog product invalid type',
    [ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS]: 'catalog variant sku exists',
    [ERROR_CODES.CATALOG_INVALID_OPTION_ID]: 'catalog invalid option id',
    [ERROR_CODES.CATALOG_INVALID_CSV]: 'catalog invalid csv',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS]: 'catalog digital asset already exists',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING]: 'catalog digital asset missing',
    [ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING]: 'catalog digital config missing',
    [ERROR_CODES.CATALOG_FILE_TOO_LARGE]: 'catalog file too large',
    [ERROR_CODES.CATALOG_FILE_TYPE_INVALID]: 'catalog file type invalid',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING_FILE]: 'catalog digital asset missing file',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND]: 'catalog digital asset not found',
    [ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND]: 'catalog variant reservation not found',
    [ERROR_CODES.CATALOG_FILE_NOT_FOUND]: 'catalog file not found',
    [ERROR_CODES.CATALOG_FILE_ALREADY_ATTACHED]: 'catalog file already attached',
    [ERROR_CODES.CATALOG_FILE_STILL_REFERENCED]: 'catalog file still referenced',
    [ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND]: 'catalog booking product not found',
    [ERROR_CODES.CATALOG_BOOKING_INVALID_PRODUCT_TYPE]: 'catalog booking invalid product type',
    [ERROR_CODES.CATALOG_BOOKING_MISSING_SERVICE_CONFIG]: 'catalog booking missing service config',
    [ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_ACTIVE]: 'catalog booking product not active',
    [ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE]: 'catalog booking invalid price',
    [ERROR_CODES.CATALOG_BOOKING_NOT_IMPLEMENTED]: 'catalog booking not implemented',
    [ERROR_CODES.CATALOG_BULK_EMPTY]: 'catalog bulk empty',
    [ERROR_CODES.CATALOG_BULK_TRANSACTION_LIMIT]: 'catalog bulk transaction limit',
    [ERROR_CODES.CATALOG_BULK_UPDATE_FAILED]: 'catalog bulk update failed',
    [ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND]: 'delivery agency not found',
    [ERROR_CODES.DELIVERY_AGENT_NOT_FOUND]: 'delivery agent not found',
    [ERROR_CODES.DELIVERY_AGENCY_ALREADY_EXISTS]: 'An agency profile already exists for this user',
    [ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID]: 'Invalid onboarding step',
    [ERROR_CODES.DELIVERY_ONBOARDING_STEP_INCOMPLETE]: 'Previous onboarding step has not been completed',
    [ERROR_CODES.DELIVERY_ONBOARDING_ALREADY_COMPLETED]: 'Agency onboarding is already completed',
    [ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION]: 'Agency profile was modified by another request. Please refresh and try again.',
    [ERROR_CODES.CUSTOMER_NOT_FOUND]: 'customer not found',
    [ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND]: 'customer address not found',
    [ERROR_CODES.CUSTOMER_PAYMENT_METHOD_NOT_FOUND]: 'customer payment method not found',
    [ERROR_CODES.USER_NOT_FOUND]: 'user not found',
    [ERROR_CODES.USER_INVALID_PASSWORD]: 'user invalid password',
    [ERROR_CODES.STORE_NOT_FOUND]: 'store not found',
    [ERROR_CODES.STORE_SLUG_TAKEN]: 'store slug taken',
    [ERROR_CODES.VENDOR_NOTIFICATION_NOT_FOUND]: 'vendor notification not found',
    [ERROR_CODES.ORDER_CART_EMPTY]: 'order cart empty',
    [ERROR_CODES.ORDER_CART_INVALID]: 'order cart invalid',
    [ERROR_CODES.ORDER_PRODUCT_NOT_FOUND]: 'order product not found',
    [ERROR_CODES.ORDER_VENDOR_NOT_FOUND]: 'order vendor not found',
    [ERROR_CODES.ORDER_NO_DELIVERY_AGENCY]: 'order no delivery agency',
    [ERROR_CODES.CART_VARIANT_REQUIRED]: 'cart variant required',
    [ERROR_CODES.CART_PRODUCT_NOT_FOUND]: 'cart product not found',
    [ERROR_CODES.CART_SERVICE_PRODUCT_NOT_ALLOWED]: 'cart service product not allowed',
    [ERROR_CODES.CART_VARIANT_NOT_FOUND]: 'cart variant not found',
    [ERROR_CODES.CART_VARIANT_PRODUCT_MISMATCH]: 'cart variant product mismatch',
    [ERROR_CODES.CART_DIGITAL_QUANTITY_MUST_BE_ONE]: 'cart digital quantity must be one',
    [ERROR_CODES.CART_MIXED_PRODUCT_TYPES]: 'cart mixed product types',
    [ERROR_CODES.CART_DIGITAL_LIMIT_REACHED]: 'cart digital limit reached',
    [ERROR_CODES.CART_NOT_FOUND]: 'cart not found',
    [ERROR_CODES.CART_EMPTY_CHECKOUT]: 'cart empty checkout',
    [ERROR_CODES.BOOKING_PRODUCT_NOT_FOUND]: 'booking product not found',
    [ERROR_CODES.BOOKING_USER_NOT_FOUND]: 'booking user not found',
    [ERROR_CODES.BOOKING_UNAUTHORIZED]: 'booking unauthorized',
    [ERROR_CODES.BOOKING_ALREADY_CANCELLED]: 'booking already cancelled',
    [ERROR_CODES.BOOKING_CALENDAR_SYNC_FAILED]: 'booking calendar sync failed',
    [ERROR_CODES.BOOKING_PAYMENT_NOT_REQUIRED]: 'booking payment not required',
    [ERROR_CODES.BOOKING_ALREADY_PAID]: 'booking already paid',
    [ERROR_CODES.BOOKING_INVALID_PAYMENT_METHOD]: 'booking invalid payment method',
    [ERROR_CODES.BOOKING_TERMINAL_STATE]: 'booking terminal state',
    [ERROR_CODES.BOOKING_SLOT_NOT_LOCKED]: 'booking slot not locked',
    [ERROR_CODES.BOOKING_FORBIDDEN]: 'booking forbidden',
    [ERROR_CODES.BOOKING_INVALID_SLOT_ID]: 'booking invalid slot id',
    [ERROR_CODES.ADMIN_NOT_FOUND]: 'admin not found',
    [ERROR_CODES.ADMIN_FORBIDDEN]: 'admin forbidden',
    [ERROR_CODES.AUTH_OAUTH_STATE_INVALID]: 'auth oauth state invalid',
    [ERROR_CODES.AUTH_OAUTH_STATE_EXPIRED]: 'auth oauth state expired',
    [ERROR_CODES.STORAGE_FILE_NOT_FOUND]: 'storage file not found',
    [ERROR_CODES.STORAGE_DELETE_FAILED]: 'storage delete failed',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_ACCESS_DENIED]: 'catalog digital asset access denied',
    [ERROR_CODES.CATALOG_SHIPPING_NOT_FOUND]: 'catalog shipping not found',
    [ERROR_CODES.CATALOG_SHIPPING_ACCESS_DENIED]: 'catalog shipping access denied',
    [ERROR_CODES.COMMAND_ALREADY_REGISTERED]: 'command already registered',
    [ERROR_CODES.COMMAND_NOT_FOUND]: 'command not found',
    [ERROR_CODES.WHATSAPP_LINK_FAILED]: 'whatsapp link failed',
    [ERROR_CODES.WHATSAPP_INVALID_PAYLOAD]: 'whatsapp invalid payload',
    [ERROR_CODES.WHATSAPP_POLICY_VIOLATION]: 'whatsapp policy violation',
    [ERROR_CODES.WHATSAPP_PROVIDER_REJECTED]: 'whatsapp provider rejected',
    [ERROR_CODES.WHATSAPP_VALIDATION_ERROR]: 'whatsapp validation error',
    [ERROR_CODES.WHATSAPP_IDEMPOTENCY_REQUIRED]: 'whatsapp idempotency required',
    [ERROR_CODES.WHATSAPP_DUPLICATE_MESSAGE]: 'whatsapp duplicate message',
    [ERROR_CODES.WHATSAPP_UNSUPPORTED_MESSAGE_TYPE]: 'whatsapp unsupported message type',
    [ERROR_CODES.DIGITAL_ASSET_NOT_FOUND]: 'digital asset not found',
    [ERROR_CODES.DIGITAL_ASSET_ACCESS_DENIED]: 'digital asset access denied',
    [ERROR_CODES.DIGITAL_ASSET_IN_USE]: 'digital asset in use',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_MISSING]: 'digital entitlement config missing',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_INACTIVE]: 'digital entitlement config inactive',
  };

  const resolvedMessage = message ?? defaultMessages[code] ?? 'An unexpected error occurred';
  return new AppError(resolvedMessage, statusCode, code, true, details);
}

// ─── Retained Subclasses (non-standard constructors) ──────────────────────────

/**
 * BulkValidationError: carries per-row error details.
 */
export class BulkValidationError extends AppError {
  constructor(
    message: string,
    public readonly rowErrors: Array<{ row: number; error: string }>
  ) {
    super(message, 400, ERROR_CODES.CATALOG_BULK_VALIDATION_FAILED, true, { rowErrors });
  }
}

/**
 * UnsupportedTimezoneError: embeds the invalid timezone in the message.
 */
export class UnsupportedTimezoneError extends AppError {
  constructor(timezone: string) {
    super(
      `Timezone '${timezone}' is not supported`,
      400,
      ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE,
      true,
      { timezone }
    );
  }
}

/**
 * BulkLimitExceededError: carries the limit value.
 */
export class BulkLimitExceededError extends AppError {
  constructor(limit: number = 1000) {
    super(
      `Bulk update limited to ${limit} rows`,
      400,
      ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED,
      true,
      { limit }
    );
  }
}

/**
 * DateRangeExceededError: carries the max allowed days.
 */
export class DateRangeExceededError extends AppError {
  constructor(maxDays: number = 365) {
    super(
      `Date range cannot exceed ${maxDays} days`,
      400,
      ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED,
      true,
      { maxDays }
    );
  }
}
