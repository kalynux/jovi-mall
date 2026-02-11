import { ReactionMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { InvalidMessagePayloadError } from '../types/whatsapp-error.types';

/**
 * Reaction Message Handler
 */
export class ReactionMessageHandler implements WhatsAppMessageHandler<ReactionMessage> {
    validate(message: ReactionMessage, context: BuildContext): void {
        if (!message.messageId) {
            throw new InvalidMessagePayloadError('reaction', [
                { field: 'messageId', message: 'Message ID to react to is required' },
            ]);
        }

        // Emoji is required (empty string to remove reaction)
        if (message.emoji === undefined || message.emoji === null) {
            throw new InvalidMessagePayloadError('reaction', [
                { field: 'emoji', message: 'Emoji is required (use empty string to remove reaction)' },
            ]);
        }

        // Validate emoji length (single emoji)
        if (message.emoji.length > 10) {
            throw new InvalidMessagePayloadError('reaction', [
                { field: 'emoji', message: 'Emoji must be a single emoji character' },
            ]);
        }

        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[ReactionMessageHandler] Attempting to send reaction outside 24-hour window');
        }
    }

    build(message: ReactionMessage, context: BuildContext): ProviderPayload {
        return {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'reaction',
            reaction: {
                message_id: message.messageId,
                emoji: message.emoji,
            },
        };
    }
}
