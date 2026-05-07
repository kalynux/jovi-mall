import { AudioMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Audio Message Handler
 */
export class AudioMessageHandler implements WhatsAppMessageHandler<AudioMessage> {
    validate(message: AudioMessage, context: BuildContext): void {
        if (!message.link && !message.id) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: audio',
                { messageType: 'audio', validationErrors: [{ field: 'link/id', message: 'Either link or id must be provided' }] }
            );
        }

        if (message.link && message.id) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: audio',
                { messageType: 'audio', validationErrors: [{ field: 'link/id', message: 'Provide either link OR id, not both' }] }
            );
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[AudioMessageHandler] Attempting to send audio outside 24-hour window');
        }
    }

    build(message: AudioMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'audio',
            audio: {},
        };

        if (message.link) {
            payload.audio.link = message.link;
        } else {
            payload.audio.id = message.id;
        }

        return payload;
    }
}
