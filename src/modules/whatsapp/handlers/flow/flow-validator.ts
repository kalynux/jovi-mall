import { FlowMessage } from '../../types/whatsapp-message.types';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { FlowRegistry } from './flow-registry';

/**
 * Flow Validator
 * 
 * WhatsApp Flows have strict requirements:
 * - Must be published
 * - Must have valid screens
 * - Region/account specific
 */
export class FlowValidator {
    private registry: FlowRegistry;

    constructor() {
        this.registry = new FlowRegistry();
    }

    /**
     * Validate flow message
     */
    validate(message: FlowMessage, hasFlowCapability: boolean): void {
        // Check flow capability
        if (!hasFlowCapability) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                'WhatsApp policy violation: Account does not have WhatsApp Flows capability',
                { policyType: 'MISSING_CAPABILITY', reason: 'Account does not have WhatsApp Flows capability', messageType: 'flow' }
            );
        }

        // Validate flow ID
        if (!message.flowId || message.flowId.trim().length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: flow',
                { messageType: 'flow', validationErrors: [{ field: 'flowId', message: 'Flow ID is required' }] }
            );
        }

        // Validate flow action
        const validActions = ['navigate', 'data_exchange'];
        if (!message.flowAction || !validActions.includes(message.flowAction)) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: flow',
                { messageType: 'flow', validationErrors: [{ field: 'flowAction', message: `Invalid flow action. Must be one of: ${validActions.join(', ')}` }] }
            );
        }

        // Validate header
        if (!message.header || message.header.trim().length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: flow',
                { messageType: 'flow', validationErrors: [{ field: 'header', message: 'Header is required' }] }
            );
        }

        // Validate body
        if (!message.body || message.body.trim().length === 0) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_INVALID_PAYLOAD,
                400,
                'Invalid payload for message type: flow',
                { messageType: 'flow', validationErrors: [{ field: 'body', message: 'Body is required' }] }
            );
        }

        // Check if flow is registered and published
        const flow = this.registry.get(message.flowId);
        if (!flow) {
            console.warn(
                `[FlowValidator] Flow not in registry: ${message.flowId}. ` +
                `This may fail if flow is not published.`
            );
        } else {
            // Check if flow is published
            if (flow.status !== 'PUBLISHED') {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                    403,
                    `WhatsApp policy violation: Flow ${message.flowId} is not published`,
                    { policyType: 'FLOW_NOT_PUBLISHED', reason: `Flow ${message.flowId} is not published`, flowId: message.flowId, status: flow.status }
                );
            }

            // Validate screen if specified
            if (message.flowScreen && !flow.screens.includes(message.flowScreen)) {
                console.warn(
                    `[FlowValidator] Screen '${message.flowScreen}' not found in flow ${message.flowId}. ` +
                    `Available screens: ${flow.screens.join(', ')}`
                );
            }
        }
    }

    /**
     * Get flow registry (for registration)
     */
    getRegistry(): FlowRegistry {
        return this.registry;
    }
}
