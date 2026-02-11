/**
 * WhatsApp Message Types
 * 
 * Message types map 1:1 to WhatsApp Cloud API payload roots.
 * 
 * GOVERNANCE RULE:
 * A new message type may ONLY be introduced if WhatsApp Cloud API exposes
 * a distinct payload structure that cannot be represented by an existing handler.
 * 
 * Message types map to API payload roots, NOT UX concepts.
 */
export const WhatsAppMessageTypes = [
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
] as const;

export type WhatsAppMessageType = typeof WhatsAppMessageTypes[number];

/**
 * Message Context
 * Used for threading (replies) and reactions
 */
export interface MessageContext {
    /** Message ID to reply to or react to */
    messageId: string;
}

/**
 * Message Metadata
 * 
 * IMPORTANT: idempotencyKey is REQUIRED for:
 * - template messages
 * - payment notifications
 * - order notifications
 */
export interface MessageMetadata {
    /** Required for critical message types to prevent duplicates */
    idempotencyKey?: string;

    /** Distributed tracing support */
    traceId?: string;

    /** Custom metadata for logging/tracking */
    custom?: Record<string, any>;
}

/**
 * WhatsApp Policy Context
 * 
 * CRITICAL: This is COMPUTED by the service, NOT provided by callers.
 * Handlers MUST trust this as authoritative.
 */
export interface WhatsAppSendContext {
    /** Whether recipient is within 24-hour message window */
    isWithin24hWindow: boolean;

    /** Message types allowed based on current context */
    allowedMessageTypes: WhatsAppMessageType[];

    /** Whether account has WhatsApp Flows capability */
    hasFlowCapability?: boolean;

    /** Whether account has interactive message capability */
    hasInteractiveCapability?: boolean;

    /** Region/country code (for region-specific features) */
    region?: string;
}

// ============================================================================
// Message Payload Types (Discriminated Unions)
// ============================================================================

/**
 * Text Message
 */
export interface TextMessage {
    type: 'text';
    body: string;
    /** Enable URL preview */
    previewUrl?: boolean;
}

/**
 * Template Message
 * For pre-approved WhatsApp Business templates
 */
export interface TemplateMessage {
    type: 'template';
    /** Template name (registered in WhatsApp Business Manager) */
    name: string;
    /** Template language code (e.g., 'en', 'en_US') */
    language: string;
    /** Template components (header, body, buttons) */
    components?: TemplateComponent[];
}

export interface TemplateComponent {
    type: 'header' | 'body' | 'button';
    /** Component parameters */
    parameters: TemplateParameter[];
}

export interface TemplateParameter {
    type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
    text?: string;
    currency?: {
        fallback_value: string;
        code: string;
        amount_1000: number;
    };
    date_time?: {
        fallback_value: string;
    };
    image?: {
        link: string;
    };
    document?: {
        link: string;
        filename?: string;
    };
    video?: {
        link: string;
    };
}

/**
 * Image Message
 */
export interface ImageMessage {
    type: 'image';
    /** Image URL or media ID */
    link?: string;
    id?: string;
    /** Optional caption */
    caption?: string;
}

/**
 * Video Message
 */
export interface VideoMessage {
    type: 'video';
    /** Video URL or media ID */
    link?: string;
    id?: string;
    /** Optional caption */
    caption?: string;
}

/**
 * Audio Message
 */
export interface AudioMessage {
    type: 'audio';
    /** Audio URL or media ID */
    link?: string;
    id?: string;
}

/**
 * Document Message
 */
export interface DocumentMessage {
    type: 'document';
    /** Document URL or media ID */
    link?: string;
    id?: string;
    /** Optional filename */
    filename?: string;
    /** Optional caption */
    caption?: string;
}

/**
 * Interactive Message
 * Supports buttons, lists, and CTA URLs
 */
export interface InteractiveMessage {
    type: 'interactive';
    /** Interactive message subtype */
    subtype: 'button' | 'list' | 'cta_url';
    /** Header (optional) */
    header?: InteractiveHeader;
    /** Body (required) */
    body: InteractiveBody;
    /** Footer (optional) */
    footer?: InteractiveFooter;
    /** Action (buttons, list, or CTA) */
    action: InteractiveAction;
}

export interface InteractiveHeader {
    type: 'text' | 'image' | 'video' | 'document';
    text?: string;
    image?: { link: string };
    video?: { link: string };
    document?: { link: string; filename?: string };
}

export interface InteractiveBody {
    text: string;
}

export interface InteractiveFooter {
    text: string;
}

export type InteractiveAction =
    | ButtonAction
    | ListAction
    | CTAUrlAction;

export interface ButtonAction {
    type: 'button';
    buttons: Array<{
        type: 'reply';
        reply: {
            id: string;
            title: string;
        };
    }>;
}

export interface ListAction {
    type: 'list';
    button: string;
    sections: Array<{
        title?: string;
        rows: Array<{
            id: string;
            title: string;
            description?: string;
        }>;
    }>;
}

export interface CTAUrlAction {
    type: 'cta_url';
    name: string;
    parameters: {
        display_text: string;
        url: string;
    };
}

/**
 * Product Message
 */
export interface ProductMessage {
    type: 'product';
    /** Product catalog ID */
    catalogId: string;
    /** Product retailer ID */
    productRetailerId: string;
    /** Optional body text */
    body?: string;
    /** Optional footer text */
    footer?: string;
}

/**
 * Product List Message
 */
export interface ProductListMessage {
    type: 'product_list';
    /** Header text */
    header: string;
    /** Body text */
    body: string;
    /** Footer text (optional) */
    footer?: string;
    /** Product catalog ID */
    catalogId: string;
    /** Product sections */
    sections: Array<{
        title: string;
        product_items: Array<{
            product_retailer_id: string;
        }>;
    }>;
}

/**
 * Media Carousel Message
 */
export interface MediaCarouselMessage {
    type: 'media_carousel';
    cards: Array<{
        header: {
            type: 'image' | 'video';
            image?: { link: string };
            video?: { link: string };
        };
        body: {
            text: string;
        };
    }>;
}

/**
 * Reaction Message
 */
export interface ReactionMessage {
    type: 'reaction';
    /** Message ID to react to */
    messageId: string;
    /** Emoji to react with (or empty to remove reaction) */
    emoji: string;
}

/**
 * Location Message
 */
export interface LocationMessage {
    type: 'location';
    /** Latitude */
    latitude: number;
    /** Longitude */
    longitude: number;
    /** Location name (optional) */
    name?: string;
    /** Location address (optional) */
    address?: string;
}

/**
 * Contacts Message
 */
export interface ContactsMessage {
    type: 'contacts';
    contacts: Array<{
        name: {
            formatted_name: string;
            first_name?: string;
            last_name?: string;
        };
        phones?: Array<{
            phone: string;
            type?: string;
        }>;
        emails?: Array<{
            email: string;
            type?: string;
        }>;
    }>;
}

/**
 * Flow Message
 */
export interface FlowMessage {
    type: 'flow';
    /** Flow ID */
    flowId: string;
    /** Flow action (navigate or data_exchange) */
    flowAction: 'navigate' | 'data_exchange';
    /** Flow screen */
    flowScreen?: string;
    /** Flow parameters */
    flowParameters?: Record<string, any>;
    /** Header text */
    header: string;
    /** Body text */
    body: string;
    /** Footer text (optional) */
    footer?: string;
}

/**
 * Discriminated Union of All Message Types
 */
export type WhatsAppMessage =
    | TextMessage
    | TemplateMessage
    | ImageMessage
    | VideoMessage
    | AudioMessage
    | DocumentMessage
    | InteractiveMessage
    | ProductMessage
    | ProductListMessage
    | MediaCarouselMessage
    | ReactionMessage
    | LocationMessage
    | ContactsMessage
    | FlowMessage;

/**
 * WhatsApp Send Payload
 * 
 * The single unified contract for sending any WhatsApp message.
 */
export interface WhatsAppSendPayload {
    /** Recipient phone number in E.164 format */
    to: string;

    /** Message type discriminator */
    type: WhatsAppMessageType;

    /** Message payload (discriminated union) */
    message: WhatsAppMessage;

    /** Message context (for replies/reactions) */
    context?: MessageContext;

    /** Metadata (idempotency, tracing) */
    meta: MessageMetadata;

    /**
     * Policy context (COMPUTED by service, DO NOT provide as caller)
     * @internal
     */
    sendContext?: WhatsAppSendContext;
}

/**
 * Send Result
 */
export interface SendResult {
    /** Success status */
    success: boolean;

    /** WhatsApp message ID */
    messageId?: string;

    /** Error (if failed) */
    error?: {
        code: string;
        message: string;
        details?: any;
    };

    /** Response metadata */
    meta?: {
        traceId?: string;
        timestamp: Date;
    };
}
