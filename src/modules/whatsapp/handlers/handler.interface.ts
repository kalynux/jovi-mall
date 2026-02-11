import { WhatsAppMessage, WhatsAppSendContext } from '../types/whatsapp-message.types';

/**
 * Provider Payload
 * 
 * WhatsApp-native payload format for Meta Cloud API
 */
export interface ProviderPayload {
    messaging_product: 'whatsapp';
    recipient_type: 'individual';
    to: string;
    type: string;
    [key: string]: any;
}

/**
 * Build Context
 * 
 * Additional context passed to handlers during payload building
 */
export interface BuildContext {
    /** Authoritative policy context */
    sendContext: WhatsAppSendContext;

    /** Trace ID for logging */
    traceId?: string;

    /** Phone number ID (from env) */
    phoneNumberId?: string;
}

/**
 * WhatsApp Message Handler Interface
 * 
 * All message type handlers MUST implement this interface.
 * 
 * Handlers are responsible for:
 * 1. Validating message-specific payload
 * 2. Checking WhatsApp policy constraints (via authoritative sendContext)
 * 3. Building WhatsApp-native API payload
 */
export interface WhatsAppMessageHandler<T extends WhatsAppMessage> {
    /**
     * Validate message payload
     * 
     * Should throw InvalidMessagePayloadError if validation fails
     * Should throw PolicyViolationError if message violates WhatsApp policy
     * 
     * @param message - Message payload to validate
     * @param context - Build context with authoritative sendContext
     */
    validate(message: T, context: BuildContext): void;

    /**
     * Build WhatsApp-native provider payload
     * 
     * @param message - Validated message payload
     * @param context - Build context with authoritative sendContext
     * @returns WhatsApp Cloud API payload
     */
    build(message: T, context: BuildContext): ProviderPayload;
}
