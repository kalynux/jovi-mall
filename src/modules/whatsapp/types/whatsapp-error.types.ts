/**
 * WhatsApp Error Hierarchy
 * 
 * Provides distinct error types for different failure scenarios.
 */

/**
 * Base WhatsApp Send Error
 */
export class WhatsAppSendError extends Error {
    constructor(
        message: string,
        public code: string,
        public details?: any
    ) {
        super(message);
        this.name = 'WhatsAppSendError';
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Unsupported Message Type Error
 * Thrown when a message type is not registered in the handler registry
 */
export class UnsupportedMessageTypeError extends WhatsAppSendError {
    constructor(messageType: string) {
        super(
            `Unsupported message type: ${messageType}. No handler registered.`,
            'UNSUPPORTED_MESSAGE_TYPE',
            { messageType }
        );
        this.name = 'UnsupportedMessageTypeError';
    }
}

/**
 * Invalid Message Payload Error
 * Thrown when message payload fails validation
 */
export class InvalidMessagePayloadError extends WhatsAppSendError {
    constructor(
        messageType: string,
        validationErrors: any[]
    ) {
        super(
            `Invalid payload for message type: ${messageType}`,
            'INVALID_MESSAGE_PAYLOAD',
            { messageType, validationErrors }
        );
        this.name = 'InvalidMessagePayloadError';
    }
}

/**
 * Policy Violation Error
 * 
 * Thrown when a message violates WhatsApp policies (24h window, capabilities, etc.)
 * 
 * CRITICAL: This is distinct from validation errors and provider rejections.
 * Policy violations are deterministic and preventable.
 */
export class PolicyViolationError extends WhatsAppSendError {
    constructor(
        policyType: string,
        reason: string,
        details?: any
    ) {
        super(
            `WhatsApp policy violation: ${reason}`,
            'POLICY_VIOLATION',
            { policyType, reason, ...details }
        );
        this.name = 'PolicyViolationError';
    }
}

/**
 * Provider Rejected Message Error
 * Thrown when WhatsApp API rejects the message
 */
export class ProviderRejectedMessageError extends WhatsAppSendError {
    constructor(
        whatsappErrorCode: number,
        whatsappErrorMessage: string,
        details?: any
    ) {
        super(
            `WhatsApp API rejected message: ${whatsappErrorMessage}`,
            'PROVIDER_REJECTED',
            { whatsappErrorCode, whatsappErrorMessage, ...details }
        );
        this.name = 'ProviderRejectedMessageError';
    }
}

/**
 * Validation Error
 * Thrown when schema validation fails
 */
export class ValidationError extends WhatsAppSendError {
    constructor(
        field: string,
        reason: string,
        details?: any
    ) {
        super(
            `Validation failed for field '${field}': ${reason}`,
            'VALIDATION_ERROR',
            { field, reason, ...details }
        );
        this.name = 'ValidationError';
    }
}

/**
 * Idempotency Required Error
 * Thrown when idempotency key is missing for critical message types
 */
export class IdempotencyRequiredError extends WhatsAppSendError {
    constructor(messageType: string) {
        super(
            `Idempotency key is required for message type: ${messageType}`,
            'IDEMPOTENCY_REQUIRED',
            { messageType }
        );
        this.name = 'IdempotencyRequiredError';
    }
}

/**
 * Duplicate Message Error
 * Thrown when idempotency key indicates duplicate send attempt
 */
export class DuplicateMessageError extends WhatsAppSendError {
    constructor(idempotencyKey: string, originalMessageId?: string) {
        super(
            `Duplicate message detected with idempotency key: ${idempotencyKey}`,
            'DUPLICATE_MESSAGE',
            { idempotencyKey, originalMessageId }
        );
        this.name = 'DuplicateMessageError';
    }
}
