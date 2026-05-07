import { WhatsAppMessageType, WhatsAppMessageTypes } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Handler Registry
 * 
 * Central registry for message type → handler mapping.
 * 
 * CRITICAL: Includes startup validation to ensure all message types
 * have registered handlers. This prevents production incidents where
 * a message type exists without a handler.
 */
export class HandlerRegistry {
    private handlers: Map<WhatsAppMessageType, WhatsAppMessageHandler<any>>;

    constructor() {
        this.handlers = new Map();
    }

    /**
     * Register a handler for a message type
     */
    register(type: WhatsAppMessageType, handler: WhatsAppMessageHandler<any>): void {
        if (this.handlers.has(type)) {
            console.warn(`[HandlerRegistry] Overwriting existing handler for type: ${type}`);
        }
        this.handlers.set(type, handler);
    }

    /**
     * Get handler for a message type
     * 
     * Throws UnsupportedMessageTypeError if no handler registered
     */
    get(type: WhatsAppMessageType): WhatsAppMessageHandler<any> {
        const handler = this.handlers.get(type);
        if (!handler) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_UNSUPPORTED_MESSAGE_TYPE,
                400,
                `Unsupported message type: ${type}`,
                { type }
            );
        }
        return handler;
    }

    /**
     * Check if handler exists for message type
     */
    has(type: WhatsAppMessageType): boolean {
        return this.handlers.has(type);
    }

    /**
     * Startup Validation: Ensure all message types have handlers
     * 
     * CRITICAL: This MUST be called during service initialization.
     * 
     * Throws Error if any message type is missing a handler.
     * This prevents production incidents where someone adds a type
     * but forgets to implement the handler.
     */
    assertAllMessageTypesRegistered(): void {
        const missingTypes: WhatsAppMessageType[] = [];

        for (const type of WhatsAppMessageTypes) {
            if (!this.has(type)) {
                missingTypes.push(type);
            }
        }

        if (missingTypes.length > 0) {
            throw createAppError(
                ERROR_CODES.INTERNAL_SERVER_ERROR,
                500,
                `FATAL: No handlers registered for message types: ${missingTypes.join(', ')}\n` +
                `All message types MUST have a registered handler.\n` +
                `Please implement handlers for these types or remove them from WhatsAppMessageTypes.`
            );
        }

        console.log(`[HandlerRegistry] ✓ All ${WhatsAppMessageTypes.length} message types have registered handlers`);
    }

    /**
     * Get all registered message types
     */
    getRegisteredTypes(): WhatsAppMessageType[] {
        return Array.from(this.handlers.keys());
    }

    /**
     * Get registration count
     */
    count(): number {
        return this.handlers.size;
    }
}
