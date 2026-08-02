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

const VIEW_SHIPMENT_LABEL: Record<Language, string> = {
    en: 'View shipment',
    fr: 'Voir l\'expédition',
    pt: 'Ver remessa',
    es: 'Ver envío',
    ar: 'عرض الشحنة'
};

const CONNECTION_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_CONNECTION_LABEL,
    urlSuffix: 'vendor-connections/{{connectionId}}'
};

const VIEW_AGENT_REQUEST_LABEL: Record<Language, string> = {
    en: 'View request',
    fr: 'Voir la demande',
    pt: 'Ver pedido',
    es: 'Ver solicitud',
    ar: 'عرض الطلب'
};

/** Points at the agent roster, not at vendor-connections — a different relationship. */
const AGENT_CONTRACT_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_AGENT_REQUEST_LABEL,
    urlSuffix: 'agents/{{contractId}}'
};

const TICKET_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_TICKET_LABEL,
    urlSuffix: 'tickets/{{ticketId}}'
};

const SHIPMENT_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_SHIPMENT_LABEL,
    urlSuffix: 'shipments/{{shipmentId}}'
};

const REVIEW_DEPOSIT_LABEL: Record<Language, string> = {
    en: 'Review deposit',
    fr: 'Examiner le dépôt',
    pt: 'Rever depósito',
    es: 'Revisar depósito',
    ar: 'مراجعة الإيداع'
};

const DEPOSIT_BUTTON: ButtonDef = {
    type: 'url',
    label: REVIEW_DEPOSIT_LABEL,
    urlSuffix: 'cod/deposits/{{depositId}}'
};

const MANAGE_PLAN_LABEL: Record<Language, string> = {
    en: 'Manage plan',
    fr: 'Gérer le forfait',
    pt: 'Gerir plano',
    es: 'Gestionar plan',
    ar: 'إدارة الباقة'
};

const PLAN_BUTTON: ButtonDef = {
    type: 'url',
    label: MANAGE_PLAN_LABEL,
    urlSuffix: 'plans'
};

const MANAGE_STORAGE_LABEL: Record<Language, string> = {
    en: 'Manage storage',
    fr: 'Gérer le stockage',
    pt: 'Gerir armazenamento',
    es: 'Gestionar almacenamiento',
    ar: 'إدارة التخزين'
};

const STORAGE_BUTTON: ButtonDef = {
    type: 'url',
    label: MANAGE_STORAGE_LABEL,
    urlSuffix: 'settings/storage'
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

    'agent_contract.request_received': {
        base: {
            en: { subject: 'New agent application', body: '{{agentName}} applied to deliver for you. Review the application to approve or decline it.' },
            fr: { subject: 'Nouvelle candidature d\'agent', body: '{{agentName}} a postulé pour livrer pour vous. Consultez la candidature pour l\'approuver ou la refuser.' },
            pt: { subject: 'Nova candidatura de agente', body: '{{agentName}} candidatou-se para fazer entregas para si. Veja a candidatura para a aprovar ou recusar.' },
            es: { subject: 'Nueva solicitud de agente', body: '{{agentName}} se postuló para hacer entregas para ti. Revisa la solicitud para aprobarla o rechazarla.' },
            ar: { subject: 'طلب انضمام جديد من وكيل', body: 'تقدّم {{agentName}} للتوصيل لصالحك. راجع الطلب للموافقة عليه أو رفضه.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_agent_contract_request_received', bodyParams: ['{{agentName}}'] }
        },
        button: AGENT_CONTRACT_BUTTON
    },

    'agent_contract.approved': {
        base: {
            en: { subject: 'Agent accepted', body: '{{agentName}} accepted your request. They can now receive delivery offers from you.' },
            fr: { subject: 'Agent accepté', body: '{{agentName}} a accepté votre demande. Vous pouvez désormais lui envoyer des offres de livraison.' },
            pt: { subject: 'Agente aceitou', body: '{{agentName}} aceitou o seu pedido. Já pode receber as suas ofertas de entrega.' },
            es: { subject: 'Agente aceptó', body: '{{agentName}} aceptó tu solicitud. Ya puede recibir tus ofertas de entrega.' },
            ar: { subject: 'قبل الوكيل الطلب', body: 'قبلت {{agentName}} طلبك. يمكنها الآن تلقي عروض التوصيل منك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_agent_contract_approved', bodyParams: ['{{agentName}}'] }
        },
        button: AGENT_CONTRACT_BUTTON
    },

    'agent_contract.rejected': {
        base: {
            en: { subject: 'Agent declined', body: '{{agentName}} declined your request.' },
            fr: { subject: 'Agent a refusé', body: '{{agentName}} a refusé votre demande.' },
            pt: { subject: 'Agente recusou', body: '{{agentName}} recusou o seu pedido.' },
            es: { subject: 'Agente rechazó', body: '{{agentName}} rechazó tu solicitud.' },
            ar: { subject: 'رفض الوكيل الطلب', body: 'رفضت {{agentName}} طلبك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_agent_contract_rejected', bodyParams: ['{{agentName}}'] }
        },
        button: AGENT_CONTRACT_BUTTON
    },

    'shipment.assigned': {
        base: {
            en: { subject: 'New shipment assigned', body: 'Order #{{orderNumber}} was dispatched to you — {{itemCount}} item(s) to fulfill.' },
            fr: { subject: 'Nouvelle expédition assignée', body: 'La commande n°{{orderNumber}} vous a été confiée — {{itemCount}} article(s) à traiter.' },
            pt: { subject: 'Nova remessa atribuída', body: 'O pedido nº{{orderNumber}} foi despachado para você — {{itemCount}} item(ns) para cumprir.' },
            es: { subject: 'Nuevo envío asignado', body: 'El pedido n.º{{orderNumber}} fue despachado a ti — {{itemCount}} artículo(s) por cumplir.' },
            ar: { subject: 'تم تعيين شحنة جديدة', body: 'تم إرسال الطلب رقم {{orderNumber}} إليك — {{itemCount}} عنصر (عناصر) للتنفيذ.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_assigned', bodyParams: ['{{orderNumber}}', '{{itemCount}}'] }
        },
        button: SHIPMENT_BUTTON
    },

    'shipment.offer.accepted': {
        base: {
            en: { subject: 'Agent accepted the delivery', body: '{{agentName}} accepted the delivery for order #{{orderNumber}}. They are on the way.' },
            fr: { subject: 'Le livreur a accepté la livraison', body: '{{agentName}} a accepté la livraison de la commande n°{{orderNumber}}. Il est en route.' },
            pt: { subject: 'O agente aceitou a entrega', body: '{{agentName}} aceitou a entrega do pedido nº{{orderNumber}}. Está a caminho.' },
            es: { subject: 'El agente aceptó la entrega', body: '{{agentName}} aceptó la entrega del pedido n.º{{orderNumber}}. Va en camino.' },
            ar: { subject: 'قبل المندوب التوصيل', body: 'قبل {{agentName}} توصيل الطلب رقم {{orderNumber}}. إنه في الطريق.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_offer_accepted', bodyParams: ['{{agentName}}', '{{orderNumber}}'] }
        },
        button: SHIPMENT_BUTTON
    },

    'shipment.assignment.unfilled': {
        base: {
            en: { subject: 'No agent accepted — assign manually', body: 'No agent took the delivery for order #{{orderNumber}}. Assign an agent manually to keep it moving.' },
            fr: { subject: 'Aucun livreur — à assigner manuellement', body: 'Aucun livreur n\'a pris la livraison de la commande n°{{orderNumber}}. Assignez un livreur manuellement pour la faire avancer.' },
            pt: { subject: 'Nenhum agente aceitou — atribua manualmente', body: 'Nenhum agente aceitou a entrega do pedido nº{{orderNumber}}. Atribua um agente manualmente para continuar.' },
            es: { subject: 'Ningún agente aceptó — asigna manualmente', body: 'Ningún agente aceptó la entrega del pedido n.º{{orderNumber}}. Asigna un agente manualmente para continuar.' },
            ar: { subject: 'لم يقبل أي مندوب — عيّن يدويًا', body: 'لم يقبل أي مندوب توصيل الطلب رقم {{orderNumber}}. عيّن مندوبًا يدويًا لمواصلة العملية.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_assignment_unfilled', bodyParams: ['{{orderNumber}}'] }
        },
        button: SHIPMENT_BUTTON
    },

    // ─── Agent-driven shipment progress (POST /api/agent/shipments/:id/status) ──
    // `{{reasonSuffix}}` is the agent's own words, pre-formatted by the handler
    // as ' — <note or reason>' or ''. It is raw agent text and is deliberately
    // NOT localized, which is why it is appended after a dash rather than woven
    // into the sentence; the structured record is on the shipment's
    // `deliveryFailures`, reachable through the button.

    'shipment.agent.picked_up': {
        base: {
            en: { subject: 'Parcel picked up', body: '{{agentName}} picked up order #{{orderNumber}}. It is on its way.' },
            fr: { subject: 'Colis récupéré', body: '{{agentName}} a récupéré la commande n°{{orderNumber}}. Elle est en route.' },
            pt: { subject: 'Encomenda recolhida', body: '{{agentName}} recolheu o pedido nº{{orderNumber}}. Está a caminho.' },
            es: { subject: 'Paquete recogido', body: '{{agentName}} recogió el pedido n.º{{orderNumber}}. Va en camino.' },
            ar: { subject: 'تم استلام الطرد', body: 'استلم {{agentName}} الطلب رقم {{orderNumber}}. إنه في الطريق.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_agent_picked_up', bodyParams: ['{{agentName}}', '{{orderNumber}}'] }
        },
        button: SHIPMENT_BUTTON
    },

    'shipment.agent.delivered': {
        base: {
            en: { subject: 'Agent marked the delivery complete', body: '{{agentName}} delivered order #{{orderNumber}}. Waiting on the customer\'s confirmation.' },
            fr: { subject: 'Le livreur a marqué la livraison comme faite', body: '{{agentName}} a livré la commande n°{{orderNumber}}. En attente de la confirmation du client.' },
            pt: { subject: 'O agente marcou a entrega como concluída', body: '{{agentName}} entregou o pedido nº{{orderNumber}}. A aguardar a confirmação do cliente.' },
            es: { subject: 'El agente marcó la entrega como completada', body: '{{agentName}} entregó el pedido n.º{{orderNumber}}. Esperando la confirmación del cliente.' },
            ar: { subject: 'سجّل المندوب إتمام التوصيل', body: 'قام {{agentName}} بتوصيل الطلب رقم {{orderNumber}}. في انتظار تأكيد العميل.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_agent_delivered', bodyParams: ['{{agentName}}', '{{orderNumber}}'] }
        },
        button: SHIPMENT_BUTTON
    },

    'shipment.agent.failed': {
        base: {
            en: { subject: 'Delivery attempt failed', body: '{{agentName}} could not deliver order #{{orderNumber}}{{reasonSuffix}}. The parcel is still with them — they can retry or return it.' },
            fr: { subject: 'Échec de la tentative de livraison', body: '{{agentName}} n\'a pas pu livrer la commande n°{{orderNumber}}{{reasonSuffix}}. Le colis est toujours avec lui — il peut réessayer ou le retourner.' },
            pt: { subject: 'Tentativa de entrega falhou', body: '{{agentName}} não conseguiu entregar o pedido nº{{orderNumber}}{{reasonSuffix}}. A encomenda ainda está com ele — pode tentar de novo ou devolvê-la.' },
            es: { subject: 'Intento de entrega fallido', body: '{{agentName}} no pudo entregar el pedido n.º{{orderNumber}}{{reasonSuffix}}. El paquete sigue con él — puede reintentar o devolverlo.' },
            ar: { subject: 'فشلت محاولة التوصيل', body: 'لم يتمكن {{agentName}} من توصيل الطلب رقم {{orderNumber}}{{reasonSuffix}}. الطرد ما زال معه — يمكنه إعادة المحاولة أو إرجاعه.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_agent_failed', bodyParams: ['{{agentName}}', '{{orderNumber}}'] }
        },
        button: SHIPMENT_BUTTON
    },

    'shipment.agent.returned': {
        base: {
            en: { subject: 'Parcel returned', body: '{{agentName}} returned order #{{orderNumber}}{{reasonSuffix}}. The delivery run is over.' },
            fr: { subject: 'Colis retourné', body: '{{agentName}} a retourné la commande n°{{orderNumber}}{{reasonSuffix}}. La tournée est terminée.' },
            pt: { subject: 'Encomenda devolvida', body: '{{agentName}} devolveu o pedido nº{{orderNumber}}{{reasonSuffix}}. A entrega terminou.' },
            es: { subject: 'Paquete devuelto', body: '{{agentName}} devolvió el pedido n.º{{orderNumber}}{{reasonSuffix}}. El reparto ha terminado.' },
            ar: { subject: 'تم إرجاع الطرد', body: 'أرجع {{agentName}} الطلب رقم {{orderNumber}}{{reasonSuffix}}. انتهت رحلة التوصيل.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_agent_returned', bodyParams: ['{{agentName}}', '{{orderNumber}}'] }
        },
        button: SHIPMENT_BUTTON
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
    },

    // An agent claims they handed cash over. The deadline is in the copy on
    // purpose: ignoring this freezes the agency's reserve releases, and an
    // agency that does not know that will not act.
    'cod.deposit.declared': {
        base: {
            en: {
                subject: 'Deposit awaiting your confirmation',
                body: '{{agentName}} declared a cash deposit of {{currency}} {{amountFormatted}}. Confirm or reject it within {{deadlineDays}} days — unanswered declarations freeze your reserve releases.'
            },
            fr: {
                subject: 'Dépôt en attente de votre confirmation',
                body: '{{agentName}} a déclaré un dépôt en espèces de {{currency}} {{amountFormatted}}. Confirmez-le ou refusez-le sous {{deadlineDays}} jours — les déclarations sans réponse gèlent vos libérations de réserve.'
            },
            pt: {
                subject: 'Depósito a aguardar a sua confirmação',
                body: '{{agentName}} declarou um depósito em dinheiro de {{currency}} {{amountFormatted}}. Confirme ou rejeite dentro de {{deadlineDays}} dias — declarações sem resposta congelam as libertações da sua reserva.'
            },
            es: {
                subject: 'Depósito pendiente de tu confirmación',
                body: '{{agentName}} declaró un depósito en efectivo de {{currency}} {{amountFormatted}}. Confírmalo o recházalo en {{deadlineDays}} días — las declaraciones sin responder congelan la liberación de tu reserva.'
            },
            ar: {
                subject: 'إيداع في انتظار تأكيدك',
                body: 'أعلن {{agentName}} عن إيداع نقدي بقيمة {{currency}} {{amountFormatted}}. قم بتأكيده أو رفضه خلال {{deadlineDays}} أيام — الإعلانات التي لا يتم الرد عليها تجمد إفراجات الاحتياطي الخاص بك.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agency_cod_deposit_declared',
                bodyParams: ['{{agentName}}', '{{currency}}', '{{amountFormatted}}', '{{deadlineDays}}']
            }
        },
        button: DEPOSIT_BUTTON
    },

    // The agent bypassed the agency and paid the platform. Nothing for them to
    // do — but their liability just moved without them touching it, so silence
    // would look like a bookkeeping error on their side.
    'cod.deposit.direct_to_platform': {
        base: {
            en: {
                subject: 'Agent paid the platform directly',
                body: '{{agentName}} paid {{currency}} {{amountFormatted}} of collected cash straight to the platform. Your liability has been reduced by the same amount and the collections it covers are settled — nothing is owed to you for it.'
            },
            fr: {
                subject: 'Un agent a payé directement la plateforme',
                body: '{{agentName}} a versé {{currency}} {{amountFormatted}} d\'espèces collectées directement à la plateforme. Votre passif a été réduit d\'autant et les collectes couvertes sont réglées — rien ne vous est dû à ce titre.'
            },
            pt: {
                subject: 'Agente pagou diretamente à plataforma',
                body: '{{agentName}} pagou {{currency}} {{amountFormatted}} de dinheiro cobrado diretamente à plataforma. A sua responsabilidade foi reduzida no mesmo valor e as cobranças que cobre estão liquidadas — nada lhe é devido por isso.'
            },
            es: {
                subject: 'Un agente pagó directamente a la plataforma',
                body: '{{agentName}} pagó {{currency}} {{amountFormatted}} del efectivo cobrado directamente a la plataforma. Tu pasivo se ha reducido en la misma cantidad y las cobranzas que cubre están liquidadas — no se te debe nada por ello.'
            },
            ar: {
                subject: 'دفع وكيل للمنصة مباشرة',
                body: 'دفع {{agentName}} مبلغ {{currency}} {{amountFormatted}} من النقد المحصل مباشرة إلى المنصة. تم تخفيض التزامك بنفس المبلغ وتمت تسوية التحصيلات التي يغطيها — لا شيء مستحق لك مقابل ذلك.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agency_cod_deposit_direct_to_platform',
                bodyParams: ['{{agentName}}', '{{currency}}', '{{amountFormatted}}']
            }
        },
        button: DEPOSIT_BUTTON
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
            template: { name: 'agency_plan_expiring', bodyParams: ['{{planCode}}', '{{daysUntilExpiry}}', '{{expiresDate}}'] }
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
            template: { name: 'agency_plan_expired', bodyParams: ['{{expiredPlanCode}}', '{{newPlanCode}}'] }
        },
        button: PLAN_BUTTON
    },

    // Soft cap: deliveries are NOT blocked, so the copy reassures while nudging an
    // upgrade — never implies work stopped.
    'shipment.cap.exceeded': {
        base: {
            en: { subject: 'Shipment limit reached', body: 'You have {{current}} active shipments, at or above your {{planCode}} plan limit of {{cap}}. Deliveries keep flowing — upgrade for more headroom.' },
            fr: { subject: 'Limite d\'expéditions atteinte', body: 'Vous avez {{current}} expéditions actives, au niveau ou au-dessus de la limite de {{cap}} de votre forfait {{planCode}}. Les livraisons continuent — améliorez votre forfait pour plus de marge.' },
            pt: { subject: 'Limite de remessas atingido', body: 'Tem {{current}} remessas ativas, no limite ou acima do limite de {{cap}} do seu plano {{planCode}}. As entregas continuam — faça upgrade para mais margem.' },
            es: { subject: 'Límite de envíos alcanzado', body: 'Tienes {{current}} envíos activos, en o por encima del límite de {{cap}} de tu plan {{planCode}}. Las entregas continúan — mejora tu plan para más margen.' },
            ar: { subject: 'تم بلوغ حد الشحنات', body: 'لديك {{current}} شحنة نشطة، عند حد باقة {{planCode}} البالغ {{cap}} أو أعلى منه. تستمر عمليات التوصيل — قم بالترقية لمزيد من السعة.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_shipment_cap_exceeded', bodyParams: ['{{current}}', '{{planCode}}', '{{cap}}'] }
        },
        button: PLAN_BUTTON
    },

    // Media storage crossed a usage threshold (80/90/100%). Uploads are only
    // blocked at 100% — below that this is a heads-up to free space or upgrade.
    'storage.alert': {
        base: {
            en: { subject: 'Storage almost full', body: 'Your media storage is at {{percentUsed}}% ({{usageFormatted}} of {{limitFormatted}}). Free up space or upgrade your plan.' },
            fr: { subject: 'Stockage presque plein', body: 'Votre stockage multimédia est à {{percentUsed}}% ({{usageFormatted}} sur {{limitFormatted}}). Libérez de l\'espace ou améliorez votre forfait.' },
            pt: { subject: 'Armazenamento quase cheio', body: 'O seu armazenamento de mídia está em {{percentUsed}}% ({{usageFormatted}} de {{limitFormatted}}). Libere espaço ou faça upgrade do seu plano.' },
            es: { subject: 'Almacenamiento casi lleno', body: 'Tu almacenamiento multimedia está al {{percentUsed}}% ({{usageFormatted}} de {{limitFormatted}}). Libera espacio o mejora tu plan.' },
            ar: { subject: 'مساحة التخزين ممتلئة تقريبًا', body: 'مساحة تخزين الوسائط لديك عند {{percentUsed}}% ({{usageFormatted}} من {{limitFormatted}}). حرّر مساحة أو قم بترقية باقتك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agency_storage_alert', bodyParams: ['{{percentUsed}}', '{{usageFormatted}}', '{{limitFormatted}}'] }
        },
        button: STORAGE_BUTTON
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
