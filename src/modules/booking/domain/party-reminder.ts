/**
 * The one-time reminder a vendor and a customer can send each other about an appointment.
 *
 * Plan and owner decisions: `PRODUCTION-READINESS/BOOKING-PARTY-REMINDER-PLAN.md`.
 *
 * Each side may be reminded ONCE per booking, and the two are independent. The automatic 24-hour
 * reminder and the administrator's button neither spend it nor are limited by it (D-4).
 *
 * Pure: no I/O, `now` injectable, so `test:party-reminder` can pin every boundary. The write that
 * actually enforces "once" is the claim in `party-reminder.service.ts`; the rule here decides what
 * a screen offers and which refusal a caller gets.
 */
import { formatInTimeZone } from 'date-fns-tz';
import { DEFAULT_LANGUAGE, Language } from '../../notifications/catalog/notification-i18n';
import { BookingStatus } from '../types/booking.types';

export type ReminderSender = 'customer' | 'vendor';

/** Stored on the booking as `partyReminders`, keyed by who RECEIVES: that is what the rule limits. */
export interface PartyReminderStamps {
    toCustomerAt?: Date | null;
    toVendorAt?: Date | null;
}

export interface PartyReminderBooking {
    status: BookingStatus | string;
    startAt: Date;
    partyReminders?: PartyReminderStamps | null;
}

/** What a booking read carries, computed for whoever is reading. */
export interface PartyReminderView {
    canSend: boolean;
    /** When THIS side sent theirs. */
    sentAt: Date | null;
    /** When the OTHER side sent theirs. */
    receivedAt: Date | null;
}

export type PartyReminderRefusal = 'not_applicable' | 'already_sent';

/** The dotted path of the stamp a send by `sender` writes. Used by the claim's filter and its `$set`. */
export function partyReminderPath(sender: ReminderSender): 'partyReminders.toVendorAt' | 'partyReminders.toCustomerAt' {
    return sender === 'customer' ? 'partyReminders.toVendorAt' : 'partyReminders.toCustomerAt';
}

function stampsOf(booking: PartyReminderBooking, sender: ReminderSender): { sent: Date | null; received: Date | null } {
    const stamps = booking.partyReminders;
    return sender === 'customer'
        ? { sent: stamps?.toVendorAt ?? null, received: stamps?.toCustomerAt ?? null }
        : { sent: stamps?.toCustomerAt ?? null, received: stamps?.toVendorAt ?? null };
}

/**
 * Why `sender` may not send right now, or null when they may.
 *
 * The state is checked first: a finished appointment says `not_applicable` even if a reminder went
 * out while it was live, because that is the reason nothing more can be done with it.
 */
export function partyReminderRefusal(
    booking: PartyReminderBooking,
    sender: ReminderSender,
    now: Date = new Date(),
): PartyReminderRefusal | null {
    if (booking.status !== BookingStatus.CONFIRMED || booking.startAt.getTime() <= now.getTime()) {
        return 'not_applicable';
    }
    return stampsOf(booking, sender).sent ? 'already_sent' : null;
}

export function partyReminderView(
    booking: PartyReminderBooking,
    sender: ReminderSender,
    now: Date = new Date(),
): PartyReminderView {
    const { sent, received } = stampsOf(booking, sender);
    return {
        canSend: partyReminderRefusal(booking, sender, now) === null,
        sentAt: sent,
        receivedAt: received,
    };
}

const WHEN_PHRASES: Record<'soon' | 'today' | 'tomorrow', Record<Language, string>> = {
    soon: {
        en: 'coming up shortly',
        fr: 'dans très peu de temps',
        pt: 'já a seguir',
        es: 'muy pronto',
        ar: 'قريبًا جدًا',
    },
    today: {
        en: 'later today',
        fr: 'plus tard dans la journée',
        pt: 'ainda hoje',
        es: 'más tarde hoy',
        ar: 'لاحقًا اليوم',
    },
    tomorrow: {
        en: 'tomorrow',
        fr: 'demain',
        pt: 'amanhã',
        es: 'mañana',
        ar: 'غدًا',
    },
};

function inDaysPhrase(days: number, lang: Language): string {
    switch (lang) {
        case 'fr': return `dans ${days} jours`;
        case 'pt': return `daqui a ${days} dias`;
        case 'es': return `dentro de ${days} días`;
        case 'ar': return days === 2 ? 'خلال يومين' : days <= 10 ? `خلال ${days} أيام` : `خلال ${days} يومًا`;
        default: return `in ${days} days`;
    }
}

/** Whole calendar days from `now` to `startAt`, as a clock in `timezone` reads them. */
function calendarDaysUntil(startAt: Date, now: Date, timezone: string): number {
    const midnightOf = (date: Date): number => {
        const day = formatInTimeZone(date, timezone, 'yyyy-MM-dd');
        return Date.parse(`${day}T00:00:00Z`);
    };
    try {
        return Math.round((midnightOf(startAt) - midnightOf(now)) / 86_400_000);
    } catch {
        // An unusable timezone on the profile must not cost the reminder.
        return Math.ceil((startAt.getTime() - now.getTime()) / 86_400_000);
    }
}

/**
 * "tomorrow" / "later today" / "in 5 days", localized.
 *
 * A bare timestamp is exactly what a forgetful reader skims past, and this is the notification whose
 * entire job is to be noticed. The exact time follows it in the same sentence.
 *
 * ⚠ **Decided by the reader's CALENDAR, not by counting hours.** It used to answer "tomorrow" for
 * anything over 18 hours away. The sweep could not expose that, firing only 24 hours ahead, but a
 * reminder sent by hand can be sent any time: an appointment ten days out read "tomorrow".
 */
export function appointmentWhenPhrase(
    startAt: Date,
    lang: Language,
    timezone: string = 'Africa/Douala',
    now: Date = new Date(),
): string {
    const phrase = (key: keyof typeof WHEN_PHRASES): string => WHEN_PHRASES[key][lang] ?? WHEN_PHRASES[key][DEFAULT_LANGUAGE];

    if ((startAt.getTime() - now.getTime()) / 3_600_000 <= 3) return phrase('soon');
    const days = calendarDaysUntil(startAt, now, timezone);
    if (days <= 0) return phrase('today');
    if (days === 1) return phrase('tomorrow');
    return inDaysPhrase(days, lang);
}
