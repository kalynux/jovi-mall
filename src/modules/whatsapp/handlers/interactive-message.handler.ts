import { InteractiveMessage } from '../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from './handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Interactive Message Handler
 * 
 * Handles interactive messages: buttons, lists, CTA URLs
 */
export class InteractiveMessageHandler implements WhatsAppMessageHandler<InteractiveMessage> {
    validate(message: InteractiveMessage, context: BuildContext): void {
        // Policy check: Interactive messages require capability
        if (!context.sendContext.hasInteractiveCapability) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                'WhatsApp policy violation: Account does not have interactive message capability',
                { policyType: 'MISSING_CAPABILITY', reason: 'Account does not have interactive message capability', messageType: 'interactive' }
            );
        }

        // Policy check: Interactive messages require 24-hour window
        if (!context.sendContext.isWithin24hWindow) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                'WhatsApp policy violation: Interactive messages require 24-hour window',
                { policyType: '24H_WINDOW', reason: 'Interactive messages require 24-hour window', messageType: 'interactive' }
            );
        }

        // Validate body
        if (!message.body || !message.body.text) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'body.text', message: 'Body text is required' }] }
            );
        }

        if (message.body.text.length > 1024) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'body.text', message: 'Body text exceeds 1024 characters' }] }
            );
        }

        // Validate action based on subtype
        if (message.subtype === 'button') {
            this.validateButtonAction(message);
        } else if (message.subtype === 'list') {
            this.validateListAction(message);
        } else if (message.subtype === 'cta_url') {
            this.validateCTAUrlAction(message);
        }
    }

    build(message: InteractiveMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'interactive',
            interactive: {
                type: message.subtype,
                body: {
                    text: message.body.text,
                },
            },
        };

        // Add header if provided
        if (message.header) {
            payload.interactive.header = message.header;
        }

        // Add footer if provided
        if (message.footer) {
            payload.interactive.footer = {
                text: message.footer.text,
            };
        }

        // Add action
        if (message.subtype === 'button' && message.action.type === 'button') {
            payload.interactive.action = {
                buttons: message.action.buttons,
            };
        } else if (message.subtype === 'list' && message.action.type === 'list') {
            payload.interactive.action = {
                button: message.action.button,
                sections: message.action.sections,
            };
        } else if (message.subtype === 'cta_url' && message.action.type === 'cta_url') {
            payload.interactive.action = {
                name: message.action.name,
                parameters: message.action.parameters,
            };
        }

        return payload;
    }

    private validateButtonAction(message: InteractiveMessage): void {
        if (message.action.type !== 'button') {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action', message: 'Action type must be "button" for button subtype' }] }
            );
        }

        const action = message.action as any;
        if (!action.buttons || action.buttons.length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action.buttons', message: 'At least one button is required' }] }
            );
        }

        if (action.buttons.length > 3) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action.buttons', message: 'Maximum 3 buttons allowed' }] }
            );
        }

        // Validate each button
        for (const button of action.buttons) {
            if (!button.reply || !button.reply.id || !button.reply.title) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: interactive',
                    { messageType: 'interactive', validationErrors: [{ field: 'action.buttons', message: 'Each button must have id and title' }] }
                );
            }

            if (button.reply.title.length > 20) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: interactive',
                    { messageType: 'interactive', validationErrors: [{ field: 'action.buttons', message: 'Button title cannot exceed 20 characters' }] }
                );
            }
        }
    }

    private validateListAction(message: InteractiveMessage): void {
        if (message.action.type !== 'list') {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action', message: 'Action type must be "list" for list subtype' }] }
            );
        }

        const action = message.action as any;
        if (!action.button) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action.button', message: 'Button text is required for list' }] }
            );
        }

        if (!action.sections || action.sections.length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action.sections', message: 'At least one section is required' }] }
            );
        }

        // Validate sections
        for (const section of action.sections) {
            if (!section.rows || section.rows.length === 0) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                    400,
                    'Invalid payload for message type: interactive',
                    { messageType: 'interactive', validationErrors: [{ field: 'action.sections', message: 'Each section must have at least one row' }] }
                );
            }

            for (const row of section.rows) {
                if (!row.id || !row.title) {
                    throw createAppError(
                        ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                        400,
                        'Invalid payload for message type: interactive',
                        { messageType: 'interactive', validationErrors: [{ field: 'action.sections.rows', message: 'Each row must have id and title' }] }
                    );
                }
            }
        }
    }

    private validateCTAUrlAction(message: InteractiveMessage): void {
        if (message.action.type !== 'cta_url') {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action', message: 'Action type must be "cta_url" for cta_url subtype' }] }
            );
        }

        const action = message.action as any;
        if (!action.name || !action.parameters?.display_text || !action.parameters?.url) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: interactive',
                { messageType: 'interactive', validationErrors: [{ field: 'action', message: 'CTA URL requires name, display_text, and url' }] }
            );
        }
    }
}
