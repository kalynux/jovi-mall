import { MediaCarouselMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Media Carousel Message Handler
 */
export class MediaCarouselMessageHandler implements WhatsAppMessageHandler<MediaCarouselMessage> {
    validate(message: MediaCarouselMessage, context: BuildContext): void {
        if (!message.cards || message.cards.length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: media_carousel',
                { messageType: 'media_carousel', validationErrors: [{ field: 'cards', message: 'At least one card is required' }] }
            );
        }

        // Validate WhatsApp's carousel limits (typically 10 cards max)
        if (message.cards.length > 10) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: media_carousel',
                { messageType: 'media_carousel', validationErrors: [{ field: 'cards', message: 'Maximum 10 cards allowed in carousel' }] }
            );
        }

        // Validate each card
        for (const card of message.cards) {
            if (!card.header || !card.body) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: media_carousel',
                    { messageType: 'media_carousel', validationErrors: [{ field: 'cards', message: 'Each card must have header and body' }] }
                );
            }

            if (!card.body.text) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: media_carousel',
                    { messageType: 'media_carousel', validationErrors: [{ field: 'cards.body.text', message: 'Card body text is required' }] }
                );
            }
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[MediaCarouselMessageHandler] Attempting to send carousel outside 24-hour window');
        }
    }

    build(message: MediaCarouselMessage, context: BuildContext): ProviderPayload {
        return {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'interactive',
            interactive: {
                type: 'carousel',
                body: {
                    text: 'Media Carousel', // Required by WhatsApp
                },
                action: {
                    name: 'carousel',
                    parameters: {
                        cards: message.cards,
                    },
                },
            },
        };
    }
}
