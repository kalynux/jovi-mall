import { Language, DEFAULT_LANGUAGE } from '../../../core/constants/languages';
import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { connectionService } from '../../channel-connections';
import { MailService } from '../../mail/mail.service';
import { UserModel } from '../../users/user.model';
import { CustomerModel } from '../../customers/customer.model';
import { VendorModel } from '../../vendors/vendor.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';
import { WhatsappService } from '../../whatsapp/whatsapp.service';
import { WaServiceMessage } from '../../whatsapp/builders/service-message.builder';
import { getWhatsAppMessagingService } from '../../whatsapp/services/whatsapp-messaging.service';
import { isSupportedLanguage, templateLanguage } from '../../notifications/catalog/notification-i18n';
import { toWhatsAppNotificationBody, RenderContext } from '../../notifications/catalog/message-renderer';
import {
  assertReferralCatalogComplete,
  REFERRAL_PAGE_LABEL,
  referralReasonLine,
  ReferralSituation,
  referralWhatsAppTemplateName,
  renderReferralChannelText,
  renderReferralWhatsAppTemplateParams,
} from '../../notifications/catalog/referral-notification-catalog';
import { IReferralPartner, ReferralPartnerModel } from '../models/referral-partner.model';

/**
 * Telling a partner what changed (owner, 2026-11-03): WhatsApp first, and email only when WhatsApp
 * could not deliver. A customer often has no email; every role has a phone.
 *
 * A partner is a person, so this is deliberately not a fifth notification stack: it writes no inbox
 * row and reads no preference. There is nothing here a partner would mute, since each message says
 * their status or their money changed.
 *
 * ⛔ **Nothing here may throw into the caller, and callers do not wait for it.** A delivery fault
 * must never undo an administrator's decision or a payout, and a dead Redis can hang a send for
 * minutes, which must not hang the administrator's request with it.
 */

let mail: MailService | null = null;
let window: WhatsappService | null = null;

/** The page lives in the app the partner applied from. The agent app has no web address, so no button. */
function referralPageUrl(role: string): string | null {
  const trim = (url: string | undefined): string | null => (url ? url.replace(/\/+$/, '') : null);
  if (role === 'agent') return null;
  const business = role === 'vendor' ? trim(process.env.VENDOR_APP_URL) : role === 'agency' ? trim(process.env.AGENCY_APP_URL) : null;
  if (business) return `${business}/dashboard/account/referrals`;
  const shop = trim(process.env.STOREFRONT_URL);
  return shop ? `${shop}/shop/account/referrals` : null;
}

interface PartnerContact {
  lang: Language;
  /** Bare digits, as Meta addresses it and as the 24-hour window is keyed. Null: not reachable. */
  whatsapp: string | null;
  email: string | null;
}

/**
 * The profile of the role they applied from, because that is where their language and proven phone
 * are. A customer's language is under `preferences`; the other three hold `preferred_language`.
 */
async function roleProfileOf(partner: IReferralPartner): Promise<{ phone?: string | null; phone_verified?: boolean; language?: unknown }> {
  const query = { user_id: partner.user_id };
  const fields = 'phone phone_verified preferred_language';
  const row: any =
    partner.applied_as_role === 'vendor' ? await VendorModel.findOne(query).select(fields).lean()
      : partner.applied_as_role === 'agency' ? await DeliveryAgencyModel.findOne(query).select(fields).lean()
        : partner.applied_as_role === 'agent' ? await DeliveryAgentModel.findOne(query).select(fields).lean()
          : await CustomerModel.findOne(query).select('phone phone_verified preferences.language').lean();
  return { phone: row?.phone, phone_verified: row?.phone_verified, language: row?.preferences?.language ?? row?.preferred_language };
}

async function contactOf(partner: IReferralPartner): Promise<PartnerContact> {
  const [user, profile, connection] = await Promise.all([
    UserModel.findById(partner.user_id).select('login_email').lean(),
    roleProfileOf(partner),
    connectionService.getConnection(partner.user_id, 'whatsapp'),
  ]);
  // The connection is proven by the chat itself. Otherwise only a phone the person verified: this
  // text names their money, and an unverified number may be somebody else's.
  const phone = connection?.external_id ?? (profile.phone_verified ? profile.phone : null);
  return {
    lang: isSupportedLanguage(profile.language) ? profile.language : DEFAULT_LANGUAGE,
    whatsapp: phone ? phone.replace(/^\+/, '') : null,
    email: user?.login_email ?? null,
  };
}

/**
 * Free text inside the 24-hour window, the approved template outside it. True only when Meta took
 * it. A template still in review, a refused number or a provider outage all answer false, and the
 * caller then tries email.
 */
async function sendWhatsApp(
  contact: PartnerContact,
  situation: ReferralSituation,
  ctx: RenderContext,
  deliveryKey: string
): Promise<boolean> {
  if (!contact.whatsapp || !process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return false;
  const to = `+${contact.whatsapp}`;
  try {
    window ??= new WhatsappService();
    const free = await window.canSendFreeMessage(contact.whatsapp);
    const result = free
      ? await getWhatsAppMessagingService().send(
        WaServiceMessage.text({
          to,
          body: (() => {
            const text = renderReferralChannelText(situation, 'whatsapp', contact.lang, ctx);
            return toWhatsAppNotificationBody(text.subject, text.body);
          })(),
        })
      )
      : await getWhatsAppMessagingService().send({
        to,
        type: 'template',
        message: {
          type: 'template',
          name: referralWhatsAppTemplateName(situation),
          // ⛔ Never the recipient's own language: templates are approved in English and French only.
          language: templateLanguage(contact.lang),
          components: [
            {
              type: 'body',
              parameters: renderReferralWhatsAppTemplateParams(situation, contact.lang, ctx).map((text) => ({
                type: 'text' as const,
                text,
              })),
            },
          ],
        },
        meta: { idempotencyKey: `referral:${deliveryKey}:whatsapp` },
      });
    return result.success;
  } catch (error) {
    console.error(`[ReferralNotifications] WhatsApp refused ${situation}:`, error);
    return false;
  }
}

async function sendEmail(
  partner: IReferralPartner,
  contact: PartnerContact,
  situation: ReferralSituation,
  ctx: RenderContext
): Promise<void> {
  if (!contact.email) return;
  const text = renderReferralChannelText(situation, 'email', contact.lang, ctx);
  mail ??= new MailService();
  await mail.send({
    to: contact.email,
    type: 'SYSTEM',
    subject: text.subject,
    template: 'referral-status',
    variables: {
      title: text.subject,
      message: text.body,
      link: referralPageUrl(partner.applied_as_role),
      buttonLabel: REFERRAL_PAGE_LABEL[contact.lang],
    },
  });
}

/**
 * Never throws. `deliveryKey` must be unique per event: a retried send of the same event is then
 * refused by the messaging service rather than sent twice.
 */
export async function notifyPartner(
  partner: IReferralPartner,
  situation: ReferralSituation,
  deliveryKey: string,
  ctx: RenderContext = {}
): Promise<void> {
  try {
    const contact = await contactOf(partner);
    const full: RenderContext = {
      referralCode: partner.code ?? '',
      reasonLine: referralReasonLine(contact.lang, partner.status_reason),
      ...ctx,
    };
    if (await sendWhatsApp(contact, situation, full, deliveryKey)) return;
    await sendEmail(partner, contact, situation, full);
  } catch (error) {
    console.error(`[ReferralNotifications] Could not tell partner ${String(partner._id)} about ${situation}:`, error);
  }
}

const PAYOUT_SITUATIONS: Readonly<Record<string, ReferralSituation>> = {
  'payout.paid': 'payout.paid',
  'payout.rejected': 'payout.rejected',
  'payout.transfer_failed': 'payout.transfer_failed',
};

async function onPayoutEvent(event: DomainEvent): Promise<void> {
  try {
    const { ownerType, ownerId, amount, currency, payoutRequestId } = event.payload as Record<string, any>;
    if (ownerType !== 'referral_partner') return;
    const situation = PAYOUT_SITUATIONS[event.eventType];
    if (!situation) return;
    const partner = await ReferralPartnerModel.findById(ownerId);
    if (!partner) return;
    await notifyPartner(partner, situation, `${situation}:${String(payoutRequestId)}`, {
      currency: String(currency),
      amountFormatted: Number(amount).toLocaleString('en-US'),
      // A payout's refusal is shown on the page. The partnership's own reason does not belong in it.
      reasonLine: '',
    });
  } catch (error) {
    console.error('[ReferralNotifications] Could not handle a payout outcome:', error);
  }
}

/** The vendor, agency and agent stacks each ignore this owner type, so it has its own subscriber. */
export function initializeReferralNotifications(): void {
  assertReferralCatalogComplete();
  eventBus.subscribe('payout.paid', onPayoutEvent);
  eventBus.subscribe('payout.rejected', onPayoutEvent);
  eventBus.subscribe('payout.transfer_failed', onPayoutEvent);
}
