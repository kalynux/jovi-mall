import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { Language, SUPPORTED_LANGUAGES } from '../../../core/constants/languages';
import { renderTemplate, RenderContext } from './message-renderer';

/**
 * What a referral partner is told (owner, 2026-11-03: WhatsApp first, because it reaches every role
 * and a customer often has no email). `services/referral-notifications.ts` sends it.
 *
 * ── One set of templates for all four roles ───────────────────────────────────
 * A partner is a person, not a role, so the copy never changes with the role, and these are the only
 * templates shared across roles. They carry **no URL button, on purpose**: Meta bakes a button's host
 * into the approved template permanently, the four apps are on four hosts, and the agent app has no
 * web page at all. A button would mean 40 names instead of 10, for a link the sentence can replace.
 *
 * ⚠ **The reason is not a template parameter.** It is free text an administrator wrote, and Meta
 * refuses a parameter with a line break in it. `{{reasonLine}}` is an optional clause: the free
 * message and the email carry it, and the template's copy drops it and points at the page, which
 * always shows the reason (`scripts/generate-whatsapp-templates.ts`, `OPTIONAL_CLAUSES`).
 *
 * ⚠ **A name, once approved, keeps its parameter order and its category.** To change either, submit
 * under a new name. The wording stays factual because Meta moves anything promotional to MARKETING,
 * which a recipient can opt out of, and then this message silently never arrives.
 */
export const REFERRAL_SITUATIONS = [
  'partner.approved',
  'partner.rejected',
  'partner.suspended',
  'partner.reinstated',
  'partner.terminated',
  'partner.balance_released',
  'partner.reapply_allowed',
  'payout.paid',
  'payout.rejected',
  'payout.transfer_failed',
] as const;
export type ReferralSituation = (typeof REFERRAL_SITUATIONS)[number];

interface Copy {
  subject: string;
  body: string;
}

interface ReferralCatalogEntry {
  base: Readonly<Record<Language, Copy>>;
  template: { name: string; bodyParams: readonly string[] };
}

const AMOUNT_PARAMS = ['{{currency}}', '{{amountFormatted}}'] as const;

export const REFERRAL_NOTIFICATION_CATALOG: Readonly<Record<ReferralSituation, ReferralCatalogEntry>> = {
  'partner.approved': {
    base: {
      en: { subject: 'Referral application approved', body: 'Your application to the Wi-Mall referral program was approved. Your referral code is {{referralCode}}. Your link and your earnings are on the referral page of your Wi-Mall app.' },
      fr: { subject: 'Candidature de parrainage approuvée', body: 'Votre candidature au programme de parrainage Wi-Mall a été approuvée. Votre code de parrainage est {{referralCode}}. Votre lien et vos gains se trouvent sur la page de parrainage de votre application Wi-Mall.' },
      pt: { subject: 'Candidatura de indicação aprovada', body: 'A sua candidatura ao programa de indicação da Wi-Mall foi aprovada. O seu código de indicação é {{referralCode}}. O seu link e os seus ganhos estão na página de indicação da sua aplicação Wi-Mall.' },
      es: { subject: 'Solicitud de referidos aprobada', body: 'Tu solicitud al programa de referidos de Wi-Mall fue aprobada. Tu código de referido es {{referralCode}}. Tu enlace y tus ganancias están en la página de referidos de tu aplicación Wi-Mall.' },
      ar: { subject: 'تمت الموافقة على طلب الإحالة', body: 'تمت الموافقة على طلبك للانضمام إلى برنامج الإحالة في Wi-Mall. رمز الإحالة الخاص بك هو {{referralCode}}. تجد رابطك وأرباحك في صفحة الإحالة داخل تطبيق Wi-Mall.' },
    },
    template: { name: 'referral_partner_approved', bodyParams: ['{{referralCode}}'] },
  },
  'partner.rejected': {
    base: {
      en: { subject: 'Referral application not approved', body: 'Your application to the Wi-Mall referral program was not approved. {{reasonLine}} You can see the details on the referral page of your Wi-Mall app.' },
      fr: { subject: 'Candidature de parrainage non approuvée', body: 'Votre candidature au programme de parrainage Wi-Mall n\'a pas été approuvée. {{reasonLine}} Vous pouvez voir les détails sur la page de parrainage de votre application Wi-Mall.' },
      pt: { subject: 'Candidatura de indicação não aprovada', body: 'A sua candidatura ao programa de indicação da Wi-Mall não foi aprovada. {{reasonLine}} Pode ver os detalhes na página de indicação da sua aplicação Wi-Mall.' },
      es: { subject: 'Solicitud de referidos no aprobada', body: 'Tu solicitud al programa de referidos de Wi-Mall no fue aprobada. {{reasonLine}} Puedes ver los detalles en la página de referidos de tu aplicación Wi-Mall.' },
      ar: { subject: 'لم تتم الموافقة على طلب الإحالة', body: 'لم تتم الموافقة على طلبك للانضمام إلى برنامج الإحالة في Wi-Mall. {{reasonLine}} يمكنك الاطلاع على التفاصيل في صفحة الإحالة داخل تطبيق Wi-Mall.' },
    },
    template: { name: 'referral_partner_rejected', bodyParams: [] },
  },
  'partner.suspended': {
    base: {
      en: { subject: 'Referral partnership suspended', body: 'Your Wi-Mall referral partnership has been suspended. {{reasonLine}} You earn no new rewards during the suspension and your balance cannot be withdrawn. What you already earned stays recorded.' },
      fr: { subject: 'Partenariat de parrainage suspendu', body: 'Votre partenariat de parrainage Wi-Mall a été suspendu. {{reasonLine}} Vous ne gagnez aucune nouvelle récompense pendant la suspension et votre solde ne peut pas être retiré. Ce que vous avez déjà gagné reste enregistré.' },
      pt: { subject: 'Parceria de indicação suspensa', body: 'A sua parceria de indicação da Wi-Mall foi suspensa. {{reasonLine}} Não ganha novas recompensas durante a suspensão e o seu saldo não pode ser levantado. O que já ganhou continua registado.' },
      es: { subject: 'Asociación de referidos suspendida', body: 'Tu asociación de referidos de Wi-Mall ha sido suspendida. {{reasonLine}} No ganas nuevas recompensas durante la suspensión y tu saldo no se puede retirar. Lo que ya ganaste sigue registrado.' },
      ar: { subject: 'تم تعليق شراكة الإحالة', body: 'تم تعليق شراكة الإحالة الخاصة بك في Wi-Mall. {{reasonLine}} لن تحصل على مكافآت جديدة أثناء التعليق ولا يمكن سحب رصيدك. ما ربحته سابقًا يبقى مسجلًا.' },
    },
    template: { name: 'referral_partner_suspended', bodyParams: [] },
  },
  'partner.reinstated': {
    base: {
      en: { subject: 'Referral partnership active again', body: 'Your Wi-Mall referral partnership is active again, and your balance can be withdrawn. You earn rewards again from today. The suspended period is not paid.' },
      fr: { subject: 'Partenariat de parrainage de nouveau actif', body: 'Votre partenariat de parrainage Wi-Mall est de nouveau actif et votre solde peut être retiré. Vous gagnez à nouveau des récompenses à partir d\'aujourd\'hui. La période de suspension n\'est pas payée.' },
      pt: { subject: 'Parceria de indicação novamente ativa', body: 'A sua parceria de indicação da Wi-Mall está novamente ativa e o seu saldo pode ser levantado. Volta a ganhar recompensas a partir de hoje. O período de suspensão não é pago.' },
      es: { subject: 'Asociación de referidos activa de nuevo', body: 'Tu asociación de referidos de Wi-Mall está activa de nuevo y tu saldo se puede retirar. Vuelves a ganar recompensas desde hoy. El período de suspensión no se paga.' },
      ar: { subject: 'شراكة الإحالة نشطة مجددًا', body: 'أصبحت شراكة الإحالة الخاصة بك في Wi-Mall نشطة مجددًا ويمكن سحب رصيدك. ستحصل على المكافآت مجددًا ابتداءً من اليوم. فترة التعليق غير مدفوعة.' },
    },
    template: { name: 'referral_partner_reinstated', bodyParams: [] },
  },
  'partner.terminated': {
    base: {
      en: { subject: 'Referral partnership ended', body: 'Your Wi-Mall referral partnership has ended. {{reasonLine}} You earn no new rewards, and your balance cannot be withdrawn until Wi-Mall has reviewed it. What you already earned stays recorded.' },
      fr: { subject: 'Fin du partenariat de parrainage', body: 'Votre partenariat de parrainage Wi-Mall a pris fin. {{reasonLine}} Vous ne gagnez plus de récompenses et votre solde ne peut pas être retiré tant que Wi-Mall ne l\'a pas examiné. Ce que vous avez déjà gagné reste enregistré.' },
      pt: { subject: 'Parceria de indicação terminada', body: 'A sua parceria de indicação da Wi-Mall terminou. {{reasonLine}} Não ganha novas recompensas e o seu saldo não pode ser levantado até a Wi-Mall o analisar. O que já ganhou continua registado.' },
      es: { subject: 'Asociación de referidos finalizada', body: 'Tu asociación de referidos de Wi-Mall ha finalizado. {{reasonLine}} No ganas nuevas recompensas y tu saldo no se puede retirar hasta que Wi-Mall lo revise. Lo que ya ganaste sigue registrado.' },
      ar: { subject: 'انتهت شراكة الإحالة', body: 'انتهت شراكة الإحالة الخاصة بك في Wi-Mall. {{reasonLine}} لن تحصل على مكافآت جديدة ولا يمكن سحب رصيدك حتى تراجعه Wi-Mall. ما ربحته سابقًا يبقى مسجلًا.' },
    },
    template: { name: 'referral_partner_terminated', bodyParams: [] },
  },
  'partner.balance_released': {
    base: {
      en: { subject: 'Referral balance released', body: 'Wi-Mall has reviewed your referral balance and released it. You can now request a withdrawal on the referral page of your Wi-Mall app.' },
      fr: { subject: 'Solde de parrainage libéré', body: 'Wi-Mall a examiné votre solde de parrainage et l\'a libéré. Vous pouvez maintenant demander un retrait sur la page de parrainage de votre application Wi-Mall.' },
      pt: { subject: 'Saldo de indicação libertado', body: 'A Wi-Mall analisou o seu saldo de indicação e libertou-o. Já pode pedir um levantamento na página de indicação da sua aplicação Wi-Mall.' },
      es: { subject: 'Saldo de referidos liberado', body: 'Wi-Mall revisó tu saldo de referidos y lo liberó. Ya puedes solicitar un retiro en la página de referidos de tu aplicación Wi-Mall.' },
      ar: { subject: 'تم الإفراج عن رصيد الإحالة', body: 'راجعت Wi-Mall رصيد الإحالة الخاص بك وأفرجت عنه. يمكنك الآن طلب السحب من صفحة الإحالة داخل تطبيق Wi-Mall.' },
    },
    template: { name: 'referral_balance_released', bodyParams: [] },
  },
  /**
   * ⚠ `referral_reapply_allowed` said "you may apply again". Meta approved it as MARKETING on
   * 2026-11-03, which a recipient can opt out of, and a name keeps its category for good. So this is
   * worded as what it is, a change to their account's status, under a new name. The old name is
   * still on the WABA and nothing sends it.
   */
  'partner.reapply_allowed': {
    base: {
      en: { subject: 'Referral account status updated', body: 'The restriction on your Wi-Mall referral account has been removed, so a new application from your account is now accepted. Your current status is on the referral page of your Wi-Mall app.' },
      fr: { subject: 'Statut de votre compte de parrainage mis à jour', body: 'La restriction sur votre compte de parrainage Wi-Mall a été levée : une nouvelle candidature de votre part est désormais acceptée. Votre statut actuel figure sur la page de parrainage de votre application Wi-Mall.' },
      pt: { subject: 'Estado da conta de indicação atualizado', body: 'A restrição na sua conta de indicação da Wi-Mall foi removida, pelo que uma nova candidatura da sua conta é agora aceite. O seu estado atual está na página de indicação da sua aplicação Wi-Mall.' },
      es: { subject: 'Estado de la cuenta de referidos actualizado', body: 'Se ha eliminado la restricción de tu cuenta de referidos de Wi-Mall, por lo que ahora se acepta una nueva solicitud desde tu cuenta. Tu estado actual está en la página de referidos de tu aplicación Wi-Mall.' },
      ar: { subject: 'تم تحديث حالة حساب الإحالة', body: 'تمت إزالة القيد عن حساب الإحالة الخاص بك في Wi-Mall، وأصبح بالإمكان قبول طلب جديد من حسابك. تجد حالتك الحالية في صفحة الإحالة داخل تطبيق Wi-Mall.' },
    },
    template: { name: 'referral_account_restriction_removed', bodyParams: [] },
  },
  'payout.paid': {
    base: {
      en: { subject: 'Referral withdrawal sent', body: 'Your referral withdrawal of {{currency}} {{amountFormatted}} has been sent to your payout destination.' },
      fr: { subject: 'Retrait de parrainage envoyé', body: 'Votre retrait de parrainage de {{currency}} {{amountFormatted}} a été envoyé vers votre moyen de paiement.' },
      pt: { subject: 'Levantamento de indicação enviado', body: 'O seu levantamento de indicação de {{currency}} {{amountFormatted}} foi enviado para o seu destino de pagamento.' },
      es: { subject: 'Retiro de referidos enviado', body: 'Tu retiro de referidos de {{currency}} {{amountFormatted}} se ha enviado a tu destino de pago.' },
      ar: { subject: 'تم إرسال سحب الإحالة', body: 'تم إرسال سحب الإحالة الخاص بك بقيمة {{currency}} {{amountFormatted}} إلى وجهة الدفع الخاصة بك.' },
    },
    template: { name: 'referral_payout_paid', bodyParams: AMOUNT_PARAMS },
  },
  'payout.rejected': {
    base: {
      en: { subject: 'Referral withdrawal refused', body: 'Your referral withdrawal of {{currency}} {{amountFormatted}} was refused, and the money is back in your referral balance. You can see the reason on the referral page of your Wi-Mall app.' },
      fr: { subject: 'Retrait de parrainage refusé', body: 'Votre retrait de parrainage de {{currency}} {{amountFormatted}} a été refusé et l\'argent est revenu sur votre solde de parrainage. Vous pouvez voir le motif sur la page de parrainage de votre application Wi-Mall.' },
      pt: { subject: 'Levantamento de indicação recusado', body: 'O seu levantamento de indicação de {{currency}} {{amountFormatted}} foi recusado e o dinheiro voltou ao seu saldo de indicação. Pode ver o motivo na página de indicação da sua aplicação Wi-Mall.' },
      es: { subject: 'Retiro de referidos rechazado', body: 'Tu retiro de referidos de {{currency}} {{amountFormatted}} fue rechazado y el dinero volvió a tu saldo de referidos. Puedes ver el motivo en la página de referidos de tu aplicación Wi-Mall.' },
      ar: { subject: 'تم رفض سحب الإحالة', body: 'تم رفض سحب الإحالة الخاص بك بقيمة {{currency}} {{amountFormatted}} وأُعيد المبلغ إلى رصيد الإحالة. يمكنك معرفة السبب من صفحة الإحالة داخل تطبيق Wi-Mall.' },
    },
    template: { name: 'referral_payout_rejected', bodyParams: AMOUNT_PARAMS },
  },
  'payout.transfer_failed': {
    base: {
      en: { subject: 'Problem sending your referral withdrawal', body: 'We hit a problem sending your referral withdrawal of {{currency}} {{amountFormatted}}. Your money is safe and still reserved for it, and our team is working on it.' },
      fr: { subject: 'Problème d\'envoi de votre retrait de parrainage', body: 'Nous avons rencontré un problème en envoyant votre retrait de parrainage de {{currency}} {{amountFormatted}}. Votre argent est en sécurité et toujours réservé pour ce retrait, et notre équipe s\'en occupe.' },
      pt: { subject: 'Problema ao enviar o seu levantamento de indicação', body: 'Tivemos um problema ao enviar o seu levantamento de indicação de {{currency}} {{amountFormatted}}. O seu dinheiro está seguro e continua reservado para ele, e a nossa equipa está a tratar disso.' },
      es: { subject: 'Problema al enviar tu retiro de referidos', body: 'Tuvimos un problema al enviar tu retiro de referidos de {{currency}} {{amountFormatted}}. Tu dinero está seguro y sigue reservado para él, y nuestro equipo se está ocupando.' },
      ar: { subject: 'مشكلة في إرسال سحب الإحالة', body: 'واجهنا مشكلة في إرسال سحب الإحالة الخاص بك بقيمة {{currency}} {{amountFormatted}}. أموالك آمنة ولا تزال محجوزة له، وفريقنا يعمل على حلها.' },
    },
    template: { name: 'referral_payout_transfer_failed', bodyParams: AMOUNT_PARAMS },
  },
};

const REASON_LABEL: Readonly<Record<Language, string>> = {
  en: 'Reason',
  fr: 'Motif',
  pt: 'Motivo',
  es: 'Motivo',
  ar: 'السبب',
};

export const REFERRAL_PAGE_LABEL: Readonly<Record<Language, string>> = {
  en: 'Open my referral page',
  fr: 'Ouvrir ma page de parrainage',
  pt: 'Abrir a minha página de indicação',
  es: 'Abrir mi página de referidos',
  ar: 'فتح صفحة الإحالة',
};

/** The optional clause for a free message or an email. Empty when there is no reason to give. */
export function referralReasonLine(lang: Language, reason: string | null | undefined): string {
  const text = reason?.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return `${REASON_LABEL[lang]}: ${text}${/[.!?]$/.test(text) ? '' : '.'}`;
}

/** The same shape as the four stacks' renderers, because the template generator reads all of them alike. */
export function renderReferralChannelText(
  situation: ReferralSituation,
  _channel: 'email' | 'whatsapp',
  lang: Language,
  ctx: RenderContext
): Copy {
  const base = REFERRAL_NOTIFICATION_CATALOG[situation].base[lang];
  return { subject: renderTemplate(base.subject, ctx), body: renderTemplate(base.body, ctx) };
}

export function referralWhatsAppTemplateName(situation: ReferralSituation): string {
  return REFERRAL_NOTIFICATION_CATALOG[situation].template.name;
}

/** Positional, so its order must match the approved body. The generator derives the body from this. */
export function renderReferralWhatsAppTemplateParams(
  situation: ReferralSituation,
  _lang: Language,
  ctx: RenderContext
): string[] {
  return REFERRAL_NOTIFICATION_CATALOG[situation].template.bodyParams.map((param) => renderTemplate(param, ctx));
}

/** A situation missing a language has no text to send, so this runs at boot, like the four stacks' asserts. */
export function assertReferralCatalogComplete(): void {
  for (const situation of REFERRAL_SITUATIONS) {
    for (const lang of SUPPORTED_LANGUAGES) {
      const copy = REFERRAL_NOTIFICATION_CATALOG[situation].base[lang];
      if (!copy?.subject || !copy?.body) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, `Referral notification "${situation}" has no ${lang} copy`);
      }
    }
  }
}
