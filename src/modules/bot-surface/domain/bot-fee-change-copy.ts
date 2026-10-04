import { BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';
import { botChromeCopyGaps } from './bot-chrome-copy';

/**
 * Every word the chat says about a DELIVERY-FEE CHANGE after checkout (ADR-A11 § Fee changes
 * after checkout, W-H) — the question, its two buttons, and the sentence after each answer.
 *
 * ── WHY A TABLE OF ITS OWN ──────────────────────────────────────────────────
 * `bot-chrome-copy.ts` is shared by every stream in one working tree; a dozen keys for one
 * feature are a dozen chances of a lost write in a file other sessions edit. This table is
 * checked by the SAME function (`botChromeCopyGaps` — missing language, over-cap control,
 * dropped / stray placeholder), and refuses the boot the same way (`lifecycle.ts` calls
 * `assertBotFeeChangeCopyFits`).
 *
 * ── ⛔ NO NUMBER IS WRITTEN HERE OR COMPOSED BY THE CALLER ───────────────────
 * Every `{amount}` / `{proposed}` / `{before}` is filled with a string `formatBotPrice` made from
 * a figure the BACKEND read or planned (`planCustomerApprovedIncrease`, the frozen
 * `proposal.topup.amount`). Nothing in the chat — neither this table nor the model — subtracts
 * two fees. That is the whole reason the question is drawn by the server: a money question is
 * a fixed-wording turn with controls (`bot-surface.md` § 14.3, the truncated-confirmation lesson).
 */

type Copy = Record<BotCopyLanguage, string>;

// ── Controls (WhatsApp reply-button titles: 20) ─────────────────────────────

const ACCEPT_BUTTON: Copy = { en: 'Accept', fr: 'Accepter', pt: 'Aceitar', es: 'Aceptar', ar: 'قبول' };
const DECLINE_BUTTON: Copy = { en: 'Decline', fr: 'Refuser', pt: 'Recusar', es: 'Rechazar', ar: 'رفض' };
/** WhatsApp list-open button (20) for the "which change?" choice. */
const LIST_BUTTON: Copy = { en: 'Choose', fr: 'Choisir', pt: 'Escolher', es: 'Elegir', ar: 'اختر' };
/** WhatsApp list section heading (24). */
const SECTION_TITLE: Copy = {
    en: 'Delivery fees',
    fr: 'Frais de livraison',
    pt: 'Taxas de entrega',
    es: 'Tarifas de envío',
    ar: 'رسوم التوصيل',
};

// ── Bodies (uncapped; templates declared in FEE_TEMPLATES) ──────────────────

const QUESTION_HEADER: Copy = {
    en: 'Delivery fee change — order {order}',
    fr: 'Changement des frais de livraison — commande {order}',
    pt: 'Alteração da taxa de entrega — encomenda {order}',
    es: 'Cambio en la tarifa de envío — pedido {order}',
    ar: 'تغيير في رسوم التوصيل — الطلب {order}',
};

const ASKED_BY_COMPANY: Copy = {
    en: 'The delivery company asks {proposed} instead of {before} to deliver your parcel.',
    fr: 'La société de livraison demande {proposed} au lieu de {before} pour livrer votre colis.',
    pt: 'A empresa de entregas pede {proposed} em vez de {before} para entregar a sua encomenda.',
    es: 'La empresa de envíos pide {proposed} en lugar de {before} para entregar tu paquete.',
    ar: 'تطلب شركة التوصيل {proposed} بدلًا من {before} لتوصيل طردك.',
};

const ASKED_AFTER_MOVE: Copy = {
    en: 'Your parcel was moved to another delivery company, which charges {proposed} instead of {before}.',
    fr: 'Votre colis a été confié à une autre société de livraison, qui facture {proposed} au lieu de {before}.',
    pt: 'A sua encomenda passou para outra empresa de entregas, que cobra {proposed} em vez de {before}.',
    es: 'Tu paquete pasó a otra empresa de envíos, que cobra {proposed} en lugar de {before}.',
    ar: 'نُقل طردك إلى شركة توصيل أخرى تتقاضى {proposed} بدلًا من {before}.',
};

const REASON_LINE: Copy = {
    en: 'Reason given: {reason}',
    fr: 'Motif indiqué : {reason}',
    pt: 'Motivo indicado: {reason}',
    es: 'Motivo indicado: {reason}',
    ar: 'السبب المذكور: {reason}',
};

const IF_ACCEPT_COD: Copy = {
    en: 'If you accept, you pay {amount} more in cash at delivery.',
    fr: 'Si vous acceptez, vous paierez {amount} de plus en espèces à la livraison.',
    pt: 'Se aceitar, pagará mais {amount} em dinheiro na entrega.',
    es: 'Si aceptas, pagarás {amount} más en efectivo al recibirlo.',
    ar: 'إذا وافقت، ستدفع {amount} إضافية نقدًا عند التسليم.',
};

const IF_ACCEPT_ONLINE: Copy = {
    en: 'If you accept, you pay the difference of {amount} before your parcel is collected.',
    fr: 'Si vous acceptez, vous payez la différence de {amount} avant l’enlèvement de votre colis.',
    pt: 'Se aceitar, paga a diferença de {amount} antes de a encomenda ser recolhida.',
    es: 'Si aceptas, pagas la diferencia de {amount} antes de que se recoja tu paquete.',
    ar: 'إذا وافقت، تدفع الفرق البالغ {amount} قبل استلام طردك.',
};

const IF_DECLINE_COMPANY: Copy = {
    en: 'If you decline, the delivery company keeps the old price, asks once more, or steps back and the shop picks another one.',
    fr: 'Si vous refusez, la société de livraison garde l’ancien prix, redemande une fois, ou se retire et la boutique en choisit une autre.',
    pt: 'Se recusar, a empresa de entregas mantém o preço anterior, pede mais uma vez, ou desiste e a loja escolhe outra.',
    es: 'Si rechazas, la empresa de envíos mantiene el precio anterior, vuelve a pedir una vez, o se retira y la tienda elige otra.',
    ar: 'إذا رفضت، تحتفظ شركة التوصيل بالسعر القديم، أو تطلب مرة أخرى، أو تنسحب فيختار المتجر شركة أخرى.',
};

const IF_DECLINE_MOVE: Copy = {
    en: 'If you decline, the shop pays the difference — you pay nothing more.',
    fr: 'Si vous refusez, la boutique paie la différence — vous ne payez rien de plus.',
    pt: 'Se recusar, a loja paga a diferença — não paga nada a mais.',
    es: 'Si rechazas, la tienda paga la diferencia — no pagas nada más.',
    ar: 'إذا رفضت، يدفع المتجر الفرق — ولن تدفع أي مبلغ إضافي.',
};

const ACCEPT_QUESTION: Copy = {
    en: 'Your parcel waits for your answer. Do you accept the new delivery fee?',
    fr: 'Votre colis attend votre réponse. Acceptez-vous les nouveaux frais de livraison ?',
    pt: 'A sua encomenda aguarda a sua resposta. Aceita a nova taxa de entrega?',
    es: 'Tu paquete espera tu respuesta. ¿Aceptas la nueva tarifa de envío?',
    ar: 'طردك ينتظر ردك. هل توافق على رسوم التوصيل الجديدة؟',
};

const PAY_QUESTION: Copy = {
    en: 'You accepted {proposed} for the delivery of order {order}. Pay the difference of {amount} and your parcel can be collected.',
    fr: 'Vous avez accepté {proposed} pour la livraison de la commande {order}. Payez la différence de {amount} et votre colis pourra être enlevé.',
    pt: 'Aceitou {proposed} pela entrega da encomenda {order}. Pague a diferença de {amount} e a encomenda poderá ser recolhida.',
    es: 'Aceptaste {proposed} por el envío del pedido {order}. Paga la diferencia de {amount} y tu paquete podrá recogerse.',
    ar: 'وافقت على {proposed} لتوصيل الطلب {order}. ادفع الفرق البالغ {amount} ليتم استلام طردك.',
};

const PAY_FROM: Copy = {
    en: 'It will be charged to your mobile money {phone}.',
    fr: 'Le montant sera débité de votre mobile money {phone}.',
    pt: 'O valor será cobrado no seu mobile money {phone}.',
    es: 'Se cobrará en tu mobile money {phone}.',
    ar: 'سيُخصم المبلغ من محفظتك المحمولة {phone}.',
};

const PAY_ON_WEBSITE: Copy = {
    en: 'There is no mobile money number on your account, so pay it on the order page.',
    fr: 'Aucun numéro mobile money n’est enregistré sur votre compte : payez depuis la page de la commande.',
    pt: 'Não há número de mobile money na sua conta, por isso pague na página da encomenda.',
    es: 'No hay ningún número de mobile money en tu cuenta, así que págalo en la página del pedido.',
    ar: 'لا يوجد رقم محفظة محمولة في حسابك، لذا ادفع من صفحة الطلب.',
};

const ACCEPTED_COD: Copy = {
    en: 'Done — the delivery fee for order {order} is now {proposed}. You will pay {amount} more in cash at delivery.',
    fr: 'C’est fait — les frais de livraison de la commande {order} sont maintenant de {proposed}. Vous paierez {amount} de plus en espèces à la livraison.',
    pt: 'Feito — a taxa de entrega da encomenda {order} é agora {proposed}. Pagará mais {amount} em dinheiro na entrega.',
    es: 'Hecho — la tarifa de envío del pedido {order} ahora es {proposed}. Pagarás {amount} más en efectivo al recibirlo.',
    ar: 'تم — أصبحت رسوم توصيل الطلب {order} الآن {proposed}. ستدفع {amount} إضافية نقدًا عند التسليم.',
};

const ACCEPTED_NOTHING_TO_PAY: Copy = {
    en: 'Done — the delivery fee for order {order} is now {proposed}. You have nothing more to pay.',
    fr: 'C’est fait — les frais de livraison de la commande {order} sont maintenant de {proposed}. Vous n’avez rien de plus à payer.',
    pt: 'Feito — a taxa de entrega da encomenda {order} é agora {proposed}. Não tem mais nada a pagar.',
    es: 'Hecho — la tarifa de envío del pedido {order} ahora es {proposed}. No tienes nada más que pagar.',
    ar: 'تم — أصبحت رسوم توصيل الطلب {order} الآن {proposed}. لا يوجد عليك أي مبلغ إضافي.',
};

const DECLINED_COMPANY: Copy = {
    en: 'You declined. The delivery company keeps the old price, asks once more, or steps back and the shop picks another one — you will be told here.',
    fr: 'Vous avez refusé. La société de livraison garde l’ancien prix, redemande une fois, ou se retire et la boutique en choisit une autre — vous serez prévenu ici.',
    pt: 'Recusou. A empresa de entregas mantém o preço anterior, pede mais uma vez, ou desiste e a loja escolhe outra — será avisado aqui.',
    es: 'Has rechazado. La empresa de envíos mantiene el precio anterior, vuelve a pedir una vez, o se retira y la tienda elige otra — te avisaremos aquí.',
    ar: 'لقد رفضت. ستحتفظ شركة التوصيل بالسعر القديم، أو تطلب مرة أخرى، أو تنسحب فيختار المتجر شركة أخرى — وسنخبرك هنا.',
};

const DECLINED_MOVE: Copy = {
    en: 'You declined — the shop pays the difference. You pay nothing more for this delivery.',
    fr: 'Vous avez refusé — la boutique paie la différence. Vous ne payez rien de plus pour cette livraison.',
    pt: 'Recusou — a loja paga a diferença. Não paga nada a mais por esta entrega.',
    es: 'Has rechazado — la tienda paga la diferencia. No pagas nada más por este envío.',
    ar: 'لقد رفضت — سيدفع المتجر الفرق. لن تدفع أي مبلغ إضافي مقابل هذا التوصيل.',
};

const CHANGED_SINCE: Copy = {
    en: 'That delivery fee was changed since. Here is the current one:',
    fr: 'Ces frais de livraison ont changé depuis. Voici la demande actuelle :',
    pt: 'Essa taxa de entrega mudou entretanto. Aqui está o pedido atual:',
    es: 'Esa tarifa de envío ha cambiado desde entonces. Esta es la actual:',
    ar: 'تغيّرت رسوم التوصيل هذه منذ ذلك الحين. إليك الطلب الحالي:',
};

const NO_LONGER_WAITING: Copy = {
    en: 'This delivery fee change is no longer waiting for your answer.',
    fr: 'Ce changement de frais de livraison n’attend plus votre réponse.',
    pt: 'Esta alteração da taxa de entrega já não aguarda a sua resposta.',
    es: 'Este cambio de tarifa de envío ya no espera tu respuesta.',
    ar: 'لم يعد تغيير رسوم التوصيل هذا بانتظار ردك.',
};

const NOTHING_PENDING: Copy = {
    en: 'No delivery fee change is waiting for you.',
    fr: 'Aucun changement de frais de livraison n’attend votre réponse.',
    pt: 'Nenhuma alteração da taxa de entrega aguarda a sua resposta.',
    es: 'Ningún cambio de tarifa de envío espera tu respuesta.',
    ar: 'لا يوجد أي تغيير في رسوم التوصيل بانتظارك.',
};

const CHOOSE_ONE: Copy = {
    en: 'Several delivery fee changes are waiting for you. Which one do you want to see?',
    fr: 'Plusieurs changements de frais de livraison attendent votre réponse. Lequel voulez-vous voir ?',
    pt: 'Há várias alterações da taxa de entrega à sua espera. Qual quer ver?',
    es: 'Hay varios cambios de tarifa de envío esperándote. ¿Cuál quieres ver?',
    ar: 'هناك عدة تغييرات في رسوم التوصيل بانتظارك. أيها تريد أن ترى؟',
};

/** A list row's description (WhatsApp: 72). */
const ROW_TO_ANSWER: Copy = {
    en: '{proposed} instead of {before} · your answer',
    fr: '{proposed} au lieu de {before} · votre réponse',
    pt: '{proposed} em vez de {before} · a sua resposta',
    es: '{proposed} en lugar de {before} · tu respuesta',
    ar: '{proposed} بدلًا من {before} · بانتظار ردك',
};

const ROW_TO_PAY: Copy = {
    en: '{amount} to pay',
    fr: '{amount} à payer',
    pt: '{amount} a pagar',
    es: '{amount} por pagar',
    ar: '{amount} للدفع',
};

/** A list row's label on Telegram (one 64-character button) and its WhatsApp title source. */
const ROW_LABEL: Copy = {
    en: 'Order {order}',
    fr: 'Commande {order}',
    pt: 'Encomenda {order}',
    es: 'Pedido {order}',
    ar: 'الطلب {order}',
};

const COMBINED_SENT: Copy = {
    en: 'Request sent to {agency} for a combined price on {count} parcels. Fees can only go down — you will be told here when they answer.',
    fr: 'Demande envoyée à {agency} pour un prix groupé sur {count} colis. Les frais ne peuvent que baisser — vous serez prévenu ici de leur réponse.',
    pt: 'Pedido enviado a {agency} para um preço conjunto em {count} encomendas. As taxas só podem baixar — será avisado aqui quando responderem.',
    es: 'Solicitud enviada a {agency} para un precio combinado en {count} paquetes. Las tarifas solo pueden bajar — te avisaremos aquí cuando respondan.',
    ar: 'أُرسل الطلب إلى {agency} للحصول على سعر مجمّع لـ {count} طرود. لا يمكن للرسوم إلا أن تنخفض — وسنخبرك هنا عند الرد.',
};

const COMBINED_CANCELLED: Copy = {
    en: 'Your combined delivery request was cancelled. Your delivery fees stay as they are.',
    fr: 'Votre demande de livraison groupée a été annulée. Vos frais de livraison restent inchangés.',
    pt: 'O seu pedido de entrega conjunta foi cancelado. As taxas de entrega mantêm-se.',
    es: 'Tu solicitud de envío combinado se canceló. Tus tarifas de envío no cambian.',
    ar: 'أُلغي طلب التوصيل المجمّع. تبقى رسوم التوصيل كما هي.',
};

const FEE_COPY = Object.freeze({
    acceptButton: { copy: ACCEPT_BUTTON, cap: 20 },
    declineButton: { copy: DECLINE_BUTTON, cap: 20 },
    listButton: { copy: LIST_BUTTON, cap: 20 },
    sectionTitle: { copy: SECTION_TITLE, cap: 24 },
    questionHeader: { copy: QUESTION_HEADER, cap: null },
    askedByCompany: { copy: ASKED_BY_COMPANY, cap: null },
    askedAfterMove: { copy: ASKED_AFTER_MOVE, cap: null },
    reasonLine: { copy: REASON_LINE, cap: null },
    ifAcceptCod: { copy: IF_ACCEPT_COD, cap: null },
    ifAcceptOnline: { copy: IF_ACCEPT_ONLINE, cap: null },
    ifDeclineCompany: { copy: IF_DECLINE_COMPANY, cap: null },
    ifDeclineMove: { copy: IF_DECLINE_MOVE, cap: null },
    acceptQuestion: { copy: ACCEPT_QUESTION, cap: null },
    payQuestion: { copy: PAY_QUESTION, cap: null },
    payFrom: { copy: PAY_FROM, cap: null },
    payOnWebsite: { copy: PAY_ON_WEBSITE, cap: null },
    acceptedCod: { copy: ACCEPTED_COD, cap: null },
    acceptedNothingToPay: { copy: ACCEPTED_NOTHING_TO_PAY, cap: null },
    declinedCompany: { copy: DECLINED_COMPANY, cap: null },
    declinedMove: { copy: DECLINED_MOVE, cap: null },
    changedSince: { copy: CHANGED_SINCE, cap: null },
    noLongerWaiting: { copy: NO_LONGER_WAITING, cap: null },
    nothingPending: { copy: NOTHING_PENDING, cap: null },
    chooseOne: { copy: CHOOSE_ONE, cap: null },
    // ⚠ 72 — a WhatsApp list row DESCRIPTION. Measured with the values filled by the caller too.
    rowToAnswer: { copy: ROW_TO_ANSWER, cap: null },
    rowToPay: { copy: ROW_TO_PAY, cap: null },
    rowLabel: { copy: ROW_LABEL, cap: null },
    combinedSent: { copy: COMBINED_SENT, cap: null },
    combinedCancelled: { copy: COMBINED_CANCELLED, cap: null },
} as const);

export type BotFeeCopyKey = keyof typeof FEE_COPY;

const FEE_TEMPLATES: Readonly<Partial<Record<BotFeeCopyKey, readonly string[]>>> = Object.freeze({
    questionHeader: ['order'],
    askedByCompany: ['proposed', 'before'],
    askedAfterMove: ['proposed', 'before'],
    reasonLine: ['reason'],
    ifAcceptCod: ['amount'],
    ifAcceptOnline: ['amount'],
    payQuestion: ['proposed', 'order', 'amount'],
    payFrom: ['phone'],
    acceptedCod: ['order', 'proposed', 'amount'],
    acceptedNothingToPay: ['order', 'proposed'],
    rowToAnswer: ['proposed', 'before'],
    rowToPay: ['amount'],
    rowLabel: ['order'],
    combinedSent: ['agency', 'count'],
});

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** One string, in the customer's language — English, never the key, when a language is missing. */
export function botFeeCopy(key: BotFeeCopyKey, language: string | null | undefined): string {
    const { copy } = FEE_COPY[key];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * A template, filled. Never throws: an unfilled placeholder is left as written (the boot assert
 * guarantees every language carries exactly the declared ones).
 */
export function botFeeCopyFill(
    key: BotFeeCopyKey,
    language: string | null | undefined,
    values: Readonly<Record<string, string>>,
): string {
    return botFeeCopy(key, language).replace(PLACEHOLDER, (whole: string, name: string) =>
        (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole));
}

/** Every way this table is unusable — the same checks the chrome table gets. Exported for the suite. */
export function botFeeChangeCopyGaps(): string[] {
    return botChromeCopyGaps(FEE_COPY, FEE_TEMPLATES);
}

/** Refuse to boot on a missing translation, an over-cap control or a broken placeholder. */
export function assertBotFeeChangeCopyFits(): void {
    const gaps = botFeeChangeCopyGaps();
    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] delivery-fee copy is unusable: ${gaps.join('; ')}`);
    }
}

/** ⚠ Exported for `test:bot-fee-changes`. */
export const __FEE_COPY_TABLE = FEE_COPY;
export const __FEE_COPY_TEMPLATES = FEE_TEMPLATES;
