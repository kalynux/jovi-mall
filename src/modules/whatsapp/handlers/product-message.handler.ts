import { ProductMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Product Message Handler
 */
export class ProductMessageHandler implements WhatsAppMessageHandler<ProductMessage> {
    validate(message: ProductMessage, context: BuildContext): void {
        if (!message.catalogId) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: product',
                { messageType: 'product', validationErrors: [{ field: 'catalogId', message: 'Catalog ID is required' }] }
            );
        }

        if (!message.productRetailerId) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: product',
                { messageType: 'product', validationErrors: [{ field: 'productRetailerId', message: 'Product retailer ID is required' }] }
            );
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[ProductMessageHandler] Attempting to send product outside 24-hour window');
        }
    }

    build(message: ProductMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'interactive',
            interactive: {
                type: 'product',
                action: {
                    catalog_id: message.catalogId,
                    product_retailer_id: message.productRetailerId,
                },
            },
        };

        if (message.body) {
            payload.interactive.body = { text: message.body };
        }

        if (message.footer) {
            payload.interactive.footer = { text: message.footer };
        }

        return payload;
    }
}
