import { DocumentMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { InvalidMessagePayloadError } from '../types/whatsapp-error.types';

/**
 * Document Message Handler
 */
export class DocumentMessageHandler implements WhatsAppMessageHandler<DocumentMessage> {
    validate(message: DocumentMessage, context: BuildContext): void {
        if (!message.link && !message.id) {
            throw new InvalidMessagePayloadError('document', [
                { field: 'link/id', message: 'Either link or id must be provided' },
            ]);
        }

        if (message.link && message.id) {
            throw new InvalidMessagePayloadError('document', [
                { field: 'link/id', message: 'Provide either link OR id, not both' },
            ]);
        }

        if (message.caption && message.caption.length > 1024) {
            throw new InvalidMessagePayloadError('document', [
                { field: 'caption', message: `Caption exceeds maximum length of 1024 characters` },
            ]);
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[DocumentMessageHandler] Attempting to send document outside 24-hour window');
        }
    }

    build(message: DocumentMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'document',
            document: {},
        };

        if (message.link) {
            payload.document.link = message.link;
        } else {
            payload.document.id = message.id;
        }

        if (message.filename) {
            payload.document.filename = message.filename;
        }

        if (message.caption) {
            payload.document.caption = message.caption;
        }

        return payload;
    }
}
