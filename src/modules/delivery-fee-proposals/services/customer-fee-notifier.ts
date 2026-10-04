import { Language } from '../../notifications/catalog/notification-i18n';

/**
 * Tells the CUSTOMER about a delivery-fee change on their order (ADR-A11 § Fee changes after
 * checkout). These are not domain events: each is the consequence of one write in this module,
 * and the customer stack is their only audience — the same reason the booking balance-due request
 * calls `notify()` directly rather than inventing an event whose only subscriber is that handler.
 *
 * All seven are MONEY situations, so none has a preference key (`SITUATION_PREFERENCE`) — a
 * customer is the counterparty to somebody else's change to what they pay, and a setting must not
 * silence it.
 *
 * Fire-and-forget and post-commit; never throws. The handler is resolved lazily so this module's
 * import graph never reaches the notification stacks at load.
 */

interface OrderLike {
  _id: unknown;
  customer_id: { toString(): string };
  order_number?: string | null;
  currency: string;
}

const fmt = (n: number) => Number(n ?? 0).toLocaleString();

/** Per-language optional sentences composed here, never templated (the renderer tidies spaces). */
const LINES = {
  online_refund: {
    en: 'We are returning {{amount}} to you the way you paid.',
    fr: 'Nous vous remboursons {{amount}} par votre moyen de paiement.',
    pt: 'Vamos devolver-lhe {{amount}} pelo mesmo meio de pagamento.',
    es: 'Te devolvemos {{amount}} por tu medio de pago.',
    ar: 'سنعيد إليك {{amount}} بنفس طريقة الدفع.',
  },
  cod_less: {
    en: 'You will pay {{amount}} less in cash at delivery.',
    fr: 'Vous paierez {{amount}} de moins en espèces à la livraison.',
    pt: 'Pagará menos {{amount}} em dinheiro na entrega.',
    es: 'Pagarás {{amount}} menos en efectivo al recibirlo.',
    ar: 'ستدفع {{amount}} أقل نقدًا عند التسليم.',
  },
  shop_covers: {
    en: 'The shop covers the difference — you pay nothing more.',
    fr: 'La boutique prend la différence à sa charge — vous ne payez rien de plus.',
    pt: 'A loja cobre a diferença — não paga nada a mais.',
    es: 'La tienda cubre la diferencia — no pagas nada más.',
    ar: 'يتحمل المتجر الفرق — لن تدفع أي مبلغ إضافي.',
  },
  cod_more: {
    en: 'You will pay {{amount}} more in cash at delivery.',
    fr: 'Vous paierez {{amount}} de plus en espèces à la livraison.',
    pt: 'Pagará mais {{amount}} em dinheiro na entrega.',
    es: 'Pagarás {{amount}} más en efectivo al recibirlo.',
    ar: 'ستدفع {{amount}} إضافية نقدًا عند التسليم.',
  },
  topup_paid: {
    en: 'Your payment of {{amount}} was received — the parcel can now be collected.',
    fr: 'Votre paiement de {{amount}} a bien été reçu — le colis peut maintenant être enlevé.',
    pt: 'O seu pagamento de {{amount}} foi recebido — a encomenda já pode ser recolhida.',
    es: 'Recibimos tu pago de {{amount}} — el paquete ya puede recogerse.',
    ar: 'تم استلام دفعتك البالغة {{amount}} — يمكن الآن استلام الطرد.',
  },
  combined_lowered: {
    en: 'agreed to a combined price: you save {{amount}} on delivery.',
    fr: 'a accepté un prix groupé : vous économisez {{amount}} sur la livraison.',
    pt: 'aceitou um preço conjunto: poupa {{amount}} na entrega.',
    es: 'aceptó un precio combinado: ahorras {{amount}} en el envío.',
    ar: 'وافقت على سعر مجمّع: توفر {{amount}} على التوصيل.',
  },
  combined_declined: {
    en: 'could not offer a combined price — your delivery fees stay as they are.',
    fr: 'ne peut pas proposer de prix groupé — vos frais de livraison restent inchangés.',
    pt: 'não pôde oferecer um preço conjunto — as taxas de entrega mantêm-se.',
    es: 'no pudo ofrecer un precio combinado — tus tarifas de envío no cambian.',
    ar: 'لم تتمكن من تقديم سعر مجمّع — تبقى رسوم التوصيل كما هي.',
  },
  reason: {
    en: 'Reason given: {{reason}}.',
    fr: 'Motif indiqué : {{reason}}.',
    pt: 'Motivo indicado: {{reason}}.',
    es: 'Motivo indicado: {{reason}}.',
    ar: 'السبب المذكور: {{reason}}.',
  },
} as const;

export type CustomerFeeLine = keyof typeof LINES;

/** Render one optional sentence in the customer's language (exported for the suite). */
export function customerFeeLine(key: CustomerFeeLine, lang: Language, vars: Record<string, string>): string {
  const template: string = (LINES[key] as Record<string, string>)[lang] ?? LINES[key].en;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}

async function dispatch(params: {
  situation:
    | 'order.delivery_fee.approval_needed'
    | 'order.delivery_fee.topup_due'
    | 'order.delivery_fee.lowered'
    | 'order.delivery_fee.updated'
    | 'order.delivery_fee.refund_pending'
    | 'order.delivery_fee.topup_failed'
    | 'order.combined_delivery.answered';
  order: OrderLike;
  key: string;
  context: (lang: Language) => Record<string, string>;
}): Promise<void> {
  try {
    const [{ getCustomerNotificationHandler }, { CustomerModel }, { resolveLanguage }] = await Promise.all([
      import('../../notifications/customer-notification-event-consumer'),
      import('../../customers/customer.model'),
      import('../../notifications/catalog/notification-i18n'),
    ]);
    const customerId = params.order.customer_id.toString();
    const customer = await CustomerModel.findById(customerId);
    const lang = resolveLanguage(customer as any);
    const orderId = String(params.order._id);
    await getCustomerNotificationHandler().notify({
      situation: params.situation,
      customerId,
      aggregateType: 'order',
      aggregateId: orderId,
      idempotencyKey: `customer.${params.situation}:${params.key}`,
      context: {
        orderId,
        orderNumber: params.order.order_number ?? orderId,
        currency: params.order.currency,
        ...params.context(lang),
      },
    });
  } catch (error) {
    console.error(`[CustomerFeeNotifier] ${params.situation} failed:`, error);
  }
}

export const customerFeeNotifier = {
  /** An increase on their delivery awaits their answer. */
  approvalNeeded(order: OrderLike, p: { proposalId: string; version: number; feeBefore: number; proposedFee: number; reason: string | null }): void {
    void dispatch({
      situation: 'order.delivery_fee.approval_needed',
      order,
      key: `${p.proposalId}:v${p.version}`,
      context: (lang) => ({
        feeBeforeFormatted: fmt(p.feeBefore),
        proposedFeeFormatted: fmt(p.proposedFee),
        reasonLine: p.reason ? customerFeeLine('reason', lang, { reason: p.reason }) : '',
      }),
    });
  },

  /** They approved an increase (online): the difference must be paid before pickup. */
  topupDue(order: OrderLike, p: { proposalId: string; amount: number; proposedFee: number }): void {
    void dispatch({
      situation: 'order.delivery_fee.topup_due',
      order,
      key: `${p.proposalId}`,
      context: () => ({ amountFormatted: fmt(p.amount), proposedFeeFormatted: fmt(p.proposedFee) }),
    });
  },

  /** A decrease applied directly (proposal, change-agency or combined answer). */
  lowered(order: OrderLike & { payment_method: string }, p: { proposalId: string; feeBefore: number; feeAfter: number; customerSaving: number }): void {
    void dispatch({
      situation: 'order.delivery_fee.lowered',
      order,
      key: p.proposalId,
      context: (lang) => ({
        feeBeforeFormatted: fmt(p.feeBefore),
        feeAfterFormatted: fmt(p.feeAfter),
        moneyLine:
          p.customerSaving <= 0
            ? ''
            : customerFeeLine(order.payment_method === 'cash_on_delivery' ? 'cod_less' : 'online_refund', lang, {
                amount: `${order.currency} ${fmt(p.customerSaving)}`,
              }),
      }),
    });
  },

  /** A higher fee now applies: approved (COD), paid (online), or covered by the shop. */
  updated(
    order: OrderLike,
    p: { proposalId: string; feeAfter: number; how: 'cod_more' | 'topup_paid' | 'shop_covers'; amount: number }
  ): void {
    void dispatch({
      situation: 'order.delivery_fee.updated',
      order,
      key: `${p.proposalId}:${p.how}`,
      context: (lang) => ({
        feeAfterFormatted: fmt(p.feeAfter),
        moneyLine: customerFeeLine(p.how, lang, { amount: `${order.currency} ${fmt(p.amount)}` }),
      }),
    });
  },

  /** Owed money must be returned by hand (mobile money, COD). */
  refundPending(order: OrderLike, amount: number, refundRowId: string): void {
    void dispatch({
      situation: 'order.delivery_fee.refund_pending',
      order,
      key: refundRowId,
      context: () => ({ amountFormatted: fmt(amount) }),
    });
  },

  /** The top-up charge did not go through. */
  topupFailed(order: OrderLike, p: { transactionId: string; amount: number }): void {
    void dispatch({
      situation: 'order.delivery_fee.topup_failed',
      order,
      key: p.transactionId,
      context: () => ({ amountFormatted: fmt(p.amount) }),
    });
  },

  /** The agency answered their combined-price request. */
  combinedAnswered(order: OrderLike, p: { requestId: string; agencyName: string; saving: number; declined: boolean }): void {
    void dispatch({
      situation: 'order.combined_delivery.answered',
      order,
      key: p.requestId,
      context: (lang) => ({
        agencyName: p.agencyName,
        answerLine: p.declined
          ? customerFeeLine('combined_declined', lang, {})
          : customerFeeLine('combined_lowered', lang, { amount: `${order.currency} ${fmt(p.saving)}` }),
      }),
    });
  },
};
