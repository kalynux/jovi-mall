import {
    WhatsAppSendPayload,
    WhatsAppMessageType,
    WhatsAppMessage,
    SendResult,
} from '../types/whatsapp-message.types';
import { HandlerRegistry } from '../handlers/handler-registry';
import { WhatsAppMessageHandler, BuildContext } from '../handlers/handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { WhatsAppPolicyValidator } from '../validation/policy-validator';
import { WhatsAppProvider } from '../providers/provider.interface';
import { MetaWhatsAppCloudProvider } from '../providers/meta-cloud.provider';
import { getRedisClient, WA_IDEMPOTENCY_DB } from '../../../infra/redis/redis.factory';

// Import all handlers
import { TextMessageHandler } from '../handlers/text-message.handler';
import { ImageMessageHandler } from '../handlers/image-message.handler';
import { VideoMessageHandler } from '../handlers/video-message.handler';
import { AudioMessageHandler } from '../handlers/audio-message.handler';
import { DocumentMessageHandler } from '../handlers/document-message.handler';
import { InteractiveMessageHandler } from '../handlers/interactive-message.handler';
import { ProductMessageHandler } from '../handlers/product-message.handler';
import { ProductListMessageHandler } from '../handlers/product-list-message.handler';
import { MediaCarouselMessageHandler } from '../handlers/media-carousel-message.handler';
import { ReactionMessageHandler } from '../handlers/reaction-message.handler';
import { LocationMessageHandler } from '../handlers/location-message.handler';
import { ContactsMessageHandler } from '../handlers/contacts-message.handler';
import { TemplateMessageHandler } from '../handlers/template/template-message.handler';
import { FlowMessageHandler } from '../handlers/flow/flow-message.handler';

/**
 * WhatsApp Messaging Service
 * 
 * THE SINGLE ENTRY POINT for all WhatsApp message sending.
 * 
 * Features:
 * - Unified send() API for all message types
 * - Handler-based architecture (zero conditional explosion)
 * - WhatsApp policy awareness (24h window, capabilities)
 * - Explicit idempotency enforcement (templates, payments, orders)
 * - Redis TTL for idempotency keys (24-72h)
 * - Authoritative sendContext (computed, not caller-provided)
 * - Startup validation (all message types have handlers)
 * 
 * This is INFRASTRUCTURE CODE designed to serve the platform for 5+ years.
 */
export class WhatsAppMessagingService {
    private handlerRegistry: HandlerRegistry;
    private policyValidator: WhatsAppPolicyValidator;
    private provider: WhatsAppProvider;

    // Redis TTL for idempotency keys (72 hours)
    private readonly IDEMPOTENCY_TTL = 72 * 60 * 60; // 72 hours in seconds

    constructor() {
        this.handlerRegistry = new HandlerRegistry();
        this.policyValidator = new WhatsAppPolicyValidator();
        this.provider = new MetaWhatsAppCloudProvider();

        // Register all handlers
        this.registerHandlers();

        // CRITICAL: Startup validation
        // Ensures all message types have handlers
        // Prevents production incidents
        this.assertAllMessageTypesRegistered();

        console.log('[WhatsAppMessagingService] Initialized successfully');
    }

    /**
     * Send WhatsApp message
     * 
     * THE SINGLE ENTRY POINT for all message types.
     * 
     * @param payload - Unified send payload
     * @returns Send result with message ID or error
     */
    async send(payload: WhatsAppSendPayload): Promise<SendResult> {
        const traceId = payload.meta?.traceId || this.generateTraceId();

        try {
            console.log(`[WhatsAppMessagingService] [${traceId}] Sending ${payload.type} message to ${payload.to}`);

            // Step 1: Validate base payload
            this.validateBasePayload(payload);

            // Step 2: Check idempotency requirement
            const isIdempotencyRequired = this.policyValidator.isIdempotencyRequired(payload.type);

            if (isIdempotencyRequired && !payload.meta?.idempotencyKey) {
                throw createAppError(
                    ERROR_CODES.WHATSAPP_IDEMPOTENCY_REQUIRED,
                    400,
                    `Idempotency key is required for message type: ${payload.type}`,
                    { messageType: payload.type }
                );
            }

            // Step 3: Check for duplicate (idempotency)
            if (payload.meta?.idempotencyKey) {
                const duplicate = await this.checkIdempotency(payload.meta.idempotencyKey);
                if (duplicate) {
                    throw createAppError(
                        ERROR_CODES.WHATSAPP_DUPLICATE_MESSAGE,
                        409,
                        `Duplicate message detected with idempotency key: ${payload.meta.idempotencyKey}`,
                        { idempotencyKey: payload.meta.idempotencyKey, originalMessageId: duplicate.messageId }
                    );
                }
            }

            // Step 4: Compute AUTHORITATIVE sendContext
            // CRITICAL: Callers MAY NOT override this
            const sendContext = await this.policyValidator.computeSendContext(payload.to, payload.type);

            console.log(`[WhatsAppMessagingService] [${traceId}] Policy context:`, {
                isWithin24hWindow: sendContext.isWithin24hWindow,
                allowedTypes: sendContext.allowedMessageTypes.length,
            });

            // Step 5: Validate policy
            this.policyValidator.validatePolicy(payload.type, sendContext);

            // Step 6: Resolve handler by type
            const handler = this.handlerRegistry.get(payload.type);

            // Step 7: Build context for handler
            const buildContext: BuildContext = {
                sendContext,
                traceId,
                phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
            };

            // Step 8: Delegate validation to handler
            handler.validate(payload.message as any, buildContext);

            // Step 9: Build WhatsApp-native payload
            const providerPayload = handler.build(payload.message as any, buildContext);

            // Fill in recipient
            providerPayload.to = payload.to;

            // Step 10: Send via provider
            const result = await this.provider.send(providerPayload);

            // Step 11: Store idempotency key in Redis (with TTL)
            if (payload.meta?.idempotencyKey && result.success && result.messageId) {
                await this.storeIdempotencyKey(payload.meta.idempotencyKey, result.messageId);
            }

            // Step 12: Add trace ID to result
            if (result.meta) {
                result.meta.traceId = traceId;
            } else {
                result.meta = { traceId, timestamp: new Date() };
            }

            console.log(`[WhatsAppMessagingService] [${traceId}] Message sent successfully. ID: ${result.messageId}`);

            return result;
        } catch (error: any) {
            console.error(`[WhatsAppMessagingService] [${traceId}] Send failed:`, error);

            // Normalize error response
            if (error && error.code && error.statusCode) { // If it's an AppError
                return {
                    success: false,
                    error: {
                        code: error.code,
                        message: error.message,
                        details: error.details,
                    },
                    meta: {
                        traceId,
                        timestamp: new Date(),
                    },
                };
            }

            // Unknown error
            return {
                success: false,
                error: {
                    code: 'UNKNOWN_ERROR',
                    message: error.message || 'An unknown error occurred',
                    details: {
                        name: error.name,
                        stack: error.stack,
                    },
                },
                meta: {
                    traceId,
                    timestamp: new Date(),
                },
            };
        }
    }

    /**
     * Register all message type handlers
     */
    private registerHandlers(): void {
        this.handlerRegistry.register('text', new TextMessageHandler());
        this.handlerRegistry.register('template', new TemplateMessageHandler());
        this.handlerRegistry.register('image', new ImageMessageHandler());
        this.handlerRegistry.register('video', new VideoMessageHandler());
        this.handlerRegistry.register('audio', new AudioMessageHandler());
        this.handlerRegistry.register('document', new DocumentMessageHandler());
        this.handlerRegistry.register('interactive', new InteractiveMessageHandler());
        this.handlerRegistry.register('product', new ProductMessageHandler());
        this.handlerRegistry.register('product_list', new ProductListMessageHandler());
        this.handlerRegistry.register('media_carousel', new MediaCarouselMessageHandler());
        this.handlerRegistry.register('reaction', new ReactionMessageHandler());
        this.handlerRegistry.register('location', new LocationMessageHandler());
        this.handlerRegistry.register('contacts', new ContactsMessageHandler());
        this.handlerRegistry.register('flow', new FlowMessageHandler());

        console.log(`[WhatsAppMessagingService] Registered ${this.handlerRegistry.count()} handlers`);
    }

    /**
     * CRITICAL: Startup validation
     * 
     * Ensures all message types have registered handlers.
     * Prevents production incidents where a type exists without a handler.
     */
    private assertAllMessageTypesRegistered(): void {
        this.handlerRegistry.assertAllMessageTypesRegistered();
    }

    /**
     * Validate base payload structure
     */
    private validateBasePayload(payload: WhatsAppSendPayload): void {
        if (!payload.to || typeof payload.to !== 'string') {
            throw createAppError(
                ERROR_CODES.WHATSAPP_VALIDATION_ERROR,
                400,
                'Validation failed for field \'to\': Recipient phone number is required',
                { field: 'to', reason: 'Recipient phone number is required' }
            );
        }

        if (!payload.to.startsWith('+') || payload.to.length < 10) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_VALIDATION_ERROR,
                400,
                'Validation failed for field \'to\': Phone number must be in E.164 format (e.g., +1234567890)',
                { field: 'to', reason: 'Phone number must be in E.164 format (e.g., +1234567890)' }
            );
        }

        if (!payload.type) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_VALIDATION_ERROR,
                400,
                'Validation failed for field \'type\': Message type is required',
                { field: 'type', reason: 'Message type is required' }
            );
        }

        if (!payload.message) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_VALIDATION_ERROR,
                400,
                'Validation failed for field \'message\': Message payload is required',
                { field: 'message', reason: 'Message payload is required' }
            );
        }

        if ((payload.message as any).type !== payload.type) {
            throw createAppError(
                ERROR_CODES.WHATSAPP_VALIDATION_ERROR,
                400,
                'Validation failed for field \'message.type\': Message type mismatch',
                { field: 'message.type', reason: 'Message type mismatch' }
            );
        }
    }

    /**
     * Check idempotency (prevent duplicates)
     */
    private async checkIdempotency(idempotencyKey: string): Promise<{ messageId: string } | null> {
        try {
            const redis = await getRedisClient(WA_IDEMPOTENCY_DB);
            const key = `idempotency:${idempotencyKey}`;
            const messageId = await redis.get(key);

            if (messageId) {
                console.log(`[WhatsAppMessagingService] Duplicate detected: ${idempotencyKey}`);
                return { messageId };
            }

            return null;
        } catch (error: any) {
            console.error('[WhatsAppMessagingService] Redis error (idempotency check):', error);
            // Don't fail the request due to Redis issues
            return null;
        }
    }

    /**
     * Store idempotency key in Redis with TTL
     * 
     * CRITICAL: Keys MUST expire (24-72h) to prevent unbounded growth
     */
    private async storeIdempotencyKey(idempotencyKey: string, messageId: string): Promise<void> {
        try {
            const redis = await getRedisClient(WA_IDEMPOTENCY_DB);
            const key = `idempotency:${idempotencyKey}`;

            await redis.set(key, messageId, { EX: this.IDEMPOTENCY_TTL });

            console.log(`[WhatsAppMessagingService] Stored idempotency key: ${idempotencyKey} (TTL: ${this.IDEMPOTENCY_TTL}s)`);
        } catch (error: any) {
            console.error('[WhatsAppMessagingService] Redis error (store idempotency):', error);
            // Don't fail the request due to Redis issues
        }
    }

    /**
     * Generate trace ID for request tracking
     */
    private generateTraceId(): string {
        return `wa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}
