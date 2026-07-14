import { NotificationType } from '../models/vendor-notification.model';
import { renderTemplate, RenderContext } from './message-renderer';
import { Language, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './notification-i18n';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Notification Message Catalog (localized)
 *
 * Single source of truth for the preformatted, per-channel, per-language copy of
 * every notification situation. Each situation defines:
 *
 * - `base`     — default title/body per language. Drives in-app and is the
 *                fallback for any channel/language without an override. Holds
 *                `{{placeholders}}` filled from the handler's context.
 * - `email` / `telegram` — optional per-language text overrides.
 * - `whatsapp.text`     — optional free-form text overrides, used only inside
 *                         Meta's 24h window.
 * - `whatsapp.template` — approved Meta template name + ordered body params,
 *                         used outside the window. The same template name is
 *                         approved in all 5 languages; the language code is
 *                         chosen at send time (META_LANGUAGE_CODE).
 * - `button`   — optional shared action: a URL button on the WhatsApp template
 *                AND an appended "label: url" link on the text channels. Label
 *                is localized; the suffix is appended to VENDOR_APP_URL.
 *
 * Translations are maintained for: en, fr, pt, es, ar.
 */

export interface ChannelText {
    /** Title / subject / header line. */
    subject: string;
    /** Body text. */
    body: string;
}

export type ChannelTextOverride = Partial<ChannelText>;

export interface WhatsAppTemplateDef {
    /** Template name as registered/approved in WhatsApp Business Manager. */
    name: string;
    /** Ordered body parameters; each a placeholder-bearing string. */
    bodyParams: string[];
}

export interface ButtonDef {
    type: 'url';
    /** Localized button / link label. */
    label: Record<Language, string>;
    /** Placeholder-bearing path appended to VENDOR_APP_URL, e.g. `orders/{{orderId}}`. */
    urlSuffix: string;
}

export interface SituationMessages {
    base: Record<Language, ChannelText>;
    email?: Partial<Record<Language, ChannelTextOverride>>;
    telegram?: Partial<Record<Language, ChannelTextOverride>>;
    whatsapp: {
        text?: Partial<Record<Language, ChannelTextOverride>>;
        template: WhatsAppTemplateDef;
    };
    button?: ButtonDef;
}

// ─── Shared button label sets ────────────────────────────────────────────────

const VIEW_ORDER_LABEL: Record<Language, string> = {
    en: 'View order',
    fr: 'Voir la commande',
    pt: 'Ver pedido',
    es: 'Ver pedido',
    ar: 'عرض الطلب'
};

const VIEW_BOOKING_LABEL: Record<Language, string> = {
    en: 'View booking',
    fr: 'Voir la réservation',
    pt: 'Ver reserva',
    es: 'Ver reserva',
    ar: 'عرض الحجز'
};

const MANAGE_STORAGE_LABEL: Record<Language, string> = {
    en: 'Manage storage',
    fr: 'Gérer le stockage',
    pt: 'Gerir armazenamento',
    es: 'Almacenamiento',
    ar: 'إدارة التخزين'
};

const VIEW_CONNECTION_LABEL: Record<Language, string> = {
    en: 'View connection',
    fr: 'Voir la connexion',
    pt: 'Ver conexão',
    es: 'Ver conexión',
    ar: 'عرض الاتصال'
};

const VIEW_TICKET_LABEL: Record<Language, string> = {
    en: 'View ticket',
    fr: 'Voir le ticket',
    pt: 'Ver o chamado',
    es: 'Ver el ticket',
    ar: 'عرض التذكرة'
};

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const NOTIFICATION_CATALOG: Record<NotificationType, SituationMessages> = {
    'order.created': {
        base: {
            en: { subject: 'New order received', body: 'You received a new order #{{orderNumber}} for {{currency}} {{amountFormatted}}.' },
            fr: { subject: 'Nouvelle commande reçue', body: 'Vous avez reçu une nouvelle commande n°{{orderNumber}} pour {{currency}} {{amountFormatted}}.' },
            pt: { subject: 'Novo pedido recebido', body: 'Você recebeu um novo pedido nº{{orderNumber}} no valor de {{currency}} {{amountFormatted}}.' },
            es: { subject: 'Nuevo pedido recibido', body: 'Has recibido un nuevo pedido n.º{{orderNumber}} por {{currency}} {{amountFormatted}}.' },
            ar: { subject: 'تم استلام طلب جديد', body: 'لقد استلمت طلبًا جديدًا رقم {{orderNumber}} بقيمة {{currency}} {{amountFormatted}}.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_order_created', bodyParams: ['{{orderNumber}}', '{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_ORDER_LABEL, urlSuffix: 'orders/{{orderId}}' }
    },

    'order.cancelled': {
        base: {
            en: { subject: 'Order cancelled', body: 'Order #{{orderNumber}} has been cancelled.' },
            fr: { subject: 'Commande annulée', body: 'La commande n°{{orderNumber}} a été annulée.' },
            pt: { subject: 'Pedido cancelado', body: 'O pedido nº{{orderNumber}} foi cancelado.' },
            es: { subject: 'Pedido cancelado', body: 'El pedido n.º{{orderNumber}} ha sido cancelado.' },
            ar: { subject: 'تم إلغاء الطلب', body: 'تم إلغاء الطلب رقم {{orderNumber}}.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_order_cancelled', bodyParams: ['{{orderNumber}}'] }
        },
        button: { type: 'url', label: VIEW_ORDER_LABEL, urlSuffix: 'orders/{{orderId}}' }
    },

    'booking.created': {
        base: {
            en: { subject: 'New booking', body: 'New booking #{{bookingNumber}} for {{serviceName}} scheduled on {{startDate}}.' },
            fr: { subject: 'Nouvelle réservation', body: 'Nouvelle réservation n°{{bookingNumber}} pour {{serviceName}} prévue le {{startDate}}.' },
            pt: { subject: 'Nova reserva', body: 'Nova reserva nº{{bookingNumber}} para {{serviceName}} agendada para {{startDate}}.' },
            es: { subject: 'Nueva reserva', body: 'Nueva reserva n.º{{bookingNumber}} para {{serviceName}} programada para el {{startDate}}.' },
            ar: { subject: 'حجز جديد', body: 'حجز جديد رقم {{bookingNumber}} لـ {{serviceName}} مقرر في {{startDate}}.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_booking_created', bodyParams: ['{{bookingNumber}}', '{{serviceName}}', '{{startDate}}'] }
        },
        button: { type: 'url', label: VIEW_BOOKING_LABEL, urlSuffix: 'bookings/{{bookingId}}' }
    },

    'booking.cancelled': {
        base: {
            en: { subject: 'Booking cancelled', body: 'Booking #{{bookingNumber}} has been cancelled.' },
            fr: { subject: 'Réservation annulée', body: 'La réservation n°{{bookingNumber}} a été annulée.' },
            pt: { subject: 'Reserva cancelada', body: 'A reserva nº{{bookingNumber}} foi cancelada.' },
            es: { subject: 'Reserva cancelada', body: 'La reserva n.º{{bookingNumber}} ha sido cancelada.' },
            ar: { subject: 'تم إلغاء الحجز', body: 'تم إلغاء الحجز رقم {{bookingNumber}}.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_booking_cancelled', bodyParams: ['{{bookingNumber}}'] }
        },
        button: { type: 'url', label: VIEW_BOOKING_LABEL, urlSuffix: 'bookings/{{bookingId}}' }
    },

    'payment.received.partial': {
        base: {
            en: { subject: 'Partial payment received', body: 'You received a partial payment of {{currency}} {{amountFormatted}}.' },
            fr: { subject: 'Paiement partiel reçu', body: 'Vous avez reçu un paiement partiel de {{currency}} {{amountFormatted}}.' },
            pt: { subject: 'Pagamento parcial recebido', body: 'Você recebeu um pagamento parcial de {{currency}} {{amountFormatted}}.' },
            es: { subject: 'Pago parcial recibido', body: 'Has recibido un pago parcial de {{currency}} {{amountFormatted}}.' },
            ar: { subject: 'تم استلام دفعة جزئية', body: 'لقد استلمت دفعة جزئية بقيمة {{currency}} {{amountFormatted}}.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_payment_partial', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_ORDER_LABEL, urlSuffix: 'orders/{{orderId}}' }
    },

    'payment.received.full': {
        base: {
            en: { subject: 'Payment received', body: 'You received a full payment of {{currency}} {{amountFormatted}}.' },
            fr: { subject: 'Paiement reçu', body: 'Vous avez reçu un paiement complet de {{currency}} {{amountFormatted}}.' },
            pt: { subject: 'Pagamento recebido', body: 'Você recebeu o pagamento total de {{currency}} {{amountFormatted}}.' },
            es: { subject: 'Pago recibido', body: 'Has recibido el pago completo de {{currency}} {{amountFormatted}}.' },
            ar: { subject: 'تم استلام الدفعة', body: 'لقد استلمت دفعة كاملة بقيمة {{currency}} {{amountFormatted}}.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_payment_full', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_ORDER_LABEL, urlSuffix: 'orders/{{orderId}}' }
    },

    'storage.alert': {
        base: {
            en: { subject: 'Storage almost full', body: 'Your media storage is at {{percentUsed}}% ({{usageFormatted}} of {{limitFormatted}}). Free up space or upgrade your plan.' },
            fr: { subject: 'Stockage presque plein', body: 'Votre stockage multimédia est à {{percentUsed}}% ({{usageFormatted}} sur {{limitFormatted}}). Libérez de l\'espace ou améliorez votre forfait.' },
            pt: { subject: 'Armazenamento quase cheio', body: 'Seu armazenamento de mídia está em {{percentUsed}}% ({{usageFormatted}} de {{limitFormatted}}). Libere espaço ou atualize seu plano.' },
            es: { subject: 'Almacenamiento casi lleno', body: 'Tu almacenamiento multimedia está al {{percentUsed}}% ({{usageFormatted}} de {{limitFormatted}}). Libera espacio o mejora tu plan.' },
            ar: { subject: 'مساحة التخزين ممتلئة تقريبًا', body: 'مساحة تخزين الوسائط لديك عند {{percentUsed}}% ({{usageFormatted}} من {{limitFormatted}}). حرّر مساحة أو قم بترقية باقتك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_storage_alert', bodyParams: ['{{percentUsed}}', '{{usageFormatted}}', '{{limitFormatted}}'] }
        },
        button: { type: 'url', label: MANAGE_STORAGE_LABEL, urlSuffix: 'settings/storage' }
    },

    // NOTE: the WhatsApp template names below (vendor_connection_*) still need to be
    // created and approved in Meta Business Manager before WhatsApp delivery will
    // actually succeed for these situations — in-app/email/telegram/push work today
    // regardless. Same bootstrapping step every new situation in this catalog needs.
    'connection.request_received': {
        base: {
            en: { subject: 'New connection request', body: '{{agencyName}} wants to connect with you as a delivery partner.' },
            fr: { subject: 'Nouvelle demande de connexion', body: '{{agencyName}} souhaite se connecter avec vous en tant que partenaire de livraison.' },
            pt: { subject: 'Novo pedido de conexão', body: '{{agencyName}} deseja se conectar com você como parceiro de entrega.' },
            es: { subject: 'Nueva solicitud de conexión', body: '{{agencyName}} quiere conectarse contigo como socio de entrega.' },
            ar: { subject: 'طلب اتصال جديد', body: 'ترغب {{agencyName}} في الاتصال بك كشريك توصيل.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_connection_request_received', bodyParams: ['{{agencyName}}'] }
        },
        button: { type: 'url', label: VIEW_CONNECTION_LABEL, urlSuffix: 'agency-connections/{{connectionId}}' }
    },

    'connection.approved': {
        base: {
            en: { subject: 'Connection approved', body: '{{agencyName}} approved your connection request. You can now select them as a delivery agency.' },
            fr: { subject: 'Connexion approuvée', body: '{{agencyName}} a approuvé votre demande de connexion. Vous pouvez maintenant la sélectionner comme agence de livraison.' },
            pt: { subject: 'Conexão aprovada', body: '{{agencyName}} aprovou seu pedido de conexão. Agora você pode selecioná-la como agência de entrega.' },
            es: { subject: 'Conexión aprobada', body: '{{agencyName}} aprobó tu solicitud de conexión. Ahora puedes seleccionarla como agencia de entrega.' },
            ar: { subject: 'تمت الموافقة على الاتصال', body: 'وافقت {{agencyName}} على طلب الاتصال الخاص بك. يمكنك الآن اختيارها كوكالة توصيل.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_connection_approved', bodyParams: ['{{agencyName}}'] }
        },
        button: { type: 'url', label: VIEW_CONNECTION_LABEL, urlSuffix: 'agency-connections/{{connectionId}}' }
    },

    'connection.rejected': {
        base: {
            en: { subject: 'Connection request rejected', body: '{{agencyName}} declined your connection request.' },
            fr: { subject: 'Demande de connexion refusée', body: '{{agencyName}} a refusé votre demande de connexion.' },
            pt: { subject: 'Pedido de conexão recusado', body: '{{agencyName}} recusou seu pedido de conexão.' },
            es: { subject: 'Solicitud de conexión rechazada', body: '{{agencyName}} rechazó tu solicitud de conexión.' },
            ar: { subject: 'تم رفض طلب الاتصال', body: 'رفضت {{agencyName}} طلب الاتصال الخاص بك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_connection_rejected', bodyParams: ['{{agencyName}}'] }
        },
        button: { type: 'url', label: VIEW_CONNECTION_LABEL, urlSuffix: 'agency-connections/{{connectionId}}' }
    },

    'connection.reapproval_needed': {
        base: {
            en: { subject: 'Reapproval needed', body: '{{agencyName}} updated their policies. Reapprove your connection to keep your products active.' },
            fr: { subject: 'Réapprobation requise', body: '{{agencyName}} a mis à jour ses politiques. Réapprouvez votre connexion pour garder vos produits actifs.' },
            pt: { subject: 'Reaprovação necessária', body: '{{agencyName}} atualizou suas políticas. Reaprove sua conexão para manter seus produtos ativos.' },
            es: { subject: 'Reaprobación necesaria', body: '{{agencyName}} actualizó sus políticas. Vuelve a aprobar tu conexión para mantener tus productos activos.' },
            ar: { subject: 'الموافقة مطلوبة مرة أخرى', body: 'قامت {{agencyName}} بتحديث سياساتها. أعد الموافقة على اتصالك للحفاظ على نشاط منتجاتك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_connection_reapproval_needed', bodyParams: ['{{agencyName}}'] }
        },
        button: { type: 'url', label: VIEW_CONNECTION_LABEL, urlSuffix: 'agency-connections/{{connectionId}}' }
    },

    'payout.requested': {
        base: {
            en: { subject: 'Payout request created', body: 'Your request to withdraw {{currency}} {{amountFormatted}} was created. Track its progress under Tickets.' },
            fr: { subject: 'Demande de paiement créée', body: 'Votre demande de retrait de {{currency}} {{amountFormatted}} a été créée. Suivez son avancement dans Tickets.' },
            pt: { subject: 'Pedido de pagamento criado', body: 'Seu pedido de retirada de {{currency}} {{amountFormatted}} foi criado. Acompanhe o progresso em Chamados.' },
            es: { subject: 'Solicitud de pago creada', body: 'Tu solicitud de retiro de {{currency}} {{amountFormatted}} fue creada. Sigue su progreso en Tickets.' },
            ar: { subject: 'تم إنشاء طلب السحب', body: 'تم إنشاء طلبك لسحب {{currency}} {{amountFormatted}}. تابع التقدم ضمن التذاكر.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_payout_requested', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_TICKET_LABEL, urlSuffix: 'tickets/{{ticketId}}' }
    },

    'payout.paid': {
        base: {
            en: { subject: 'Payout paid', body: 'Your payout of {{currency}} {{amountFormatted}} has been paid.' },
            fr: { subject: 'Paiement effectué', body: 'Votre paiement de {{currency}} {{amountFormatted}} a été effectué.' },
            pt: { subject: 'Pagamento efetuado', body: 'Seu pagamento de {{currency}} {{amountFormatted}} foi efetuado.' },
            es: { subject: 'Pago realizado', body: 'Tu pago de {{currency}} {{amountFormatted}} ha sido realizado.' },
            ar: { subject: 'تم الدفع', body: 'تم دفع مبلغ {{currency}} {{amountFormatted}} الخاص بك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_payout_paid', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_TICKET_LABEL, urlSuffix: 'tickets/{{ticketId}}' }
    },

    'payout.rejected': {
        base: {
            en: { subject: 'Payout request rejected', body: 'Your request to withdraw {{currency}} {{amountFormatted}} was rejected. See Tickets for the reason.' },
            fr: { subject: 'Demande de paiement refusée', body: 'Votre demande de retrait de {{currency}} {{amountFormatted}} a été refusée. Voir Tickets pour le motif.' },
            pt: { subject: 'Pedido de pagamento rejeitado', body: 'Seu pedido de retirada de {{currency}} {{amountFormatted}} foi rejeitado. Veja o motivo em Chamados.' },
            es: { subject: 'Solicitud de pago rechazada', body: 'Tu solicitud de retiro de {{currency}} {{amountFormatted}} fue rechazada. Consulta el motivo en Tickets.' },
            ar: { subject: 'تم رفض طلب السحب', body: 'تم رفض طلبك لسحب {{currency}} {{amountFormatted}}. راجع السبب ضمن التذاكر.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_payout_rejected', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_TICKET_LABEL, urlSuffix: 'tickets/{{ticketId}}' }
    }
};

// ─── Rendering helpers ───────────────────────────────────────────────────────

/**
 * Fail fast if any situation is missing a base translation for a supported
 * language. Called at notification consumer startup so a missing translation
 * surfaces immediately rather than at send time.
 */
export function assertCatalogComplete(): void {
    for (const situation of Object.keys(NOTIFICATION_CATALOG) as NotificationType[]) {
        for (const lang of SUPPORTED_LANGUAGES) {
            if (!NOTIFICATION_CATALOG[situation].base[lang]) {
                throw createAppError(
                    ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
                    500,
                    `Missing '${lang}' base copy for notification situation '${situation}'`
                );
            }
        }
    }
}

/** Pick a language's text, falling back to the default language. */
function pickLang<T>(map: Partial<Record<Language, T>>, lang: Language): T | undefined {
    return map[lang] ?? map[DEFAULT_LANGUAGE];
}

/** Render the in-app (base) title/message for a situation in the given language. */
export function renderInApp(
    situation: NotificationType,
    lang: Language,
    ctx: RenderContext
): { title: string; message: string } {
    const base = pickLang(NOTIFICATION_CATALOG[situation].base, lang)!;
    return {
        title: renderTemplate(base.subject, ctx),
        message: renderTemplate(base.body, ctx)
    };
}

/**
 * Render a secondary-channel's text in the given language, applying the
 * channel + language override over the language's base.
 */
export function renderChannelText(
    situation: NotificationType,
    channel: 'email' | 'telegram' | 'whatsapp',
    lang: Language,
    ctx: RenderContext
): ChannelText {
    const entry = NOTIFICATION_CATALOG[situation];
    const base = pickLang(entry.base, lang)!;

    const overrideMap =
        channel === 'email'
            ? entry.email
            : channel === 'telegram'
                ? entry.telegram
                : entry.whatsapp.text;

    const override = overrideMap ? pickLang(overrideMap, lang) : undefined;

    return {
        subject: renderTemplate(override?.subject ?? base.subject, ctx),
        body: renderTemplate(override?.body ?? base.body, ctx)
    };
}

/** The Meta template name for a situation. */
export function whatsAppTemplateName(situation: NotificationType): string {
    return NOTIFICATION_CATALOG[situation].whatsapp.template.name;
}

/** Render the ordered WhatsApp template body parameters for a situation. */
export function renderWhatsAppTemplateParams(
    situation: NotificationType,
    lang: Language,
    ctx: RenderContext
): string[] {
    const tpl = NOTIFICATION_CATALOG[situation].whatsapp.template;
    const inApp = renderInApp(situation, lang, ctx);
    const merged: RenderContext = { ...ctx, title: inApp.title, message: inApp.message };
    return tpl.bodyParams.map(param => renderTemplate(param, merged));
}

/**
 * Resolve a situation's action button into a localized label + absolute URL.
 * Returns null when the situation has no button or no base URL is configured.
 */
export function renderButton(
    situation: NotificationType,
    lang: Language,
    ctx: RenderContext,
    baseUrl: string | undefined
): { label: string; url: string; urlSuffix: string } | null {
    const button = NOTIFICATION_CATALOG[situation].button;
    if (!button) return null;

    const urlSuffix = renderTemplate(button.urlSuffix, ctx);
    const label = button.label[lang] ?? button.label[DEFAULT_LANGUAGE];
    const trimmedBase = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
    const url = trimmedBase ? `${trimmedBase}/${urlSuffix}` : urlSuffix;

    return { label, url, urlSuffix };
}
