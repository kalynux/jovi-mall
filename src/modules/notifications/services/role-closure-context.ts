import { formatInTimeZone } from 'date-fns-tz';
import { Language, DEFAULT_LANGUAGE } from '../catalog/notification-i18n';

/**
 * Role closure (ADR-A10) — the context values all four notification stacks build for
 * `account.closure_requested` and the `*.ended_by_closure` counterparty notices.
 *
 * Shared because the four handlers must agree on three rules, each of which fails a
 * WhatsApp send outright when broken:
 *
 *  - **No empty parameter.** Meta refuses a template send whose parameter value is empty
 *    (`test:booking-notification` records why that is fatal), so every value here has a
 *    localized fallback.
 *  - **No newline, tab or run of spaces in a parameter.** Meta refuses those too, and the
 *    administrator's `reason` is free text.
 *  - **Times in the RECIPIENT's zone**, `yyyy-MM-dd HH:mm`, locale-neutral — the same format
 *    and reasoning as the customer stack's `formatMoment` and the vendor stack's
 *    `formatBookingMoment`. A deadline printed in UTC is an hour wrong in Douala.
 */

/** Longest reason quoted in a notification. The full text stays on the request. */
const MAX_REASON_CHARS = 300;

const NO_REASON: Record<Language, string> = {
    en: 'no reason was given',
    fr: 'aucun motif n\'a été indiqué',
    pt: 'não foi indicado nenhum motivo',
    es: 'no se indicó ningún motivo',
    ar: 'لم يُذكر أي سبب'
};

/** The administrator's reason as one safe template parameter. */
export function closureReasonParam(reason: unknown, lang: Language): string {
    const flat = typeof reason === 'string'
        ? reason.replace(/\s+/g, ' ').trim()
            // The copy supplies its own full stop after `{{reason}}`.
            .replace(/[.!?…\s]+$/u, '')
        : '';
    if (!flat) return NO_REASON[lang] ?? NO_REASON[DEFAULT_LANGUAGE];
    return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…` : flat;
}

const SOON: Record<Language, string> = {
    en: 'the request expires',
    fr: 'l\'expiration de la demande',
    pt: 'o pedido expirar',
    es: 'que caduque la solicitud',
    ar: 'انتهاء صلاحية الطلب'
};

/** The confirmation deadline in the recipient's timezone, never empty. */
export function closureDeadlineParam(expiresAt: unknown, timezone: unknown, lang: Language): string {
    const date = expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt ?? ''));
    if (isNaN(date.getTime())) return SOON[lang] ?? SOON[DEFAULT_LANGUAGE];

    const zone = typeof timezone === 'string' && timezone ? timezone : 'Africa/Douala';
    try {
        return formatInTimeZone(date, zone, 'yyyy-MM-dd HH:mm');
    } catch {
        // An unrecognised IANA name — a UTC instant beats no deadline at all.
        return date.toISOString().slice(0, 16).replace('T', ' ');
    }
}

/** Who closed, when `closingName` arrived empty — a neutral phrase, never a hole. */
export const CLOSING_PARTY_FALLBACK = {
    agency: { en: 'A partner agency', fr: 'Une agence partenaire', pt: 'Uma agência parceira', es: 'Una agencia asociada', ar: 'وكالة شريكة' },
    vendor: { en: 'A partner vendor', fr: 'Un vendeur partenaire', pt: 'Um vendedor parceiro', es: 'Un vendedor asociado', ar: 'بائع شريك' },
    agent: { en: 'One of your agents', fr: 'Un de vos agents', pt: 'Um dos seus agentes', es: 'Uno de tus agentes', ar: 'أحد وكلائك' }
} as const satisfies Record<string, Record<Language, string>>;

export function closingPartyName(
    closingName: unknown,
    role: keyof typeof CLOSING_PARTY_FALLBACK,
    lang: Language
): string {
    const name = typeof closingName === 'string' ? closingName.replace(/\s+/g, ' ').trim() : '';
    return name || CLOSING_PARTY_FALLBACK[role][lang] || CLOSING_PARTY_FALLBACK[role][DEFAULT_LANGUAGE];
}

/** The `role_closure.requested` payload, as published by `src/modules/role-closure/`. */
export interface RoleClosureRequestedPayload {
    requestId: string;
    userId: string;
    role: 'customer' | 'vendor' | 'agency' | 'agent';
    roleEntityId: string;
    reason: string;
    expiresAt: string;
}

/** The `role_closure.relationships_ended` payload. */
export interface RoleClosureRelationshipsEndedPayload {
    closingRole: 'vendor' | 'agency' | 'agent';
    closingName: string;
    contracts?: Array<{ contractId: string; agentId: string; agencyId: string }>;
    connections?: Array<{ connectionId: string; vendorId: string; agencyId: string }>;
}

/** `occurredAt` as an ISO string for idempotency keys, tolerant of a string or missing value. */
export function occurredAtIso(occurredAt: unknown): string {
    const d = occurredAt instanceof Date ? occurredAt : new Date(String(occurredAt ?? ''));
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
