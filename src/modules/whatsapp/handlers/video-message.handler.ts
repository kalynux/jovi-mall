import { VideoMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Video Message Handler
 */
export class VideoMessageHandler implements WhatsAppMessageHandler<VideoMessage> {
    validate(message: VideoMessage, context: BuildContext): void {
        if (!message.link && !message.id) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: video',
                { messageType: 'video', validationErrors: [{ field: 'link/id', message: 'Either link or id must be provided' }] }
            );
        }

        if (message.link && message.id) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: video',
                { messageType: 'video', validationErrors: [{ field: 'link/id', message: 'Provide either link OR id, not both' }] }
            );
        }

        if (message.caption && message.caption.length > 1024) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: video',
                { messageType: 'video', validationErrors: [{ field: 'caption', message: `Caption exceeds maximum length of 1024 characters` }] }
            );
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[VideoMessageHandler] Attempting to send video outside 24-hour window');
        }
    }

    build(message: VideoMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'video',
            video: {},
        };

        if (message.link) {
            payload.video.link = message.link;
        } else {
            payload.video.id = message.id;
        }

        if (message.caption) {
            payload.video.caption = message.caption;
        }

        return payload;
    }
}
