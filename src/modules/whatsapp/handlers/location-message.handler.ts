import { LocationMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Location Message Handler
 */
export class LocationMessageHandler implements WhatsAppMessageHandler<LocationMessage> {
    validate(message: LocationMessage, context: BuildContext): void {
        if (message.latitude === undefined || message.latitude === null) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: location',
                { messageType: 'location', validationErrors: [{ field: 'latitude', message: 'Latitude is required' }] }
            );
        }

        if (message.longitude === undefined || message.longitude === null) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: location',
                { messageType: 'location', validationErrors: [{ field: 'longitude', message: 'Longitude is required' }] }
            );
        }

        // Validate latitude range (-90 to 90)
        if (message.latitude < -90 || message.latitude > 90) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: location',
                { messageType: 'location', validationErrors: [{ field: 'latitude', message: 'Latitude must be between -90 and 90' }] }
            );
        }

        // Validate longitude range (-180 to 180)
        if (message.longitude < -180 || message.longitude > 180) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: location',
                { messageType: 'location', validationErrors: [{ field: 'longitude', message: 'Longitude must be between -180 and 180' }] }
            );
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[LocationMessageHandler] Attempting to send location outside 24-hour window');
        }
    }

    build(message: LocationMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'location',
            location: {
                latitude: message.latitude,
                longitude: message.longitude,
            },
        };

        if (message.name) {
            payload.location.name = message.name;
        }

        if (message.address) {
            payload.location.address = message.address;
        }

        return payload;
    }
}
