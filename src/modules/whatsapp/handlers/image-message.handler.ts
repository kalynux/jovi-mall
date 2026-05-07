import { ImageMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Image Message Handler
 * 
 * Handles image messages with optional caption
 */
export class ImageMessageHandler implements WhatsAppMessageHandler<ImageMessage> {
    validate(message: ImageMessage, context: BuildContext): void {
        // Either link or id must be provided
        if (!message.link && !message.id) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: image',
                { messageType: 'image', validationErrors: [{ field: 'link/id', message: 'Either link or id must be provided' }] }
            );
        }

        // Cannot provide both
        if (message.link && message.id) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: image',
                { messageType: 'image', validationErrors: [{ field: 'link/id', message: 'Provide either link OR id, not both' }] }
            );
        }

        // Validate caption length if provided (WhatsApp limit is 1024 characters)
        if (message.caption && message.caption.length > 1024) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: image',
                { messageType: 'image', validationErrors: [{ field: 'caption', message: `Caption exceeds maximum length of 1024 characters (got ${message.caption.length})` }] }
            );
        }

        // Validate URL format if link provided
        if (message.link && !this.isValidUrl(message.link)) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: image',
                { messageType: 'image', validationErrors: [{ field: 'link', message: 'Invalid URL format' }] }
            );
        }

        // Policy check: Image messages require 24-hour window
        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[ImageMessageHandler] Attempting to send image message outside 24-hour window');
        }
    }

    build(message: ImageMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'image',
            image: {},
        };

        if (message.link) {
            payload.image.link = message.link;
        } else {
            payload.image.id = message.id;
        }

        if (message.caption) {
            payload.image.caption = message.caption;
        }

        return payload;
    }

    private isValidUrl(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }
}
