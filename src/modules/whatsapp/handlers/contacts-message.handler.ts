import { ContactsMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Contacts Message Handler
 */
export class ContactsMessageHandler implements WhatsAppMessageHandler<ContactsMessage> {
    validate(message: ContactsMessage, context: BuildContext): void {
        if (!message.contacts || message.contacts.length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: contacts',
                { messageType: 'contacts', validationErrors: [{ field: 'contacts', message: 'At least one contact is required' }] }
            );
        }

        // Validate each contact
        for (const contact of message.contacts) {
            if (!contact.name || !contact.name.formatted_name) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: contacts',
                    { messageType: 'contacts', validationErrors: [{ field: 'contacts.name.formatted_name', message: 'Contact formatted name is required' }] }
                );
            }

            // At least phones or emails must be provided
            const hasPhones = contact.phones && contact.phones.length > 0;
            const hasEmails = contact.emails && contact.emails.length > 0;

            if (!hasPhones && !hasEmails) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: contacts',
                    { messageType: 'contacts', validationErrors: [{ field: 'contacts', message: 'Each contact must have at least one phone or email' }] }
                );
            }
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[ContactsMessageHandler] Attempting to send contacts outside 24-hour window');
        }
    }

    build(message: ContactsMessage, context: BuildContext): ProviderPayload {
        return {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'contacts',
            contacts: message.contacts,
        };
    }
}
