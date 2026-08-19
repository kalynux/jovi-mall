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
     * Get account capabilities.
     *
     * TODO(whatsapp, 2026-08-19): these are static optimistic defaults, not the account's
     * real capabilities. Deferred deliberately — no phase owns it, because nothing has yet
     * needed it to be true.
     *
     * ── What "real capability checking" would need, and why it is not free ───────
     * It is a call to Meta against the configured phone number id, plus a cache — this
     * function is on the send path of every message, so an unconditional network hop here
     * would put a third-party round trip in front of every notification the platform emits.
     * A cache then needs a TTL, an invalidation story for an account upgraded mid-window,
     * and a failure policy of its own. The `WhatsappService` this class already holds is
     * where such a call would live, so the seam exists; the cost is the caching, not the
     * request.
     *
     * ── Why the defaults are the RIGHT placeholder, and what they cost ──────────
     * They are optimistic (everything available, WhatsApp's own documented maxima), so the
     * failure mode is **Meta refuses a composed message** — a logged send failure naming the
     * capability, on one message. The pessimistic alternative fails the other way: this
     * class is authoritative and `sendContext` may not be overridden by callers, so a `false`
     * here silently downgrades or blocks every interactive send platform-wide, including for
     * accounts that do have the capability. When one is wrong, the visible refusal is the
     * cheaper wrong.
     *
     * Revisit when a real account is observed lacking one of these — that observation is the
     * requirement, and it does not exist yet.
     */
    private getAccountCapabilities(): CapabilityPolicy {
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
