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

        /**
         * Check that the flow is registered and published.
         *
         * ⚠ **AN UNKNOWN FLOW ID IS REFUSED, AND THIS GUARD USED TO DO THE OPPOSITE.**
         *
         * It logged a warning and then **proceeded with the send**, throwing only for an id
         * that *was* registered with status `DRAFT`. So the guard whose own header says its
         * job is to "prevent sending unpublished flows" passed the dangerous state and
         * refused the safe one: an id nobody had ever registered — which, with the registry
         * empty, was every id — sailed through as a log line, while the only thing it ever
         * caught was an id somebody had already taken the trouble to declare.
         *
         * Inverted deliberately on 2026-09-16, while the blast radius was still zero: nothing
         * in this service sends a `flow` message today, so making this strict costs nothing
         * now and can never be this cheap again. Left as it was, the first real Flow send
         * would have inherited a guard that does not guard.
         *
         * The refusal is `FLOW_NOT_REGISTERED` rather than the published one because the two
         * have different remedies — an unregistered id means the `WHATSAPP_FLOW_ID_*`
         * variable for that screen is unset or wrong, not that somebody forgot to publish.
         */
        const flow = this.registry.get(message.flowId);
        if (!flow) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                `WhatsApp policy violation: Flow ${message.flowId} is not registered`,
                { policyType: 'FLOW_NOT_REGISTERED', reason: `Flow ${message.flowId} is not registered on this deployment`, flowId: message.flowId }
            );
        }

        // Check if flow is published
        if (flow.status !== 'PUBLISHED') {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                `WhatsApp policy violation: Flow ${message.flowId} is not published`,
                { policyType: 'FLOW_NOT_PUBLISHED', reason: `Flow ${message.flowId} is not published`, flowId: message.flowId, status: flow.status }
            );
        }

        /**
         * ⚠ **An EMPTY screen list means "not enumerated", never "no screens".** The screen
         * names live in the Flow JSON published to Meta; the registry deliberately keeps no
         * second copy of them, because a copy drifts silently the first time one is renamed.
         * So a populated list is checked and an empty one is no opinion — without this
         * branch, every send would warn about a screen the registry was never told about.
         */
        if (message.flowScreen && flow.screens.length > 0
            && !flow.screens.includes(message.flowScreen)) {
            console.warn(
                `[FlowValidator] Screen '${message.flowScreen}' not found in flow ${message.flowId}. ` +
                `Available screens: ${flow.screens.join(', ')}`
            );
        }
    }

    /**
     * Get flow registry (for registration)
     */
    getRegistry(): FlowRegistry {
        return this.registry;
    }
}
