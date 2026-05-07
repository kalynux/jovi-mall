import { WhatsAppMessageType, WhatsAppSendContext } from '../types/whatsapp-message.types';
import {
    PolicyContext,
    PolicyViolationReason,
    WindowPolicy,
    CapabilityPolicy,
} from '../types/whatsapp-policy.types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { WhatsappService } from '../whatsapp.service';

/**
 * WhatsApp Policy Validator
 * 
 * CRITICAL: Capability Guard Layer
 * 
 * This service computes AUTHORITATIVE policy context and validates
 * whether a message can be sent based on WhatsApp's constraints:
 * 
 * 1. 24-hour window enforcement
 * 2. Template-only rules outside window
 * 3. Interactive message eligibility
 * 4. Flow availability by region/account
 * 
 * The sendContext computed here MUST be trusted by handlers.
 * Callers MAY NOT override policy flags.
 */
export class WhatsAppPolicyValidator {
    private whatsappService: WhatsappService;

    constructor() {
        this.whatsappService = new WhatsappService();
    }

    /**
     * Compute authoritative sendContext for a recipient
     * 
     * @param to - Recipient phone number (WhatsApp phone ID)
     * @param messageType - Type of message being sent
     * @returns Authoritative sendContext
     */
    async computeSendContext(
        to: string,
        messageType: WhatsAppMessageType
    ): Promise<WhatsAppSendContext> {
        // Check 24-hour window
        const isWithin24hWindow = await this.whatsappService.canSendFreeMessage(to);

        // Determine allowed message types based on window
        const allowedMessageTypes = this.getAllowedMessageTypes(isWithin24hWindow);

        // Get capabilities (in real implementation, this would check account/region)
        const capabilities = this.getAccountCapabilities();

        return {
            isWithin24hWindow,
            allowedMessageTypes,
            hasFlowCapability: capabilities.hasFlows,
            hasInteractiveCapability: capabilities.hasInteractive,
        };
    }

    /**
     * Validate whether a message can be sent
     * 
     * Throws PolicyViolationError if message violates WhatsApp policy
     * 
     * @param messageType - Type of message
     * @param sendContext - Computed sendContext
     */
    validatePolicy(
        messageType: WhatsAppMessageType,
        sendContext: WhatsAppSendContext
    ): void {
        // Check 1: 24-hour window constraint
        if (!sendContext.isWithin24hWindow && messageType !== 'template') {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                `WhatsApp policy violation: Message type '${messageType}' requires 24-hour window. Use 'template' message instead.`,
                {
                    policyType: '24H_WINDOW',
                    reason: `Message type '${messageType}' requires 24-hour window. Use 'template' message instead.`,
                    messageType,
                    isWithin24hWindow: sendContext.isWithin24hWindow,
                    allowedTypes: ['template'],
                }
            );
        }

        // Check 2: Interactive capability
        if (messageType === 'interactive' && !sendContext.hasInteractiveCapability) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                'WhatsApp policy violation: Account does not have interactive message capability',
                {
                    policyType: 'MISSING_CAPABILITY',
                    reason: 'Account does not have interactive message capability',
                    messageType,
                    requiredCapability: 'interactive',
                }
            );
        }

        // Check 3: Flow capability
        if (messageType === 'flow' && !sendContext.hasFlowCapability) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                'WhatsApp policy violation: Account does not have WhatsApp Flows capability',
                {
                    policyType: 'MISSING_CAPABILITY',
                    reason: 'Account does not have WhatsApp Flows capability',
                    messageType,
                    requiredCapability: 'flows',
                }
            );
        }

        // Check 4: Message type allowed in current context
        if (!sendContext.allowedMessageTypes.includes(messageType)) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_POLICY_VIOLATION,
                403,
                `WhatsApp policy violation: Message type '${messageType}' is not allowed in current context`,
                {
                    policyType: 'MESSAGE_TYPE_NOT_ALLOWED',
                    reason: `Message type '${messageType}' is not allowed in current context`,
                    messageType,
                    allowedTypes: sendContext.allowedMessageTypes,
                }
            );
        }
    }

    /**
     * Get allowed message types based on 24-hour window
     */
    private getAllowedMessageTypes(isWithinWindow: boolean): WhatsAppMessageType[] {
        if (isWithinWindow) {
            // All message types allowed within window
            return [
                'text',
                'template',
                'image',
                'video',
                'audio',
                'document',
                'interactive',
                'product',
                'product_list',
                'media_carousel',
                'reaction',
                'location',
                'contacts',
                'flow',
            ];
        } else {
            // Only templates allowed outside window
            return ['template'];
        }
    }

    /**
     * Get account capabilities
     * 
     * In real implementation, this would:
     * - Check WhatsApp Business Manager settings
     * - Query account tier/verification status
     * - Check region-specific features
     * 
     * For now, returns default capabilities
     */
    private getAccountCapabilities(): CapabilityPolicy {
        // TODO: Implement real capability checking
        // This could be cached or fetched from WhatsApp API
        return {
            hasInteractive: true,
            hasFlows: true, // Check if account has flows enabled
            hasCatalog: true,
            hasMediaCarousel: true,
            maxButtons: 3,
            maxProductsPerList: 30,
        };
    }

    /**
     * Check if idempotency is required for message type
     */
    isIdempotencyRequired(messageType: WhatsAppMessageType): boolean {
        // Idempotency REQUIRED for:
        // - Templates (booking confirmations, order updates)
        // - Payments
        // - Orders
        const criticalTypes: WhatsAppMessageType[] = ['template'];

        return criticalTypes.includes(messageType);
    }
}
