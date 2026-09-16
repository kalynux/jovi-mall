import { FlowMessage } from '../../types/whatsapp-message.types';
import { WhatsAppMessageHandler, BuildContext, ProviderPayload } from '../handler.interface';
import { FlowValidator } from './flow-validator';

/**
 * Flow Message Handler
 * 
 * FIRST-CLASS TREATMENT:
 * Flows are complex and region/account specific.
 * This handler has:
 * - Dedicated validator
 * - Flow registry (track published flows)
 * - Region/capability checks
 */
export class FlowMessageHandler implements WhatsAppMessageHandler<FlowMessage> {
    private validator: FlowValidator;

    constructor() {
        this.validator = new FlowValidator();
    }

    validate(message: FlowMessage, context: BuildContext): void {
        // Delegate to dedicated validator
        this.validator.validate(message, context.sendContext.hasFlowCapability ?? false);

        // Flows require 24-hour window
        if (!context.sendContext.isWithin24hWindow) {
            console.warn('[FlowMessageHandler] Attempting to send flow outside 24-hour window');
        }
    }

    build(message: FlowMessage, context: BuildContext): ProviderPayload {
        const payload: ProviderPayload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: '',
            type: 'interactive',
            interactive: {
                type: 'flow',
                header: {
                    type: 'text',
                    text: message.header,
                },
                body: {
                    text: message.body,
                },
                action: {
                    name: 'flow',
                    parameters: {
                        /**
                         * ⚠ **Both of these were MISSING and Meta requires both**, so every
                         * payload this handler built was unsendable. It survived because
                         * nothing in this service has ever sent a `flow` message — the
                         * handler is registered, validated and unreachable, which is the
                         * shape of defect no test of the happy path can find.
                         *
                         * `flow_message_version` is a constant on Meta's side; `flow_token`
                         * is the session, echoed back on every encrypted request the data
                         * endpoint receives.
                         */
                        flow_message_version: '3',
                        flow_token: message.flowToken,
                        flow_id: message.flowId,
                        flow_action: message.flowAction,
                        flow_action_payload: message.flowParameters || {},
                    },
                },
            },
        };

        // Add footer if provided
        if (message.footer) {
            payload.interactive.footer = {
                text: message.footer,
            };
        }

        // Add screen if provided
        if (message.flowScreen) {
            payload.interactive.action.parameters.flow_cta = message.flowScreen;
        }

        return payload;
    }

    /**
     * Get flow validator (for external access to registry)
     */
    getValidator(): FlowValidator {
        return this.validator;
    }
}
