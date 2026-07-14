import { AgencyNotificationType } from '../models/agency-notification.model';
import { renderTemplate, RenderContext } from './message-renderer';
import { Language, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './notification-i18n';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ChannelText, SituationMessages, ButtonDef } from './notification-catalog';

/**
 * Agency Notification Message Catalog (localized)
 *
 * Agency-facing counterpart to notification-catalog.ts. Same shape and
 * rendering rules (see that file's doc comment) — copy here is written from
 * the AGENCY's point of view (e.g. "{{vendorName}} wants to connect with
 * you"), which is why it can't just reuse the vendor catalog's entries even
 * though the underlying connection.* / payout.* situations are shared.
 *
 * Translations are maintained for: en, fr, pt, es, ar.
 */

// ─── Shared button label sets ────────────────────────────────────────────────

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

const CONNECTION_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_CONNECTION_LABEL,
    urlSuffix: 'vendor-connections/{{connectionId}}'
};

const TICKET_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_TICKET_LABEL,
    urlSuffix: 'tickets/{{ticketId}}'
};

// ─── Catalog ─────────────────────────────────────────────────────────────────

// NOTE: the WhatsApp template names below (agency_*) still need to be created
// and approved in Meta Business Manager before WhatsApp delivery will actually
// succeed for these situations — in-app/email/telegram/push work today
// regardless. Same bootstrapping step every new situation in this catalog needs.
export const AGENCY_NOTIFICATION_CATALOG: Record<AgencyNotificationType, SituationMessages> = {
    'connection.request_received': {
        base: {
            en: { subject: 'New connection request', body: '{{vendorName}} wants to connect with you as their delivery partner.' },
            fr: { subject: 'Nouvelle demande de connexion', body: '{{vendorName}} souhaite se connecter avec vous en tant que partenaire de livraison.' },
            pt: { subject: 'Novo pedido de conexão', body: '{{vendorName}} deseja se conectar com você como parceiro de entrega.' },
            es: { subject: 'Nueva solicitud de conexión', body: '{{vendorName}} quiere conectarse contigo como socio de entrega.' },
            ar: { subject: 'طلب اتصال جديد', body: 'ترغب {{vendorName}} في الاتصال بك كشريك توصيل.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_connection_request_received', bodyParams: ['{{vendorName}}'] }
        },
        button: CONNECTION_BUTTON
    },

    'connection.approved': {
        base: {
            en: { subject: 'Connection approved', body: '{{vendorName}} approved your connection request. You can now deliver for them.' },
            fr: { subject: 'Connexion approuvée', body: '{{vendorName}} a approuvé votre demande de connexion. Vous pouvez maintenant livrer pour eux.' },
            pt: { subject: 'Conexão aprovada', body: '{{vendorName}} aprovou seu pedido de conexão. Agora você pode entregar para eles.' },
            es: { subject: 'Conexión aprobada', body: '{{vendorName}} aprobó tu solicitud de conexión. Ahora puedes entregar para ellos.' },
            ar: { subject: 'تمت الموافقة على الاتصال', body: 'وافقت {{vendorName}} على طلب الاتصال الخاص بك. يمكنك الآن التوصيل لهم.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_connection_approved', bodyParams: ['{{vendorName}}'] }
        },
        button: CONNECTION_BUTTON
    },

    'connection.rejected': {
        base: {
            en: { subject: 'Connection request declined', body: '{{vendorName}} declined your connection request.' },
            fr: { subject: 'Demande de connexion refusée', body: '{{vendorName}} a refusé votre demande de connexion.' },
            pt: { subject: 'Pedido de conexão recusado', body: '{{vendorName}} recusou seu pedido de conexão.' },
            es: { subject: 'Solicitud de conexión rechazada', body: '{{vendorName}} rechazó tu solicitud de conexión.' },
            ar: { subject: 'تم رفض طلب الاتصال', body: 'رفضت {{vendorName}} طلب الاتصال الخاص بك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_connection_rejected', bodyParams: ['{{vendorName}}'] }
        },
        button: CONNECTION_BUTTON
    },

    'connection.reapproval_needed': {
        base: {
            en: { subject: 'Reapproval needed', body: '{{vendorName}} updated their policies. Reapprove your connection to keep delivering for them.' },
            fr: { subject: 'Réapprobation requise', body: '{{vendorName}} a mis à jour ses politiques. Réapprouvez votre connexion pour continuer à livrer pour eux.' },
            pt: { subject: 'Reaprovação necessária', body: '{{vendorName}} atualizou suas políticas. Reaprove sua conexão para continuar entregando para eles.' },
            es: { subject: 'Reaprobación necesaria', body: '{{vendorName}} actualizó sus políticas. Vuelve a aprobar tu conexión para seguir entregando para ellos.' },
            ar: { subject: 'الموافقة مطلوبة مرة أخرى', body: 'قامت {{vendorName}} بتحديث سياساتها. أعد الموافقة على اتصالك لمواصلة التوصيل لهم.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_connection_reapproval_needed', bodyParams: ['{{vendorName}}'] }
        },
        button: CONNECTION_BUTTON
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
            template: { name: 'agency_payout_requested', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: TICKET_BUTTON
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
            template: { name: 'agency_payout_paid', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: TICKET_BUTTON
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
            template: { name: 'agency_payout_rejected', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: TICKET_BUTTON
    }
};

// ─── Rendering helpers ───────────────────────────────────────────────────────

/**
 * Fail fast if any situation is missing a base translation for a supported
 * language. Called at notification consumer startup.
 */
export function assertAgencyCatalogComplete(): void {
    for (const situation of Object.keys(AGENCY_NOTIFICATION_CATALOG) as AgencyNotificationType[]) {
        for (const lang of SUPPORTED_LANGUAGES) {
            if (!AGENCY_NOTIFICATION_CATALOG[situation].base[lang]) {
                throw createAppError(
                    ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
                    500,
                    `Missing '${lang}' base copy for agency notification situation '${situation}'`
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
export function renderAgencyInApp(
    situation: AgencyNotificationType,
    lang: Language,
    ctx: RenderContext
): { title: string; message: string } {
    const base = pickLang(AGENCY_NOTIFICATION_CATALOG[situation].base, lang)!;
    return {
        title: renderTemplate(base.subject, ctx),
        message: renderTemplate(base.body, ctx)
    };
}

/**
 * Render a secondary-channel's text in the given language, applying the
 * channel + language override over the language's base.
 */
export function renderAgencyChannelText(
    situation: AgencyNotificationType,
    channel: 'email' | 'telegram' | 'whatsapp',
    lang: Language,
    ctx: RenderContext
): ChannelText {
    const entry = AGENCY_NOTIFICATION_CATALOG[situation];
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
export function agencyWhatsAppTemplateName(situation: AgencyNotificationType): string {
    return AGENCY_NOTIFICATION_CATALOG[situation].whatsapp.template.name;
}

/** Render the ordered WhatsApp template body parameters for a situation. */
export function renderAgencyWhatsAppTemplateParams(
    situation: AgencyNotificationType,
    lang: Language,
    ctx: RenderContext
): string[] {
    const tpl = AGENCY_NOTIFICATION_CATALOG[situation].whatsapp.template;
    const inApp = renderAgencyInApp(situation, lang, ctx);
    const merged: RenderContext = { ...ctx, title: inApp.title, message: inApp.message };
    return tpl.bodyParams.map(param => renderTemplate(param, merged));
}

/**
 * Resolve a situation's action button into a localized label + absolute URL.
 * Returns null when the situation has no button or no base URL is configured.
 */
export function renderAgencyButton(
    situation: AgencyNotificationType,
    lang: Language,
    ctx: RenderContext,
    baseUrl: string | undefined
): { label: string; url: string; urlSuffix: string } | null {
    const button = AGENCY_NOTIFICATION_CATALOG[situation].button;
    if (!button) return null;

    const urlSuffix = renderTemplate(button.urlSuffix, ctx);
    const label = button.label[lang] ?? button.label[DEFAULT_LANGUAGE];
    const trimmedBase = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
    const url = trimmedBase ? `${trimmedBase}/${urlSuffix}` : urlSuffix;

    return { label, url, urlSuffix };
}
