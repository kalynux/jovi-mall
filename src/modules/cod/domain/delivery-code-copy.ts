import { Language } from '../../../core/constants/languages';

/**
 * The cash-on-delivery code message — the free-form copy every channel sends, and the WhatsApp
 * AUTHENTICATION template used only when WhatsApp refuses that for the 24-hour window.
 *
 * ── Why it is not a notification situation ───────────────────────────────────
 * The code is a CREDENTIAL. A situation writes an inbox row and feeds `recentlySent`, which
 * lands in an AI prompt and from there in an n8n execution log. Neither may hold this code.
 *
 * ⚠ **The code sits on its own line and is NOT bolded**, as in `otp-copy.ts`: a standalone
 * run of digits gets a tap-to-copy affordance on most WhatsApp clients, and asterisks defeat it.
 *
 * ── The template is AUTHENTICATION, and that was decided by Meta twice ───────
 * The first `cod_delivery_code` was UTILITY with the code, order and amount in its body; Meta
 * REJECTED it as `INCORRECT_CATEGORY` on 2026-09-27. A UTILITY version with NO code in it was
 * rejected again within seconds. To Meta, a message whose purpose is a code is authentication,
 * whatever it says. So (owner's call, 2026-09-27) the template is AUTHENTICATION, under a NEW
 * name — a category is not something an edit may change:
 *
 *   - the BODY is Meta's own fixed, localised sentence ("{{1}} is your verification code.");
 *     we supply only the code, and cannot add the order or the amount;
 *   - `add_security_recommendation` is FALSE — Meta's line is "do not share this code", and
 *     this code MUST be given to the delivery agent. The two cannot stand in one message;
 *   - no expiry footer — a delivery code does not expire in minutes;
 *   - one COPY_CODE button, which Meta compiles to a URL button carrying the code (send it as
 *     `sub_type: 'url'`, index 0 — exactly as phone verification does).
 *
 * That leaves the out-of-window customer with the code alone. The context — order, amount,
 * "only after you have your package" — is in the free-form message whenever the window is open,
 * and the order's out-for-delivery notification names the cash amount.
 */

export const DELIVERY_CODE_TEMPLATE_NAME = 'wi_mall_delivery_code';

interface DeliveryCodeValues {
    orderNumber: string;
    code: string;
    amount: string;
    currency: string;
}

const COPY: Record<Language, { subject: string; body: (v: DeliveryCodeValues) => string }> = {
    en: {
        subject: 'Your delivery code',
        body: (v) => `Your delivery code for order ${v.orderNumber} is:\n\n${v.code}\n\n`
            + `Amount to pay in cash on delivery: ${v.amount} ${v.currency}. `
            + 'Only give this code to the delivery agent AFTER you have received your package and paid.',
    },
    fr: {
        subject: 'Votre code de livraison',
        body: (v) => `Votre code de livraison pour la commande ${v.orderNumber} est :\n\n${v.code}\n\n`
            + `Montant à payer en espèces à la livraison : ${v.amount} ${v.currency}. `
            + 'Ne donnez ce code à l\'agent qu\'APRÈS avoir reçu votre colis et payé.',
    },
    pt: {
        subject: 'O seu código de entrega',
        body: (v) => `O seu código de entrega para o pedido ${v.orderNumber} é:\n\n${v.code}\n\n`
            + `Valor a pagar em dinheiro na entrega: ${v.amount} ${v.currency}. `
            + 'Só entregue este código ao agente DEPOIS de receber a sua encomenda e pagar.',
    },
    es: {
        subject: 'Tu código de entrega',
        body: (v) => `Tu código de entrega para el pedido ${v.orderNumber} es:\n\n${v.code}\n\n`
            + `Monto a pagar en efectivo contra entrega: ${v.amount} ${v.currency}. `
            + 'Entrega este código al agente SOLO después de recibir tu paquete y pagar.',
    },
    ar: {
        subject: 'رمز التسليم الخاص بك',
        body: (v) => `رمز التسليم لطلبك ${v.orderNumber} هو:\n\n${v.code}\n\n`
            + `المبلغ المطلوب دفعه نقدًا عند التسليم: ${v.amount} ${v.currency}. `
            + 'لا تُعطِ هذا الرمز للمندوب إلا بعد استلام طردك والدفع.',
    },
};

export function deliveryCodeSubject(lang: Language): string {
    return COPY[lang].subject;
}

/** The message body with real values — every channel's in-window text. */
export function deliveryCodeBody(lang: Language, values: DeliveryCodeValues): string {
    return COPY[lang].body(values);
}


/** The COPY_CODE button's label on the AUTHENTICATION template. */
export const COPY_CODE_LABEL: Record<Language, string> = {
    en: 'Copy code', fr: 'Copier le code', pt: 'Copiar código', es: 'Copiar código', ar: 'نسخ الرمز',
};

/**
 * The AUTHENTICATION template's send-time components: the code as the body's one parameter,
 * and again as the copy button's URL parameter. Meta requires both — the body alone yields a
 * copy button that copies nothing.
 */
export function deliveryCodeTemplateComponents(code: string): Array<{
    type: 'body' | 'button';
    sub_type?: 'url';
    index?: number;
    parameters: Array<{ type: 'text'; text: string }>;
}> {
    return [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: code }] },
    ];
}
