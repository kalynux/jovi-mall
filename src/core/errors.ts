export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

export class ValidationError extends AppError {
  constructor(message: string = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class InternalError extends AppError {
  constructor(message: string = 'Internal server error') {
    super(message, 500, 'INTERNAL_ERROR', false);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message: string = 'Unprocessable entity') {
    super(message, 422, 'UNPROCESSABLE_ENTITY');
  }
}

// Inventory Management Errors
export class InsufficientStockError extends AppError {
  constructor(message: string = 'Insufficient stock available') {
    super(message, 400, 'INSUFFICIENT_STOCK');
  }
}

export class OversaleNotAllowedError extends AppError {
  constructor(message: string = 'Operation would result in negative stock. Overselling not allowed for this variant.') {
    super(message, 400, 'OVERSALE_NOT_ALLOWED');
  }
}

export class BulkValidationError extends AppError {
  constructor(
    message: string,
    public readonly rowErrors: Array<{ row: number; error: string }>
  ) {
    super(message, 400, 'BULK_VALIDATION_FAILED');
  }
}

export class ReservationExpiredError extends AppError {
  constructor(message: string = 'Reservation has expired') {
    super(message, 400, 'RESERVATION_EXPIRED');
  }
}

export class BulkLimitExceededError extends AppError {
  constructor(limit: number = 1000) {
    super(`Bulk update limited to ${limit} rows`, 400, 'BULK_LIMIT_EXCEEDED');
  }
}

export class TransactionLimitExceededError extends AppError {
  constructor(message: string = 'Batch size too large. Please reduce to fewer rows.') {
    super(message, 413, 'TRANSACTION_LIMIT_EXCEEDED');
  }
}

export class InvalidCSVFormatError extends AppError {
  constructor(message: string = 'Invalid CSV format. Required headers: variantId, quantity') {
    super(message, 400, 'INVALID_CSV_FORMAT');
  }
}

// Analytics Errors
export class InvalidDateRangeError extends AppError {
  constructor(message: string = 'Invalid date range provided') {
    super(message, 400, 'INVALID_DATE_RANGE');
  }
}

export class UnsupportedTimezoneError extends AppError {
  constructor(timezone: string) {
    super(`Timezone '${timezone}' is not supported`, 400, 'UNSUPPORTED_TIMEZONE');
  }
}

export class AggregationNotReadyError extends AppError {
  constructor(message: string = 'Analytics data not yet available for requested period') {
    super(message, 503, 'AGGREGATION_NOT_READY');
  }
}

export class DateRangeExceededError extends AppError {
  constructor(maxDays: number = 365) {
    super(`Date range cannot exceed ${maxDays} days`, 400, 'DATE_RANGE_EXCEEDED');
  }
}

// Ticketing Errors
export class FollowerLimitExceededError extends AppError {
  constructor(message: string = 'Maximum of 5 non-admin followers per ticket exceeded') {
    super(message, 400, 'FOLLOWER_LIMIT_EXCEEDED');
  }
}

export class AttachmentLimitExceededError extends AppError {
  constructor(message: string = 'Maximum of 5 attachments per ticket exceeded') {
    super(message, 400, 'ATTACHMENT_LIMIT_EXCEEDED');
  }
}

export class PriorityLockedError extends AppError {
  constructor(message: string = 'Priority is locked and cannot be modified') {
    super(message, 400, 'PRIORITY_LOCKED');
  }
}

export class InvalidStatusTransitionError extends AppError {
  constructor(message: string = 'Invalid status transition') {
    super(message, 400, 'INVALID_STATUS_TRANSITION');
  }
}

export class CustomerPrivateNoteError extends AppError {
  constructor(message: string = 'Customers can only create public notes') {
    super(message, 403, 'CUSTOMER_PRIVATE_NOTE_FORBIDDEN');
  }
}

export class TicketAccessDeniedError extends AppError {
  constructor(message: string = 'Access to this ticket is denied') {
    super(message, 403, 'TICKET_ACCESS_DENIED');
  }
}

