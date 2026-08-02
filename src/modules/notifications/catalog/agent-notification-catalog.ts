import { AgentNotificationType } from '../models/agent-notification.model';
import { renderTemplate, RenderContext } from './message-renderer';
import { Language, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from './notification-i18n';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ChannelText, SituationMessages, ButtonDef } from './notification-catalog';

/**
 * Agent Notification Message Catalog (localized)
 *
 * Agent-facing counterpart to agency-notification-catalog.ts. Same shape and
 * rendering rules (see notification-catalog.ts's doc comment) — copy here is
 * written from the AGENT's point of view, and every situation is about THEIR
 * cash liability moving.
 *
 * The copy is deliberately specific about amounts and who acted, and every
 * message ends by telling the agent what to do if it looks wrong. These are the
 * only messages that let an agent notice an agency recording less cash than they
 * handed over, so a vague "your deposits were updated" would defeat the point of
 * having them.
 *
 * Translations are maintained for: en, fr, pt, es, ar.
 */

// ─── Shared button label sets ────────────────────────────────────────────────

const VIEW_DEPOSIT_LABEL: Record<Language, string> = {
    en: 'View deposit',
    fr: 'Voir le dépôt',
    pt: 'Ver depósito',
    es: 'Ver depósito',
    ar: 'عرض الإيداع'
};

const DEPOSIT_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_DEPOSIT_LABEL,
    urlSuffix: 'cod/deposits/{{depositId}}'
};

const VIEW_OFFER_LABEL: Record<Language, string> = {
    en: 'Review offer',
    fr: 'Voir l\'offre',
    pt: 'Ver oferta',
    es: 'Ver oferta',
    ar: 'مراجعة العرض'
};

const OFFER_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_OFFER_LABEL,
    urlSuffix: 'offers/{{offerId}}'
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

const VIEW_CONTRACT_LABEL: Record<Language, string> = {
    en: 'View request',
    fr: 'Voir la demande',
    pt: 'Ver pedido',
    es: 'Ver solicitud',
    ar: 'عرض الطلب'
};

const CONTRACT_BUTTON: ButtonDef = {
    type: 'url',
    label: VIEW_CONTRACT_LABEL,
    urlSuffix: 'memberships/{{contractId}}'
};

const STORAGE_BUTTON: ButtonDef = {
    type: 'url',
    label: MANAGE_STORAGE_LABEL,
    urlSuffix: 'settings/storage'
};

/**
 * Who answered the deposit, when it was the platform rather than an agency.
 *
 * Lives here rather than in the handler because it is copy: it is substituted
 * into `{{confirmedByName}}` alongside real agency names, so it has to be
 * localized the same way everything else in this file is.
 */
export const PLATFORM_ACTOR_LABEL: Record<Language, string> = {
    en: 'the platform',
    fr: 'la plateforme',
    pt: 'a plataforma',
    es: 'la plataforma',
    ar: 'المنصة'
};

// ─── Catalog ─────────────────────────────────────────────────────────────────

// NOTE: the WhatsApp template names below (agent_*) still need to be created and
// approved in Meta Business Manager before WhatsApp delivery will actually
// succeed for these situations — in-app/email/telegram/push work today
// regardless. Same bootstrapping step every new situation needs.
export const AGENT_NOTIFICATION_CATALOG: Record<AgentNotificationType, SituationMessages> = {
    // The agency recorded a hand-over the agent never declared. THE detection
    // message: "check it" is the whole reason this situation exists.
    'cod.deposit.recorded': {
        base: {
            en: {
                subject: 'Deposit recorded by {{agencyName}}',
                body: '{{agencyName}} recorded a cash deposit of {{currency}} {{amountFormatted}} from you. Your balance has been reduced by that amount. If this is not what you handed over, report it now.'
            },
            fr: {
                subject: 'Dépôt enregistré par {{agencyName}}',
                body: '{{agencyName}} a enregistré un dépôt en espèces de {{currency}} {{amountFormatted}} de votre part. Votre solde a été réduit d\'autant. Si ce n\'est pas ce que vous avez remis, signalez-le maintenant.'
            },
            pt: {
                subject: 'Depósito registado por {{agencyName}}',
                body: '{{agencyName}} registou um depósito em dinheiro de {{currency}} {{amountFormatted}} da sua parte. O seu saldo foi reduzido nesse valor. Se não foi isto que entregou, comunique agora.'
            },
            es: {
                subject: 'Depósito registrado por {{agencyName}}',
                body: '{{agencyName}} registró un depósito en efectivo de {{currency}} {{amountFormatted}} de tu parte. Tu saldo se ha reducido en esa cantidad. Si no es lo que entregaste, repórtalo ahora.'
            },
            ar: {
                subject: 'تم تسجيل إيداع بواسطة {{agencyName}}',
                body: 'سجلت {{agencyName}} إيداعًا نقديًا بقيمة {{currency}} {{amountFormatted}} منك. تم تخفيض رصيدك بهذا المبلغ. إذا لم يكن هذا ما سلمته، فأبلغ عن ذلك الآن.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_cod_deposit_recorded',
                bodyParams: ['{{agencyName}}', '{{currency}}', '{{amountFormatted}}']
            }
        },
        button: DEPOSIT_BUTTON
    },

    // The receiving party answered a claim the agent made.
    'cod.deposit.confirmed': {
        base: {
            en: {
                subject: 'Deposit confirmed',
                body: 'Your deposit of {{currency}} {{amountFormatted}} was confirmed by {{confirmedByName}}. Your balance has been reduced and your COD limit freed up.'
            },
            fr: {
                subject: 'Dépôt confirmé',
                body: 'Votre dépôt de {{currency}} {{amountFormatted}} a été confirmé par {{confirmedByName}}. Votre solde a été réduit et votre limite COD libérée.'
            },
            pt: {
                subject: 'Depósito confirmado',
                body: 'O seu depósito de {{currency}} {{amountFormatted}} foi confirmado por {{confirmedByName}}. O seu saldo foi reduzido e o seu limite COD libertado.'
            },
            es: {
                subject: 'Depósito confirmado',
                body: 'Tu depósito de {{currency}} {{amountFormatted}} fue confirmado por {{confirmedByName}}. Tu saldo se ha reducido y tu límite COD se ha liberado.'
            },
            ar: {
                subject: 'تم تأكيد الإيداع',
                body: 'تم تأكيد إيداعك بقيمة {{currency}} {{amountFormatted}} من قبل {{confirmedByName}}. تم تخفيض رصيدك وتحرير حد الدفع عند الاستلام.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_cod_deposit_confirmed',
                bodyParams: ['{{currency}}', '{{amountFormatted}}', '{{confirmedByName}}']
            }
        },
        button: DEPOSIT_BUTTON
    },

    // Rejection restarts the agent's own late-deposit clock, so the copy says so
    // — an agent who does not know that will not act in time.
    'cod.deposit.rejected': {
        base: {
            en: {
                subject: 'Deposit rejected',
                body: '{{confirmedByName}} rejected your declared deposit of {{currency}} {{amountFormatted}}. Reason: {{rejectionReason}}. The cash is still on your balance and your deposit deadline is running again — sort this out with them, or report it.'
            },
            fr: {
                subject: 'Dépôt refusé',
                body: '{{confirmedByName}} a refusé votre dépôt déclaré de {{currency}} {{amountFormatted}}. Motif : {{rejectionReason}}. Les espèces restent sur votre solde et votre délai de dépôt court à nouveau — réglez cela avec eux ou signalez-le.'
            },
            pt: {
                subject: 'Depósito rejeitado',
                body: '{{confirmedByName}} rejeitou o seu depósito declarado de {{currency}} {{amountFormatted}}. Motivo: {{rejectionReason}}. O dinheiro continua no seu saldo e o seu prazo de depósito voltou a correr — resolva isto com eles ou comunique.'
            },
            es: {
                subject: 'Depósito rechazado',
                body: '{{confirmedByName}} rechazó tu depósito declarado de {{currency}} {{amountFormatted}}. Motivo: {{rejectionReason}}. El efectivo sigue en tu saldo y tu plazo de depósito vuelve a correr — resuélvelo con ellos o repórtalo.'
            },
            ar: {
                subject: 'تم رفض الإيداع',
                body: 'رفض {{confirmedByName}} إيداعك المعلن بقيمة {{currency}} {{amountFormatted}}. السبب: {{rejectionReason}}. لا تزال النقود في رصيدك وبدأ العد التنازلي لموعد الإيداع من جديد — قم بتسوية ذلك معهم أو أبلغ عنه.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_cod_deposit_rejected',
                bodyParams: ['{{confirmedByName}}', '{{currency}}', '{{amountFormatted}}', '{{rejectionReason}}']
            }
        },
        button: DEPOSIT_BUTTON
    },

    // A new delivery offer. Time-sensitive — it expires on a timeout, so the copy
    // pushes the agent to act. Push is the load-bearing channel.
    'shipment.offer.received': {
        base: {
            en: {
                subject: 'New delivery offer',
                body: '{{agencyName}} is offering you a delivery for order {{orderNumber}}. Review and accept it before it expires.'
            },
            fr: {
                subject: 'Nouvelle offre de livraison',
                body: '{{agencyName}} vous propose une livraison pour la commande {{orderNumber}}. Consultez-la et acceptez-la avant qu\'elle n\'expire.'
            },
            pt: {
                subject: 'Nova oferta de entrega',
                body: '{{agencyName}} está a oferecer-lhe uma entrega para a encomenda {{orderNumber}}. Reveja e aceite antes que expire.'
            },
            es: {
                subject: 'Nueva oferta de entrega',
                body: '{{agencyName}} te ofrece una entrega para el pedido {{orderNumber}}. Revísala y acéptala antes de que caduque.'
            },
            ar: {
                subject: 'عرض توصيل جديد',
                body: 'تعرض عليك {{agencyName}} توصيلًا للطلب {{orderNumber}}. راجعه واقبله قبل انتهاء صلاحيته.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_shipment_offer_received',
                bodyParams: ['{{agencyName}}', '{{orderNumber}}']
            }
        },
        button: OFFER_BUTTON
    },

    // Round-2 reminder: a delivery offer this agent hasn't answered is STILL open
    // and can still be accepted. Pushes them to act before someone else takes it.
    'shipment.offer.reminder': {
        base: {
            en: {
                subject: 'Delivery offer still waiting',
                body: 'Your delivery offer from {{agencyName}} for order {{orderNumber}} is still open. Accept it now before another agent takes it.'
            },
            fr: {
                subject: 'Offre de livraison en attente',
                body: 'Votre offre de livraison de {{agencyName}} pour la commande {{orderNumber}} est toujours ouverte. Acceptez-la avant qu\'un autre agent ne la prenne.'
            },
            pt: {
                subject: 'Oferta de entrega ainda pendente',
                body: 'A sua oferta de entrega de {{agencyName}} para a encomenda {{orderNumber}} continua aberta. Aceite-a antes que outro agente a leve.'
            },
            es: {
                subject: 'Oferta de entrega en espera',
                body: 'Tu oferta de entrega de {{agencyName}} para el pedido {{orderNumber}} sigue abierta. Acéptala antes de que otro agente la tome.'
            },
            ar: {
                subject: 'عرض توصيل لا يزال بانتظارك',
                body: 'لا يزال عرض التوصيل من {{agencyName}} للطلب {{orderNumber}} مفتوحًا. اقبله الآن قبل أن يأخذه وكيل آخر.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_shipment_offer_reminder',
                bodyParams: ['{{agencyName}}', '{{orderNumber}}']
            }
        },
        button: OFFER_BUTTON
    },

    // The offer lapsed because the agent didn't answer in time. Informational, so
    // a missed job doesn't just vanish silently.
    'shipment.offer.expired': {
        base: {
            en: {
                subject: 'Delivery offer expired',
                body: 'The delivery offer from {{agencyName}} for order {{orderNumber}} expired because it wasn\'t accepted in time.'
            },
            fr: {
                subject: 'Offre de livraison expirée',
                body: 'L\'offre de livraison de {{agencyName}} pour la commande {{orderNumber}} a expiré faute d\'acceptation à temps.'
            },
            pt: {
                subject: 'Oferta de entrega expirada',
                body: 'A oferta de entrega de {{agencyName}} para a encomenda {{orderNumber}} expirou por não ter sido aceite a tempo.'
            },
            es: {
                subject: 'Oferta de entrega caducada',
                body: 'La oferta de entrega de {{agencyName}} para el pedido {{orderNumber}} caducó porque no se aceptó a tiempo.'
            },
            ar: {
                subject: 'انتهت صلاحية عرض التوصيل',
                body: 'انتهت صلاحية عرض التوصيل من {{agencyName}} للطلب {{orderNumber}} لعدم قبوله في الوقت المناسب.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_shipment_offer_expired',
                bodyParams: ['{{agencyName}}', '{{orderNumber}}']
            }
        },
        button: OFFER_BUTTON
    },

    // The shipment was taken off this agent and handed to another (reassignment).
    // The whole point is to tell them they are no longer responsible for it and no
    // longer have access to its customer/tracking details. No action button — they
    // have nothing left to do on it; it only remains in their activity history.
    'shipment.reassigned_away': {
        base: {
            en: {
                subject: 'Delivery reassigned',
                body: 'The delivery for order {{orderNumber}} has been reassigned to another agent by {{agencyName}}. You are no longer responsible for it, and its customer and tracking details are no longer available to you. It stays in your activity history.'
            },
            fr: {
                subject: 'Livraison réattribuée',
                body: 'La livraison de la commande {{orderNumber}} a été réattribuée à un autre agent par {{agencyName}}. Vous n\'en êtes plus responsable, et ses informations client et de suivi ne vous sont plus accessibles. Elle reste dans votre historique d\'activité.'
            },
            pt: {
                subject: 'Entrega reatribuída',
                body: 'A entrega da encomenda {{orderNumber}} foi reatribuída a outro agente por {{agencyName}}. Já não é responsável por ela, e os seus dados de cliente e de rastreio deixaram de estar disponíveis para si. Permanece no seu histórico de atividade.'
            },
            es: {
                subject: 'Entrega reasignada',
                body: 'La entrega del pedido {{orderNumber}} ha sido reasignada a otro agente por {{agencyName}}. Ya no eres responsable de ella, y sus datos de cliente y de seguimiento ya no están disponibles para ti. Permanece en tu historial de actividad.'
            },
            ar: {
                subject: 'تمت إعادة تعيين التوصيل',
                body: 'تمت إعادة تعيين توصيل الطلب {{orderNumber}} إلى وكيل آخر بواسطة {{agencyName}}. لم تعد مسؤولاً عنه، ولم تعد بيانات العميل والتتبع الخاصة به متاحة لك. يبقى في سجل نشاطك.'
            }
        },
        whatsapp: {
            text: {},
            template: {
                name: 'agent_shipment_reassigned_away',
                bodyParams: ['{{orderNumber}}', '{{agencyName}}']
            }
        }
        // No button: the agent has no remaining action on a shipment that left them.
    },

    'agent_contract.request_received': {
        base: {
            en: {
                subject: 'New agency request',
                body: '{{agencyName}} would like you to deliver for them. Review the request to accept or decline it.'
            },
            fr: {
                subject: 'Nouvelle demande d\'agence',
                body: '{{agencyName}} souhaite que vous livriez pour eux. Consultez la demande pour l\'accepter ou la refuser.'
            },
            pt: {
                subject: 'Novo pedido de agência',
                body: '{{agencyName}} gostaria que fizesse entregas para eles. Veja o pedido para o aceitar ou recusar.'
            },
            es: {
                subject: 'Nueva solicitud de agencia',
                body: '{{agencyName}} quiere que hagas entregas para ellos. Revisa la solicitud para aceptarla o rechazarla.'
            },
            ar: {
                subject: 'طلب جديد من وكالة',
                body: 'ترغب {{agencyName}} في أن تقوم بالتوصيل لهم. راجع الطلب لقبوله أو رفضه.'
            }
        },
        whatsapp: {
            text: {},
            template: { name: 'agent_contract_request_received', bodyParams: ['{{agencyName}}'] }
        },
        button: CONTRACT_BUTTON
    },

    'agent_contract.approved': {
        base: {
            en: {
                subject: 'Application approved',
                body: '{{agencyName}} approved your application. You can now receive delivery offers from them.'
            },
            fr: {
                subject: 'Candidature approuvée',
                body: '{{agencyName}} a approuvé votre candidature. Vous pouvez désormais recevoir leurs offres de livraison.'
            },
            pt: {
                subject: 'Candidatura aprovada',
                body: '{{agencyName}} aprovou a sua candidatura. Já pode receber ofertas de entrega desta agência.'
            },
            es: {
                subject: 'Solicitud aprobada',
                body: '{{agencyName}} aprobó tu solicitud. Ya puedes recibir ofertas de entrega suyas.'
            },
            ar: {
                subject: 'تمت الموافقة على طلبك',
                body: 'وافقت {{agencyName}} على طلبك. يمكنك الآن تلقي عروض التوصيل منهم.'
            }
        },
        whatsapp: {
            text: {},
            template: { name: 'agent_contract_approved', bodyParams: ['{{agencyName}}'] }
        },
        button: CONTRACT_BUTTON
    },

    'agent_contract.rejected': {
        base: {
            en: {
                subject: 'Application declined',
                body: '{{agencyName}} declined your application. You can apply again later, or browse other agencies.'
            },
            fr: {
                subject: 'Candidature refusée',
                body: '{{agencyName}} a refusé votre candidature. Vous pouvez postuler à nouveau plus tard ou explorer d\'autres agences.'
            },
            pt: {
                subject: 'Candidatura recusada',
                body: '{{agencyName}} recusou a sua candidatura. Pode candidatar-se novamente mais tarde ou explorar outras agências.'
            },
            es: {
                subject: 'Solicitud rechazada',
                body: '{{agencyName}} rechazó tu solicitud. Puedes volver a postularte más tarde o explorar otras agencias.'
            },
            ar: {
                subject: 'تم رفض طلبك',
                body: 'رفضت {{agencyName}} طلبك. يمكنك التقديم مرة أخرى لاحقًا أو استكشاف وكالات أخرى.'
            }
        },
        whatsapp: {
            text: {},
            template: { name: 'agent_contract_rejected', bodyParams: ['{{agencyName}}'] }
        },
        button: CONTRACT_BUTTON
    },

    'plan.expiring': {
        base: {
            en: { subject: 'Your plan is expiring soon', body: 'Your {{planCode}} plan expires in {{daysUntilExpiry}} day(s), on {{expiresDate}}. Renew or upgrade to keep your higher delivery limit.' },
            fr: { subject: 'Votre forfait expire bientôt', body: 'Votre forfait {{planCode}} expire dans {{daysUntilExpiry}} jour(s), le {{expiresDate}}. Renouvelez ou améliorez-le pour conserver votre limite de livraisons plus élevée.' },
            pt: { subject: 'O seu plano expira em breve', body: 'O seu plano {{planCode}} expira em {{daysUntilExpiry}} dia(s), a {{expiresDate}}. Renove ou faça upgrade para manter o seu limite de entregas mais alto.' },
            es: { subject: 'Tu plan expira pronto', body: 'Tu plan {{planCode}} expira en {{daysUntilExpiry}} día(s), el {{expiresDate}}. Renuévalo o mejóralo para mantener tu límite de entregas más alto.' },
            ar: { subject: 'باقتك على وشك الانتهاء', body: 'تنتهي باقة {{planCode}} خلال {{daysUntilExpiry}} يوم/أيام، بتاريخ {{expiresDate}}. جدّدها أو قم بترقيتها للحفاظ على حد التوصيل الأعلى.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agent_plan_expiring', bodyParams: ['{{planCode}}', '{{daysUntilExpiry}}', '{{expiresDate}}'] }
        },
        button: PLAN_BUTTON
    },

    // On downgrade the agent's concurrent-delivery limit drops to the free tier,
    // so the copy is explicit that their capacity changed.
    'plan.expired': {
        base: {
            en: { subject: 'Your plan has expired', body: 'Your {{expiredPlanCode}} plan has expired. You are now on the {{newPlanCode}} plan, which may lower how many deliveries you can hold at once. Upgrade anytime from your plan settings.' },
            fr: { subject: 'Votre forfait a expiré', body: 'Votre forfait {{expiredPlanCode}} a expiré. Vous êtes maintenant sur le forfait {{newPlanCode}}, ce qui peut réduire le nombre de livraisons simultanées. Améliorez à tout moment depuis vos paramètres de forfait.' },
            pt: { subject: 'O seu plano expirou', body: 'O seu plano {{expiredPlanCode}} expirou. Está agora no plano {{newPlanCode}}, o que pode reduzir quantas entregas pode ter em simultâneo. Faça upgrade a qualquer momento nas definições do plano.' },
            es: { subject: 'Tu plan ha expirado', body: 'Tu plan {{expiredPlanCode}} ha expirado. Ahora estás en el plan {{newPlanCode}}, lo que puede reducir cuántas entregas puedes tener a la vez. Mejora en cualquier momento desde la configuración de tu plan.' },
            ar: { subject: 'انتهت صلاحية باقتك', body: 'انتهت صلاحية باقة {{expiredPlanCode}}. أنت الآن على باقة {{newPlanCode}}، وقد يقلل ذلك عدد عمليات التوصيل التي يمكنك تنفيذها في وقت واحد. يمكنك الترقية في أي وقت من إعدادات باقتك.' }
        },
        whatsapp: {
            text: {},
            template: { name: 'agent_plan_expired', bodyParams: ['{{expiredPlanCode}}', '{{newPlanCode}}'] }
        },
        button: PLAN_BUTTON
    },

    // The agent's OWN media storage crossed a usage threshold (80/90/100%).
    // Delivery proofs are charged to the agency, not here — this is the agent's
    // personal file storage. Uploads are only blocked at 100%.
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
            template: { name: 'agent_storage_alert', bodyParams: ['{{percentUsed}}', '{{usageFormatted}}', '{{limitFormatted}}'] }
        },
        button: STORAGE_BUTTON
    }
};

// ─── Rendering helpers ───────────────────────────────────────────────────────

/**
 * Fail fast if any situation is missing a base translation for a supported
 * language. Called at notification consumer startup.
 */
export function assertAgentCatalogComplete(): void {
    for (const situation of Object.keys(AGENT_NOTIFICATION_CATALOG) as AgentNotificationType[]) {
        for (const lang of SUPPORTED_LANGUAGES) {
            if (!AGENT_NOTIFICATION_CATALOG[situation].base[lang]) {
                throw createAppError(
                    ERROR_CODES.CONFIG_NOTIFICATION_CATALOG_INCOMPLETE,
                    500,
                    `Missing '${lang}' base copy for agent notification situation '${situation}'`
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
export function renderAgentInApp(
    situation: AgentNotificationType,
    lang: Language,
    ctx: RenderContext
): { title: string; message: string } {
    const base = pickLang(AGENT_NOTIFICATION_CATALOG[situation].base, lang)!;
    return {
        title: renderTemplate(base.subject, ctx),
        message: renderTemplate(base.body, ctx)
    };
}

/**
 * Render a secondary-channel's text in the given language, applying the
 * channel + language override over the language's base.
 */
export function renderAgentChannelText(
    situation: AgentNotificationType,
    channel: 'email' | 'telegram' | 'whatsapp',
    lang: Language,
    ctx: RenderContext
): ChannelText {
    const entry = AGENT_NOTIFICATION_CATALOG[situation];
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
export function agentWhatsAppTemplateName(situation: AgentNotificationType): string {
    return AGENT_NOTIFICATION_CATALOG[situation].whatsapp.template.name;
}

/** Render the ordered WhatsApp template body parameters for a situation. */
export function renderAgentWhatsAppTemplateParams(
    situation: AgentNotificationType,
    lang: Language,
    ctx: RenderContext
): string[] {
    const tpl = AGENT_NOTIFICATION_CATALOG[situation].whatsapp.template;
    const inApp = renderAgentInApp(situation, lang, ctx);
    const merged: RenderContext = { ...ctx, title: inApp.title, message: inApp.message };
    return tpl.bodyParams.map(param => renderTemplate(param, merged));
}

/**
 * Resolve a situation's action button into a localized label + absolute URL.
 * Returns null when the situation has no button or no base URL is configured.
 */
export function renderAgentButton(
    situation: AgentNotificationType,
    lang: Language,
    ctx: RenderContext,
    baseUrl: string | undefined
): { label: string; url: string; urlSuffix: string } | null {
    const button = AGENT_NOTIFICATION_CATALOG[situation].button;
    if (!button) return null;

    const urlSuffix = renderTemplate(button.urlSuffix, ctx);
    const label = button.label[lang] ?? button.label[DEFAULT_LANGUAGE];
    const trimmedBase = baseUrl ? baseUrl.replace(/\/+$/, '') : '';
    const url = trimmedBase ? `${trimmedBase}/${urlSuffix}` : urlSuffix;

    return { label, url, urlSuffix };
}
