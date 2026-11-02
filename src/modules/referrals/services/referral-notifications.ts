import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { MailService } from '../../mail/mail.service';
import { UserModel } from '../../users/user.model';
import { CustomerModel } from '../../customers/customer.model';
import { IReferralPartner, ReferralPartnerModel } from '../models/referral-partner.model';

/**
 * Email to a partner when something about their participation changes (plan Q-2).
 *
 * Email only, and only where the account has an address: WhatsApp needs new templates approved by
 * Meta, and the referral page always shows the current status. Best-effort throughout: a mail
 * failure must never undo an administrator's decision or a payout.
 */
type Lang = 'en' | 'fr';

interface Copy {
  subject: string;
  title: string;
  body: string;
}

/** The agent app has no web address, so an agent's email carries no button. */
function referralPageUrl(role: string): string | null {
  const trim = (url: string | undefined): string | null => (url ? url.replace(/\/+$/, '') : null);
  if (role === 'agent') return null;
  const business = role === 'vendor' ? trim(process.env.VENDOR_APP_URL) : role === 'agency' ? trim(process.env.AGENCY_APP_URL) : null;
  if (business) return `${business}/dashboard/account/referrals`;
  const shop = trim(process.env.STOREFRONT_URL);
  return shop ? `${shop}/shop/account/referrals` : null;
}

const STATUS_COPY: Record<string, Record<Lang, Copy>> = {
  active: {
    en: {
      subject: 'You are now a Wi-Mall referral partner',
      title: 'Welcome to the referral program',
      body: 'Your application was approved. Your referral link is ready on your referral page.',
    },
    fr: {
      subject: 'Vous êtes maintenant partenaire de parrainage Wi-Mall',
      title: 'Bienvenue dans le programme de parrainage',
      body: 'Votre candidature a été approuvée. Votre lien de parrainage est disponible sur votre page de parrainage.',
    },
  },
  rejected: {
    en: {
      subject: 'Your referral program application',
      title: 'Your application was not approved',
      body: 'Your application to the referral program was not approved.',
    },
    fr: {
      subject: 'Votre candidature au programme de parrainage',
      title: "Votre candidature n'a pas été approuvée",
      body: "Votre candidature au programme de parrainage n'a pas été approuvée.",
    },
  },
  suspended: {
    en: {
      subject: 'Your referral partnership is suspended',
      title: 'Your partnership is suspended',
      body: 'You will not earn new rewards while it is suspended, and your balance cannot be withdrawn. What you have already earned stays recorded.',
    },
    fr: {
      subject: 'Votre partenariat de parrainage est suspendu',
      title: 'Votre partenariat est suspendu',
      body: 'Vous ne gagnez aucune nouvelle récompense pendant la suspension et votre solde ne peut pas être retiré. Ce que vous avez déjà gagné reste enregistré.',
    },
  },
  terminated: {
    en: {
      subject: 'Your referral partnership has ended',
      title: 'Your partnership has ended',
      body: 'You will not earn new rewards, and your balance cannot be withdrawn until an administrator has reviewed it. What you have already earned stays recorded.',
    },
    fr: {
      subject: 'Votre partenariat de parrainage a pris fin',
      title: 'Votre partenariat a pris fin',
      body: "Vous ne gagnez plus de récompenses et votre solde ne peut pas être retiré tant qu'un administrateur ne l'a pas examiné. Ce que vous avez déjà gagné reste enregistré.",
    },
  },
};

const PAYOUT_COPY: Record<string, Record<Lang, Copy>> = {
  'payout.paid': {
    en: {
      subject: 'Your referral payout was sent',
      title: 'Your payout was sent',
      body: 'Your withdrawal of {{amount}} was sent to your payout destination.',
    },
    fr: {
      subject: 'Votre retrait de parrainage a été envoyé',
      title: 'Votre retrait a été envoyé',
      body: 'Votre retrait de {{amount}} a été envoyé vers votre moyen de paiement.',
    },
  },
  'payout.rejected': {
    en: {
      subject: 'Your referral payout was not sent',
      title: 'Your payout was not sent',
      body: 'Your withdrawal of {{amount}} was refused and the money returned to your balance.',
    },
    fr: {
      subject: "Votre retrait de parrainage n'a pas été envoyé",
      title: "Votre retrait n'a pas été envoyé",
      body: "Votre retrait de {{amount}} a été refusé et l'argent est revenu sur votre solde.",
    },
  },
};

const STATUS_REASON_LABEL: Record<Lang, string> = { en: 'Reason', fr: 'Motif' };
const BUTTON_LABEL: Record<Lang, string> = { en: 'Open my referral page', fr: 'Ouvrir ma page de parrainage' };

let mail: MailService | null = null;

async function send(partner: IReferralPartner, copy: Record<Lang, Copy>, amount: string | null, note: string | null): Promise<void> {
  const user = await UserModel.findById(partner.user_id).select('login_email').lean();
  if (!user?.login_email) return;

  const customer = await CustomerModel.findOne({ user_id: partner.user_id }).select('preferences.language').lean();
  const lang: Lang = customer?.preferences?.language === 'fr' ? 'fr' : 'en';
  const text = copy[lang];

  mail ??= new MailService();
  await mail.send({
    to: user.login_email,
    type: 'SYSTEM',
    subject: text.subject,
    template: 'referral-status',
    variables: {
      title: text.title,
      message: amount ? text.body.replace('{{amount}}', amount) : text.body,
      reasonLabel: STATUS_REASON_LABEL[lang],
      reason: note,
      link: referralPageUrl(partner.applied_as_role),
      buttonLabel: BUTTON_LABEL[lang],
    },
  });
}

export async function notifyPartnerStatus(partner: IReferralPartner): Promise<void> {
  const copy = STATUS_COPY[partner.status];
  if (!copy) return;
  try {
    await send(partner, copy, null, partner.status_reason);
  } catch (error) {
    console.error(`[ReferralNotifications] Could not email partner ${String(partner._id)}:`, error);
  }
}

async function onPayoutEvent(event: DomainEvent): Promise<void> {
  try {
    const { ownerType, ownerId, amount, currency, reason } = event.payload as Record<string, any>;
    if (ownerType !== 'referral_partner') return;
    const copy = PAYOUT_COPY[event.eventType];
    if (!copy) return;
    const partner = await ReferralPartnerModel.findById(ownerId);
    if (!partner) return;
    await send(partner, copy, `${currency} ${Number(amount).toLocaleString()}`, reason ?? null);
  } catch (error) {
    console.error('[ReferralNotifications] Could not email a payout outcome:', error);
  }
}

/** The vendor, agency and agent stacks each ignore this owner type, so it has its own subscriber. */
export function initializeReferralNotifications(): void {
  eventBus.subscribe('payout.paid', onPayoutEvent);
  eventBus.subscribe('payout.rejected', onPayoutEvent);
}
