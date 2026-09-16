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

const MANAGE_PLAN_LABEL: Record<Language, string> = {
    en: 'Manage plan',
    fr: 'Gérer le forfait',
    pt: 'Gerir plano',
    es: 'Gestionar plan',
    ar: 'إدارة الباقة'
};

const PLAN_BUTTON: ButtonDef = { type: 'url', label: MANAGE_PLAN_LABEL, urlSuffix: 'plans' };

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

const REVIEW_STOCK_CHANGE_LABEL: Record<Language, string> = {
    en: 'Review stock change',
    fr: 'Examiner la modification de stock',
    pt: 'Revisar alteração de stock',
    es: 'Revisar cambio de stock',
    ar: 'مراجعة تغيير المخزون'
};

/**
 * The stock-request inbox — NOT `settings/storage`, which is the media-file quota
 * screen. Two unrelated things called "storage" is why the aggregate types are
 * separate too (`stock_request` / `product` vs `storage`).
 */
const STOCK_REQUEST_BUTTON: ButtonDef = {
    type: 'url',
    label: REVIEW_STOCK_CHANGE_LABEL,
    urlSuffix: 'stock-requests/{{requestId}}'
};

const VIEW_PRODUCT_LABEL: Record<Language, string> = {
    en: 'View product',
    fr: 'Voir le produit',
    pt: 'Ver produto',
    es: 'Ver producto',
    ar: 'عرض المنتج'
};

const PRODUCT_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_PRODUCT_LABEL,
    urlSuffix: 'products/{{productId}}'
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

    // Five placeholders, and `bodyParams` lists ALL FIVE — the WhatsApp template
    // therefore says exactly what the in-app, email and Telegram copy says, with
    // no sentence rewritten for the approved version. That is deliberate: five of
    // the customer templates DO diverge from their own copy because a placeholder
    // was left out of `bodyParams`, and each needed a hand-written substitute body
    // and a warning in the doc (see `api-doc/notifications/whatsapp-templates.md`).
    //
    // `{{customerName}}` and `{{actionLine}}` are new, and widening this template
    // from 3 params to 5 is a Meta Business Manager operation — the template must
    // be edited and re-approved in all five languages before out-of-window sends
    // work again. Approved by the project owner; the doc carries the checklist.
    //
    // `{{actionLine}}` is a whole sentence passed as a parameter, composed in the
    // recipient's language by the handler. It carries the one thing a vendor most
    // needs from this message — whether a booking is waiting on them to accept it,
    // which depends on their booking mode and so cannot be static copy.
    'booking.created': {
        base: {
            en: { subject: 'New booking', body: 'New booking #{{bookingNumber}} — {{serviceName}} for {{customerName}} on {{startDate}}. {{actionLine}}' },
            fr: { subject: 'Nouvelle réservation', body: 'Nouvelle réservation n°{{bookingNumber}} — {{serviceName}} pour {{customerName}} le {{startDate}}. {{actionLine}}' },
            pt: { subject: 'Nova reserva', body: 'Nova reserva nº{{bookingNumber}} — {{serviceName}} para {{customerName}} em {{startDate}}. {{actionLine}}' },
            es: { subject: 'Nueva reserva', body: 'Nueva reserva n.º{{bookingNumber}} — {{serviceName}} para {{customerName}} el {{startDate}}. {{actionLine}}' },
            ar: { subject: 'حجز جديد', body: 'حجز جديد رقم {{bookingNumber}} — {{serviceName}} لصالح {{customerName}} في {{startDate}}. {{actionLine}}' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_booking_created',
                bodyParams: ['{{bookingNumber}}', '{{serviceName}}', '{{customerName}}', '{{startDate}}', '{{actionLine}}']
            }
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

    'plan.expiring': {
        base: {
            en: { subject: 'Your plan is expiring soon', body: 'Your {{planCode}} plan expires in {{daysUntilExpiry}} day(s), on {{expiresDate}}. Renew or upgrade to avoid interruption.' },
            fr: { subject: 'Votre forfait expire bientôt', body: 'Votre forfait {{planCode}} expire dans {{daysUntilExpiry}} jour(s), le {{expiresDate}}. Renouvelez ou améliorez-le pour éviter toute interruption.' },
            pt: { subject: 'O seu plano expira em breve', body: 'O seu plano {{planCode}} expira em {{daysUntilExpiry}} dia(s), a {{expiresDate}}. Renove ou faça upgrade para evitar interrupções.' },
            es: { subject: 'Tu plan expira pronto', body: 'Tu plan {{planCode}} expira en {{daysUntilExpiry}} día(s), el {{expiresDate}}. Renuévalo o mejóralo para evitar interrupciones.' },
            ar: { subject: 'باقتك على وشك الانتهاء', body: 'تنتهي باقة {{planCode}} خلال {{daysUntilExpiry}} يوم/أيام، بتاريخ {{expiresDate}}. جدّدها أو قم بترقيتها لتجنب الانقطاع.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_plan_expiring', bodyParams: ['{{planCode}}', '{{daysUntilExpiry}}', '{{expiresDate}}'] }
        },
        button: PLAN_BUTTON
    },

    'plan.expired': {
        base: {
            en: { subject: 'Your plan has expired', body: 'Your {{expiredPlanCode}} plan has expired. You are now on the {{newPlanCode}} plan. Renew or upgrade anytime from your plan settings.' },
            fr: { subject: 'Votre forfait a expiré', body: 'Votre forfait {{expiredPlanCode}} a expiré. Vous êtes maintenant sur le forfait {{newPlanCode}}. Renouvelez ou améliorez à tout moment depuis vos paramètres de forfait.' },
            pt: { subject: 'O seu plano expirou', body: 'O seu plano {{expiredPlanCode}} expirou. Está agora no plano {{newPlanCode}}. Renove ou faça upgrade a qualquer momento nas definições do plano.' },
            es: { subject: 'Tu plan ha expirado', body: 'Tu plan {{expiredPlanCode}} ha expirado. Ahora estás en el plan {{newPlanCode}}. Renueva o mejora en cualquier momento desde la configuración de tu plan.' },
            ar: { subject: 'انتهت صلاحية باقتك', body: 'انتهت صلاحية باقة {{expiredPlanCode}}. أنت الآن على باقة {{newPlanCode}}. يمكنك التجديد أو الترقية في أي وقت من إعدادات باقتك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_plan_expired', bodyParams: ['{{expiredPlanCode}}', '{{newPlanCode}}'] }
        },
        button: PLAN_BUTTON
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
    },

    /**
     * ⭐ **The gateway did not complete the transfer.** Published since the payout-execution
     * work and consumed by nothing on any of the three stacks until now.
     *
     * It is the only one of the four payout outcomes where silence freezes money. A
     * *rejected* payout returns the amount to the available balance; this leaves it held in
     * `requested_balance`, so the vendor cannot request again (one open request per owner) and
     * an administrator has to retry the send or reject it.
     *
     * Three rules the copy obeys, each load-bearing:
     *
     *   - ⚠ **Not terminal — must not read as "rejected".** The request is still open and the
     *     same send will be retried. `payout-request.service.ts` states it in its own ticket
     *     note: *"The funds remain held — retry the transfer or reject the request to return
     *     them."*
     *   - ⚠ **Do not invite a second request.** It answers 409, which the vendor reads as the
     *     app breaking on top of their money being stuck.
     *   - ⚠ **The gateway's `reason` is not relayed.** Provider-sourced text that can name the
     *     provider and its codes; it is on the ticket for whoever retries.
     */
    'payout.transfer_failed': {
        base: {
            en: { subject: 'Problem paying out {{currency}} {{amountFormatted}}', body: 'We hit a problem sending your {{currency}} {{amountFormatted}}. The money is safe and still reserved for this payout — our team is on it and will retry. Nothing is needed from you; see Tickets for progress.' },
            fr: { subject: 'Problème de versement de {{currency}} {{amountFormatted}}', body: 'Nous avons rencontré un problème en envoyant vos {{currency}} {{amountFormatted}}. L\'argent est en sécurité et toujours réservé pour ce paiement — notre équipe s\'en occupe et fera une nouvelle tentative. Rien n\'est requis de votre part ; suivez l\'avancement dans Tickets.' },
            pt: { subject: 'Problema ao pagar {{currency}} {{amountFormatted}}', body: 'Tivemos um problema ao enviar os seus {{currency}} {{amountFormatted}}. O dinheiro está seguro e continua reservado para este pagamento — a nossa equipa está a tratar disso e vai tentar de novo. Não precisa de fazer nada; acompanhe em Chamados.' },
            es: { subject: 'Problema al pagar {{currency}} {{amountFormatted}}', body: 'Tuvimos un problema al enviar tus {{currency}} {{amountFormatted}}. El dinero está seguro y sigue reservado para este pago — nuestro equipo se está ocupando y lo reintentará. No necesitas hacer nada; consulta el progreso en Tickets.' },
            ar: { subject: 'مشكلة في تحويل {{currency}} {{amountFormatted}}', body: 'واجهنا مشكلة في إرسال مبلغ {{currency}} {{amountFormatted}}. المال آمن ولا يزال محفوظًا لهذا التحويل — فريقنا يعمل على ذلك وسيعيد المحاولة. لا حاجة لأي إجراء منك؛ تابع التقدم ضمن التذاكر.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_payout_transfer_failed', bodyParams: ['{{currency}}', '{{amountFormatted}}'] }
        },
        button: { type: 'url', label: VIEW_TICKET_LABEL, urlSuffix: 'tickets/{{ticketId}}' }
    },

    // A delivery agency declined a shipment. The specific reason + note live on
    // the order view (like payout.rejected points to Tickets), so this copy just
    // alerts + deep-links — no need to localize the fixed reason codes.
    'shipment.rejected': {
        base: {
            en: { subject: 'Delivery declined', body: '{{agencyName}} declined delivery of order #{{orderNumber}}. Open the order to assign another delivery agency.' },
            fr: { subject: 'Livraison refusée', body: '{{agencyName}} a refusé la livraison de la commande n°{{orderNumber}}. Ouvrez la commande pour choisir une autre agence de livraison.' },
            pt: { subject: 'Entrega recusada', body: '{{agencyName}} recusou a entrega do pedido nº{{orderNumber}}. Abra o pedido para atribuir outra agência de entrega.' },
            es: { subject: 'Entrega rechazada', body: '{{agencyName}} rechazó la entrega del pedido n.º{{orderNumber}}. Abre el pedido para asignar otra agencia de entrega.' },
            ar: { subject: 'تم رفض التوصيل', body: 'رفضت {{agencyName}} توصيل الطلب رقم {{orderNumber}}. افتح الطلب لتعيين وكالة توصيل أخرى.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'vendor_shipment_rejected', bodyParams: ['{{agencyName}}', '{{orderNumber}}'] }
        },
        button: { type: 'url', label: VIEW_ORDER_LABEL, urlSuffix: 'orders/{{orderId}}' }
    },

    // ─── Agency-warehoused stock ─────────────────────────────────────────────
    // On a SKU an agency warehouses, `variant.stock` moves only with both
    // signatures. Every body names both the old and the new quantity: the decision
    // is "is 90 right, or is 120?", and copy carrying only the new figure makes the
    // vendor go and look up the old one before it can answer.
    'storage.stock_request.received': {
        base: {
            en: { subject: 'Stock change to approve', body: '{{agencyName}} counted {{requestedQuantity}} of {{productTitle}} ({{sku}}) in their warehouse, against the {{quantityBefore}} on record. Approve or reject the change.' },
            fr: { subject: 'Modification de stock à approuver', body: '{{agencyName}} a compté {{requestedQuantity}} unités de {{productTitle}} ({{sku}}) dans son entrepôt, contre {{quantityBefore}} enregistrées. Approuvez ou refusez la modification.' },
            pt: { subject: 'Alteração de stock para aprovar', body: '{{agencyName}} contou {{requestedQuantity}} de {{productTitle}} ({{sku}}) no armazém, contra as {{quantityBefore}} registadas. Aprove ou recuse a alteração.' },
            es: { subject: 'Cambio de stock para aprobar', body: '{{agencyName}} contó {{requestedQuantity}} de {{productTitle}} ({{sku}}) en su almacén, frente a las {{quantityBefore}} registradas. Aprueba o rechaza el cambio.' },
            ar: { subject: 'تغيير في المخزون بحاجة إلى موافقة', body: 'أحصى {{agencyName}} عدد {{requestedQuantity}} من {{productTitle}} ({{sku}}) في المستودع، مقابل {{quantityBefore}} المسجّلة. وافق على التغيير أو ارفضه.' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_storage_stock_request_received',
                bodyParams: ['{{agencyName}}', '{{requestedQuantity}}', '{{productTitle}}', '{{sku}}', '{{quantityBefore}}']
            }
        },
        button: STOCK_REQUEST_BUTTON
    },

    'storage.stock_request.approved': {
        base: {
            en: { subject: 'Stock change approved', body: '{{agencyName}} approved your stock change for {{productTitle}} ({{sku}}). It now reads {{requestedQuantity}}.' },
            fr: { subject: 'Modification de stock approuvée', body: '{{agencyName}} a approuvé votre modification de stock pour {{productTitle}} ({{sku}}). Le stock est maintenant de {{requestedQuantity}}.' },
            pt: { subject: 'Alteração de stock aprovada', body: '{{agencyName}} aprovou a sua alteração de stock para {{productTitle}} ({{sku}}). Passou a ser {{requestedQuantity}}.' },
            es: { subject: 'Cambio de stock aprobado', body: '{{agencyName}} aprobó tu cambio de stock para {{productTitle}} ({{sku}}). Ahora es {{requestedQuantity}}.' },
            ar: { subject: 'تمت الموافقة على تغيير المخزون', body: 'وافق {{agencyName}} على تغيير المخزون الذي طلبته لـ {{productTitle}} ({{sku}}). أصبح الآن {{requestedQuantity}}.' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_storage_stock_request_approved',
                bodyParams: ['{{agencyName}}', '{{productTitle}}', '{{sku}}', '{{requestedQuantity}}']
            }
        },
        button: STOCK_REQUEST_BUTTON
    },

    'storage.stock_request.rejected': {
        base: {
            en: { subject: 'Stock change rejected', body: '{{agencyName}} rejected your stock change for {{productTitle}} ({{sku}}). It stays at {{quantityBefore}}.' },
            fr: { subject: 'Modification de stock refusée', body: '{{agencyName}} a refusé votre modification de stock pour {{productTitle}} ({{sku}}). Le stock reste à {{quantityBefore}}.' },
            pt: { subject: 'Alteração de stock recusada', body: '{{agencyName}} recusou a sua alteração de stock para {{productTitle}} ({{sku}}). Mantém-se em {{quantityBefore}}.' },
            es: { subject: 'Cambio de stock rechazado', body: '{{agencyName}} rechazó tu cambio de stock para {{productTitle}} ({{sku}}). Se mantiene en {{quantityBefore}}.' },
            ar: { subject: 'تم رفض تغيير المخزون', body: 'رفض {{agencyName}} تغيير المخزون الذي طلبته لـ {{productTitle}} ({{sku}}). سيبقى عند {{quantityBefore}}.' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_storage_stock_request_rejected',
                bodyParams: ['{{agencyName}}', '{{productTitle}}', '{{sku}}', '{{quantityBefore}}']
            }
        },
        button: STOCK_REQUEST_BUTTON
    },

    // The next three are the agency acting alone on a product it warehouses. There
    // is nothing for the vendor to approve — where the goods sit and whether the rent
    // was paid are the agency's own business — but the vendor must not learn about a
    // suspension by noticing the product missing from their storefront.
    'storage.depot_changed': {
        base: {
            en: { subject: 'Pickup location changed', body: '{{agencyName}} moved {{productTitle}} to a different warehouse{{locationSuffix}}. Collection now happens from there.' },
            fr: { subject: 'Lieu de retrait modifié', body: '{{agencyName}} a déplacé {{productTitle}} vers un autre entrepôt{{locationSuffix}}. Le retrait s\'y fait désormais.' },
            pt: { subject: 'Local de recolha alterado', body: '{{agencyName}} moveu {{productTitle}} para outro armazém{{locationSuffix}}. A recolha passa a ser feita aí.' },
            es: { subject: 'Lugar de recogida cambiado', body: '{{agencyName}} movió {{productTitle}} a otro almacén{{locationSuffix}}. La recogida se hace ahora desde allí.' },
            ar: { subject: 'تم تغيير مكان الاستلام', body: 'نقل {{agencyName}} المنتج {{productTitle}} إلى مستودع آخر{{locationSuffix}}. سيتم الاستلام من هناك الآن.' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_storage_depot_changed',
                bodyParams: ['{{agencyName}}', '{{productTitle}}', '{{locationSuffix}}']
            }
        },
        button: PRODUCT_BUTTON
    },

    // Says WHY (the agency's note) rather than leaving the vendor to guess, and says
    // plainly that customers can no longer buy it — that is the consequence they will
    // otherwise discover from their sales figures.
    'storage.product_suspended': {
        base: {
            en: { subject: 'Product suspended by your storage agency', body: '{{agencyName}} suspended {{productTitle}}, so customers can no longer buy it.{{noteSuffix}} Contact them to resolve it.' },
            fr: { subject: 'Produit suspendu par votre agence de stockage', body: '{{agencyName}} a suspendu {{productTitle}} ; les clients ne peuvent plus l\'acheter.{{noteSuffix}} Contactez l\'agence pour régler la situation.' },
            pt: { subject: 'Produto suspenso pela sua agência de armazenamento', body: '{{agencyName}} suspendeu {{productTitle}}, pelo que os clientes já não o podem comprar.{{noteSuffix}} Contacte a agência para resolver.' },
            es: { subject: 'Producto suspendido por tu agencia de almacenamiento', body: '{{agencyName}} suspendió {{productTitle}}, por lo que los clientes ya no pueden comprarlo.{{noteSuffix}} Contáctala para resolverlo.' },
            ar: { subject: 'تم تعليق المنتج من قبل وكالة التخزين', body: 'علّق {{agencyName}} المنتج {{productTitle}}، لذا لم يعد بإمكان العملاء شراؤه.{{noteSuffix}} تواصل معهم لحل المسألة.' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_storage_product_suspended',
                bodyParams: ['{{agencyName}}', '{{productTitle}}', '{{noteSuffix}}']
            }
        },
        button: PRODUCT_BUTTON
    },

    'storage.product_unsuspended': {
        base: {
            en: { subject: 'Product back on sale', body: '{{agencyName}} lifted the suspension on {{productTitle}}. It is available to customers again.' },
            fr: { subject: 'Produit de nouveau en vente', body: '{{agencyName}} a levé la suspension de {{productTitle}}. Il est de nouveau disponible pour les clients.' },
            pt: { subject: 'Produto de novo à venda', body: '{{agencyName}} levantou a suspensão de {{productTitle}}. Está de novo disponível para os clientes.' },
            es: { subject: 'Producto de nuevo en venta', body: '{{agencyName}} levantó la suspensión de {{productTitle}}. Vuelve a estar disponible para los clientes.' },
            ar: { subject: 'المنتج معروض للبيع مرة أخرى', body: 'رفع {{agencyName}} التعليق عن {{productTitle}}. أصبح متاحًا للعملاء مرة أخرى.' }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'vendor_storage_product_unsuspended',
                bodyParams: ['{{agencyName}}', '{{productTitle}}']
            }
        },
        button: PRODUCT_BUTTON
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
