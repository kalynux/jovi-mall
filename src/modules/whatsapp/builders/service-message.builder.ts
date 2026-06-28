import {
    WhatsAppSendPayload,
    MessageMetadata,
    InteractiveHeader,
    InteractiveFooter,
    ListAction,
    ContactsMessage
} from '../types/whatsapp-message.types';
import { WA_LIMITS, truncate } from '../constants/whatsapp-limits';

/**
 * WhatsApp Service-Message Builders
 *
 * Ergonomic factories for WhatsApp "service messages" — the free-form messages
 * deliverable inside Meta's 24h customer-service window (text, media, interactive
 * button/list/cta_url, contacts, location, reaction).
 *
 * Each function takes minimal params and returns a ready `WhatsAppSendPayload`
 * for `WhatsAppMessagingService.send()`. They ONLY assemble the typed
 * discriminated-union message — validation, 24h-window/capability policy,
 * idempotency and billing remain the messaging service's job (so callers can't
 * accidentally bypass policy the way a raw payload builder would).
 *
 * Localization is the caller's concern: pass already-resolved strings (resolve
 * language via core `Language`/`resolveLanguage`).
 */

/** A header may be given as plain text or a full interactive header object. */
export type HeaderInput = string | InteractiveHeader;

function toHeader(header?: HeaderInput): InteractiveHeader | undefined {
    if (header === undefined) return undefined;
    // Only text headers are length-capped here; media headers pass through.
    return typeof header === 'string'
        ? { type: 'text', text: truncate(header, WA_LIMITS.HEADER_TEXT) as string }
        : header;
}

function toFooter(footer?: string): InteractiveFooter | undefined {
    return footer === undefined ? undefined : { text: truncate(footer, WA_LIMITS.FOOTER_TEXT) as string };
}

const EMPTY_META: MessageMetadata = {};

export interface TextOptions {
    to: string;
    body: string;
    previewUrl?: boolean;
    meta?: MessageMetadata;
}

export interface MediaOptions {
    to: string;
    /** Public URL of the media. Provide `link` or `id`. */
    link?: string;
    /** Pre-uploaded WhatsApp media id. Provide `link` or `id`. */
    id?: string;
    caption?: string;
    meta?: MessageMetadata;
}

export interface DocumentOptions extends MediaOptions {
    filename?: string;
}

export interface ReplyButtonInput {
    id: string;
    title: string;
}

export interface ButtonsOptions {
    to: string;
    body: string;
    buttons: ReplyButtonInput[];
    header?: HeaderInput;
    footer?: string;
    meta?: MessageMetadata;
}

export interface ListOptions {
    to: string;
    body: string;
    /** Text on the button that opens the list. */
    button: string;
    sections: ListAction['sections'];
    header?: HeaderInput;
    footer?: string;
    meta?: MessageMetadata;
}

export interface CtaUrlOptions {
    to: string;
    body: string;
    /** Visible button label. */
    displayText: string;
    url: string;
    header?: HeaderInput;
    footer?: string;
    /** Action name (defaults to 'cta_url'). */
    name?: string;
    meta?: MessageMetadata;
}

export interface ContactsOptions {
    to: string;
    contacts: ContactsMessage['contacts'];
    meta?: MessageMetadata;
}

export interface LocationOptions {
    to: string;
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
    meta?: MessageMetadata;
}

export interface ReactionOptions {
    to: string;
    /** Message id to react to. */
    messageId: string;
    /** Emoji, or empty string to remove the reaction. */
    emoji: string;
    meta?: MessageMetadata;
}

/**
 * Service-message builders. Each returns a `WhatsAppSendPayload` ready for
 * `WhatsAppMessagingService.send()`.
 */
export const WaServiceMessage = {
    text({ to, body, previewUrl, meta }: TextOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'text',
            message: { type: 'text', body: truncate(body, WA_LIMITS.TEXT_BODY) as string, previewUrl },
            meta: meta ?? EMPTY_META
        };
    },

    image({ to, link, id, caption, meta }: MediaOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'image',
            message: { type: 'image', link, id, caption: truncate(caption, WA_LIMITS.MEDIA_CAPTION) },
            meta: meta ?? EMPTY_META
        };
    },

    video({ to, link, id, caption, meta }: MediaOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'video',
            message: { type: 'video', link, id, caption: truncate(caption, WA_LIMITS.MEDIA_CAPTION) },
            meta: meta ?? EMPTY_META
        };
    },

    audio({ to, link, id, meta }: MediaOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'audio',
            message: { type: 'audio', link, id },
            meta: meta ?? EMPTY_META
        };
    },

    document({ to, link, id, filename, caption, meta }: DocumentOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'document',
            message: { type: 'document', link, id, filename, caption: truncate(caption, WA_LIMITS.MEDIA_CAPTION) },
            meta: meta ?? EMPTY_META
        };
    },

    buttons({ to, body, buttons, header, footer, meta }: ButtonsOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'interactive',
            message: {
                type: 'interactive',
                subtype: 'button',
                header: toHeader(header),
                body: { text: truncate(body, WA_LIMITS.INTERACTIVE_BODY) as string },
                footer: toFooter(footer),
                action: {
                    type: 'button',
                    buttons: buttons.map(b => ({
                        type: 'reply',
                        reply: { id: b.id, title: truncate(b.title, WA_LIMITS.BUTTON_REPLY_TITLE) as string }
                    }))
                }
            },
            meta: meta ?? EMPTY_META
        };
    },

    list({ to, body, button, sections, header, footer, meta }: ListOptions): WhatsAppSendPayload {
        const cappedSections = sections.map(section => ({
            ...section,
            title: truncate(section.title, WA_LIMITS.LIST_SECTION_TITLE),
            rows: section.rows.map(row => ({
                ...row,
                title: truncate(row.title, WA_LIMITS.LIST_ROW_TITLE) as string,
                description: truncate(row.description, WA_LIMITS.LIST_ROW_DESCRIPTION)
            }))
        }));

        return {
            to,
            type: 'interactive',
            message: {
                type: 'interactive',
                subtype: 'list',
                header: toHeader(header),
                body: { text: truncate(body, WA_LIMITS.INTERACTIVE_BODY) as string },
                footer: toFooter(footer),
                action: {
                    type: 'list',
                    button: truncate(button, WA_LIMITS.LIST_BUTTON) as string,
                    sections: cappedSections as ListAction['sections']
                }
            },
            meta: meta ?? EMPTY_META
        };
    },

    ctaUrl({ to, body, displayText, url, header, footer, name, meta }: CtaUrlOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'interactive',
            message: {
                type: 'interactive',
                subtype: 'cta_url',
                header: toHeader(header),
                body: { text: truncate(body, WA_LIMITS.INTERACTIVE_BODY) as string },
                footer: toFooter(footer),
                action: {
                    type: 'cta_url',
                    name: name ?? 'cta_url',
                    parameters: { display_text: truncate(displayText, WA_LIMITS.CTA_DISPLAY_TEXT) as string, url }
                }
            },
            meta: meta ?? EMPTY_META
        };
    },

    contacts({ to, contacts, meta }: ContactsOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'contacts',
            message: { type: 'contacts', contacts },
            meta: meta ?? EMPTY_META
        };
    },

    location({ to, latitude, longitude, name, address, meta }: LocationOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'location',
            message: {
                type: 'location',
                latitude,
                longitude,
                name: truncate(name, WA_LIMITS.LOCATION_NAME),
                address: truncate(address, WA_LIMITS.LOCATION_ADDRESS)
            },
            meta: meta ?? EMPTY_META
        };
    },

    reaction({ to, messageId, emoji, meta }: ReactionOptions): WhatsAppSendPayload {
        return {
            to,
            type: 'reaction',
            message: { type: 'reaction', messageId, emoji },
            meta: meta ?? EMPTY_META
        };
    }
};
