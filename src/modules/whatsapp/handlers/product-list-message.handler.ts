import { ProductListMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Product List Message Handler
 */
export class ProductListMessageHandler implements WhatsAppMessageHandler<ProductListMessage> {
    validate(message: ProductListMessage, context: BuildContext): void {
        if (!message.header) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: product_list',
                { messageType: 'product_list', validationErrors: [{ field: 'header', message: 'Header is required' }] }
            );
        }

        if (!message.body) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: product_list',
                { messageType: 'product_list', validationErrors: [{ field: 'body', message: 'Body is required' }] }
            );
        }

        if (!message.catalogId) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: product_list',
                { messageType: 'product_list', validationErrors: [{ field: 'catalogId', message: 'Catalog ID is required' }] }
            );
        }

        if (!message.sections || message.sections.length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: product_list',
                { messageType: 'product_list', validationErrors: [{ field: 'sections', message: 'At least one section is required' }] }
            );
        }

        // Validate sections
        for (const section of message.sections) {
            if (!section.title) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: product_list',
                    { messageType: 'product_list', validationErrors: [{ field: 'sections.title', message: 'Section title is required' }] }
                );
            }

            if (!section.product_items || section.product_items.length === 0) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: product_list',
                    { messageType: 'product_list', validationErrors: [{ field: 'sections.product_items', message: 'Each section must have at least one product' }] }
                );
            }
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[ProductListMessageHandler] Attempting to send product list outside 24-hour window');
        }
    }

    build(message: ProductListMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'interactive',
            interactive: {
                type: 'product_list',
                header: {
                    type: 'text',
                    text: message.header,
                },
                body: {
                    text: message.body,
                },
                action: {
                    catalog_id: message.catalogId,
                    sections: message.sections,
                },
            },
        };

        if (message.footer) {
            payload.interactive.footer = { text: message.footer };
        }

        return payload;
    }
}
