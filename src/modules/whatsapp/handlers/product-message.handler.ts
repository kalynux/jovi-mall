import { ProductMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { InvalidMessagePayloadError } from '../types/whatsapp-error.types';

/**
 * Product Message Handler
 */
export class ProductMessageHandler implements WhatsAppMessageHandler<ProductMessage> {
    validate(message: ProductMessage, context: BuildContext): void {
        if (!message.catalogId) {
            throw new InvalidMessagePayloadError('product', [
                { field: 'catalogId', message: 'Catalog ID is required' },
            ]);
        }

        if (!message.productRetailerId) {
            throw new InvalidMessagePayloadError('product', [
                { field: 'productRetailerId', message: 'Product retailer ID is required' },
            ]);
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
