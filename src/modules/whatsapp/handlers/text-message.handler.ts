import { TextMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { InvalidMessagePayloadError } from '../types/whatsapp-error.types';

/**
 * Text Message Handler
 * 
 * Handles simple text messages with optional URL preview
 */
export class TextMessageHandler implements WhatsAppMessageHandler<TextMessage> {
    validate(message: TextMessage, context: BuildContext): void {
        // Validate body is present and non-empty
        if (!message.body || message.body.trim().length === 0) {
            throw new InvalidMessagePayloadError('text', [
                { field: 'body', message: 'Message body is required and cannot be empty' },
            ]);
        }

        // Validate body length (WhatsApp limit is 4096 characters)
        if (message.body.length > 4096) {
            throw new InvalidMessagePayloadError('text', [
                { field: 'body', message: `Message body exceeds maximum length of 4096 characters (got ${message.body.length})` },
            ]);
        }

        // Policy check: Text messages require 24-hour window
        // This is enforced by policy validator, but we double-check here
        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[TextMessageHandler] Attempting to send text message outside 24-hour window');
        }
    }

    build(message: TextMessage, context: BuildContext): ProviderPayload {
        return {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '', // Will be filled by service
            type: 'text',
            text: {
                body: message.body,
                preview_url: message.previewUrl ?? false,
            },
        };
    }
}
