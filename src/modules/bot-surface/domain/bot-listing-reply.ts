import { Language } from '../../notifications/catalog/notification-i18n';
import type { BotReplyIntent, BotReplyOption, BotSingleReplyIntent } from './channel-reply';
import {
    LISTING_FIELD_CODES,
    ListingFieldName,
    listingConsentActionId,
    listingRevealActionId,
    listingSaveActionId,
} from './bot-action-id';

/**
 * What the customer bot SAYS about a service listing (SERVICE-LISTINGS-PLAN § n8n, § C-3a) —
 * the card, each revealed contact, and the opt-in question. Channel-neutral intents; the
 * renderer draws them for Telegram and WhatsApp (`channel-reply.ts`).
 *
 * ⛔ **A card carries no contact value, no vendor id and no pin** (§ C-3): its buttons NAME the
 * fields the listing has. A value appears only in the reply to a TAP (`lr:`), after the reveal
 * charged the provider — never in anything the model can produce on its own.
 *
 * ⚠ **The buttons are a `choice` (a list on WhatsApp)**: a listing can have seven fields and a
 * WhatsApp message holds three reply buttons. Seven fits a list's ten rows.
 */

type Copy<T> = Record<Language, T>;
const pick = <T>(table: Copy<T>, language: string | null | undefined): T => table[(language ?? 'en') as Language] ?? table.en;

/** Row labels, ≤ 24 characters (WhatsApp list title). */
const FIELD_LABEL: Copy<Record<ListingFieldName, string>> = {
    en: { whatsapp: 'WhatsApp', phone: 'Phone number', email: 'Email', website: 'Website', socials: 'Social pages', location: 'Location on the map', video: 'Video: the way there' },
    fr: { whatsapp: 'WhatsApp', phone: 'Téléphone', email: 'E-mail', website: 'Site web', socials: 'Réseaux sociaux', location: 'Adresse sur la carte', video: 'Vidéo : l’itinéraire' },
    pt: { whatsapp: 'WhatsApp', phone: 'Telefone', email: 'E-mail', website: 'Site', socials: 'Redes sociais', location: 'Localização no mapa', video: 'Vídeo: o caminho' },
    es: { whatsapp: 'WhatsApp', phone: 'Teléfono', email: 'Correo', website: 'Sitio web', socials: 'Redes sociales', location: 'Ubicación en el mapa', video: 'Vídeo: cómo llegar' },
    ar: { whatsapp: 'واتساب', phone: 'رقم الهاتف', email: 'البريد الإلكتروني', website: 'الموقع الإلكتروني', socials: 'صفحات التواصل', location: 'الموقع على الخريطة', video: 'فيديو: الطريق' },
};

interface CardCopy {
    /** Under the card: the L-13 disclosure (stated defaults), above the buttons. */
    disclosure: string;
    /** The last row: save the listing (2026-11-08, `lv:`). ≤ 24 characters. */
    save: string;
    /** The rating line, when the listing has published reviews (2026-11-08). */
    rating: (average: string, count: number) => string;
    chooseContact: string;
    listButton: string;
    sectionTitle: string;
    noContact: string;
    areaIn: (area: string, city: string) => string;
}

const CARD: Copy<CardCopy> = {
    en: {
        disclosure: 'Tap a contact to see it. This business will see your first name and part of your number.',
        save: 'Save for later',
        rating: (a, n) => `★ ${a} · ${n} ${n === 1 ? 'review' : 'reviews'}`,
        chooseContact: 'Which contact would you like?',
        listButton: 'See contacts',
        sectionTitle: 'Contact this business',
        noContact: 'This business has no contact detail to show right now.',
        areaIn: (area, city) => `${area}, ${city}`,
    },
    fr: {
        disclosure: 'Touchez un contact pour le voir. Cette entreprise verra votre prénom et une partie de votre numéro.',
        save: 'Enregistrer',
        rating: (a, n) => `★ ${a} · ${n} avis`,
        chooseContact: 'Quel contact souhaitez-vous ?',
        listButton: 'Voir les contacts',
        sectionTitle: 'Contacter l’entreprise',
        noContact: 'Cette entreprise n’a aucun contact à afficher pour le moment.',
        areaIn: (area, city) => `${area}, ${city}`,
    },
    pt: {
        disclosure: 'Toque num contacto para o ver. Esta empresa verá o seu primeiro nome e parte do seu número.',
        save: 'Guardar',
        rating: (a, n) => `★ ${a} · ${n} ${n === 1 ? 'avaliação' : 'avaliações'}`,
        chooseContact: 'Que contacto pretende?',
        listButton: 'Ver contactos',
        sectionTitle: 'Contactar a empresa',
        noContact: 'Esta empresa não tem nenhum contacto para mostrar neste momento.',
        areaIn: (area, city) => `${area}, ${city}`,
    },
    es: {
        disclosure: 'Toca un contacto para verlo. Este negocio verá tu nombre y parte de tu número.',
        save: 'Guardar',
        rating: (a, n) => `★ ${a} · ${n} ${n === 1 ? 'reseña' : 'reseñas'}`,
        chooseContact: '¿Qué contacto quieres?',
        listButton: 'Ver contactos',
        sectionTitle: 'Contactar al negocio',
        noContact: 'Este negocio no tiene ningún contacto para mostrar ahora.',
        areaIn: (area, city) => `${area}, ${city}`,
    },
    ar: {
        disclosure: 'اضغط على وسيلة اتصال لعرضها. سيرى هذا النشاط التجاري اسمك الأول وجزءًا من رقمك.',
        save: 'حفظ',
        rating: (a, n) => `★ ${a} · ${n} تقييم`,
        chooseContact: 'أي وسيلة اتصال تريد؟',
        listButton: 'عرض جهات الاتصال',
        sectionTitle: 'التواصل مع النشاط التجاري',
        noContact: 'لا توجد لدى هذا النشاط التجاري وسيلة اتصال لعرضها حاليًا.',
        areaIn: (area, city) => `${area}، ${city}`,
    },
};

export interface ListingCardInput {
    id: string;
    title: string;
    companyName: string;
    city: string;
    area: string;
    description?: string | null;
    availableFields: readonly string[];
    /** The published customer rating (2026-11-08). Null or absent: no line is drawn. */
    rating?: { average: number; count: number } | null;
}

const KNOWN_FIELDS = Object.keys(LISTING_FIELD_CODES) as ListingFieldName[];
const DESCRIPTION_PREVIEW = 280;

function fieldOptions(listingId: string, fields: readonly string[], language: string | null): BotReplyOption[] {
    const labels = pick(FIELD_LABEL, language);
    return KNOWN_FIELDS.filter((f) => fields.includes(f)).map((f) => ({
        id: listingRevealActionId(listingId, f),
        label: labels[f],
    }));
}

/** One listing as a message: what it is, where, and one row per contact it has. */
export function listingCardIntent(card: ListingCardInput, language: string | null): BotSingleReplyIntent {
    const copy = pick(CARD, language);
    const lines = [
        `*${card.title}*`,
        card.companyName,
        copy.areaIn(card.area, card.city),
    ];
    if (card.rating && card.rating.count > 0) {
        lines.push(copy.rating(card.rating.average.toFixed(1), card.rating.count));
    }
    const description = (card.description ?? '').trim();
    if (description) {
        lines.push('', description.length > DESCRIPTION_PREVIEW ? `${description.slice(0, DESCRIPTION_PREVIEW - 1)}…` : description);
    }
    const contacts = fieldOptions(card.id, card.availableFields, language);
    // The Save row is last, after the contacts, and is drawn even when there is no contact: a
    // business can be worth keeping before it lists a number. Seven contacts + Save = 8 ≤ 10 rows.
    const options = [...contacts, { id: listingSaveActionId(card.id), label: copy.save }];
    return {
        kind: 'choice',
        text: [...lines, '', contacts.length === 0 ? copy.noContact : copy.disclosure].join('\n'),
        options,
        listButton: copy.listButton,
        sectionTitle: copy.sectionTitle,
    };
}

/** Several cards, one message each, in the order asked. */
export function listingCardsIntent(cards: readonly ListingCardInput[], language: string | null): BotReplyIntent {
    if (cards.length === 1) return listingCardIntent(cards[0], language);
    return { kind: 'sequence', parts: cards.map((c) => listingCardIntent(c, language)) };
}

// ─── A revealed contact ──────────────────────────────────────────────────────

interface RevealCopy {
    whatsapp: (business: string, number: string) => string;
    chatButton: string;
    phone: (business: string, number: string) => string;
    /** Two numbers (2026-11-08). */
    phones: (business: string, numbers: string[]) => string;
    email: (business: string, address: string) => string;
    website: (business: string) => string;
    websiteButton: string;
    socials: (business: string) => string;
    videoIntro: (business: string) => string;
    videoButton: string;
    videoOffer: string;
    videoOfferButton: string;
    consentQuestion: (business: string) => string;
    consentYes: string;
    consentNo: string;
    consentGranted: (business: string) => string;
    consentRefused: (business: string) => string;
}

const REVEAL: Copy<RevealCopy> = {
    en: {
        whatsapp: (b, n) => `WhatsApp of ${b}: ${n}`,
        chatButton: 'Chat on WhatsApp',
        phone: (b, n) => `Phone number of ${b}: ${n}`,
        phones: (b, ns) => [`Phone numbers of ${b}:`, ...ns.map((n) => `• ${n}`)].join('\n'),
        email: (b, a) => `Email of ${b}: ${a}`,
        website: (b) => `Website of ${b}:`,
        websiteButton: 'Open the website',
        socials: (b) => `Social pages of ${b}:`,
        videoIntro: (b) => `Here is the way to ${b}, filmed by the business.`,
        videoButton: 'Watch the video',
        videoOffer: 'Would you like the video of the way there?',
        videoOfferButton: 'Get the video',
        consentQuestion: (b) => `May ${b} send you messages through Wi-Mall about your request? You can stop them at any time.`,
        consentYes: 'Yes, they may',
        consentNo: 'No, thanks',
        consentGranted: (b) => `Done. ${b} may now message you through Wi-Mall. Each message has a button to stop them.`,
        consentRefused: (b) => `Done. ${b} will not message you through Wi-Mall.`,
    },
    fr: {
        whatsapp: (b, n) => `WhatsApp de ${b} : ${n}`,
        chatButton: 'Discuter WhatsApp',
        phone: (b, n) => `Téléphone de ${b} : ${n}`,
        phones: (b, ns) => [`Téléphones de ${b} :`, ...ns.map((n) => `• ${n}`)].join('\n'),
        email: (b, a) => `E-mail de ${b} : ${a}`,
        website: (b) => `Site web de ${b} :`,
        websiteButton: 'Ouvrir le site',
        socials: (b) => `Réseaux sociaux de ${b} :`,
        videoIntro: (b) => `Voici le chemin jusqu’à ${b}, filmé par l’entreprise.`,
        videoButton: 'Voir la vidéo',
        videoOffer: 'Voulez-vous la vidéo de l’itinéraire ?',
        videoOfferButton: 'Recevoir la vidéo',
        consentQuestion: (b) => `${b} peut-elle vous envoyer des messages via Wi-Mall au sujet de votre demande ? Vous pourrez les arrêter à tout moment.`,
        consentYes: 'Oui, d’accord',
        consentNo: 'Non merci',
        consentGranted: (b) => `C’est noté. ${b} peut maintenant vous écrire via Wi-Mall. Chaque message a un bouton pour les arrêter.`,
        consentRefused: (b) => `C’est noté. ${b} ne vous écrira pas via Wi-Mall.`,
    },
    pt: {
        whatsapp: (b, n) => `WhatsApp de ${b}: ${n}`,
        chatButton: 'Conversar WhatsApp',
        phone: (b, n) => `Telefone de ${b}: ${n}`,
        phones: (b, ns) => [`Telefones de ${b}:`, ...ns.map((n) => `• ${n}`)].join('\n'),
        email: (b, a) => `E-mail de ${b}: ${a}`,
        website: (b) => `Site de ${b}:`,
        websiteButton: 'Abrir o site',
        socials: (b) => `Redes sociais de ${b}:`,
        videoIntro: (b) => `Aqui está o caminho até ${b}, filmado pela empresa.`,
        videoButton: 'Ver o vídeo',
        videoOffer: 'Quer o vídeo do caminho?',
        videoOfferButton: 'Receber o vídeo',
        consentQuestion: (b) => `${b} pode enviar-lhe mensagens pela Wi-Mall sobre o seu pedido? Pode pará-las a qualquer momento.`,
        consentYes: 'Sim, pode',
        consentNo: 'Não, obrigado',
        consentGranted: (b) => `Feito. ${b} pode agora enviar-lhe mensagens pela Wi-Mall. Cada mensagem tem um botão para as parar.`,
        consentRefused: (b) => `Feito. ${b} não lhe enviará mensagens pela Wi-Mall.`,
    },
    es: {
        whatsapp: (b, n) => `WhatsApp de ${b}: ${n}`,
        chatButton: 'Chatear WhatsApp',
        phone: (b, n) => `Teléfono de ${b}: ${n}`,
        phones: (b, ns) => [`Teléfonos de ${b}:`, ...ns.map((n) => `• ${n}`)].join('\n'),
        email: (b, a) => `Correo de ${b}: ${a}`,
        website: (b) => `Sitio web de ${b}:`,
        websiteButton: 'Abrir el sitio',
        socials: (b) => `Redes sociales de ${b}:`,
        videoIntro: (b) => `Este es el camino hasta ${b}, grabado por el negocio.`,
        videoButton: 'Ver el vídeo',
        videoOffer: '¿Quieres el vídeo de cómo llegar?',
        videoOfferButton: 'Recibir el vídeo',
        consentQuestion: (b) => `¿Puede ${b} enviarte mensajes por Wi-Mall sobre tu solicitud? Puedes detenerlos cuando quieras.`,
        consentYes: 'Sí, puede',
        consentNo: 'No, gracias',
        consentGranted: (b) => `Listo. ${b} ya puede escribirte por Wi-Mall. Cada mensaje tiene un botón para detenerlos.`,
        consentRefused: (b) => `Listo. ${b} no te escribirá por Wi-Mall.`,
    },
    ar: {
        whatsapp: (b, n) => `واتساب ${b}: ${n}`,
        chatButton: 'دردشة واتساب',
        phone: (b, n) => `رقم هاتف ${b}: ${n}`,
        phones: (b, ns) => [`أرقام هاتف ${b}:`, ...ns.map((n) => `• ${n}`)].join('\n'),
        email: (b, a) => `البريد الإلكتروني لـ ${b}: ${a}`,
        website: (b) => `الموقع الإلكتروني لـ ${b}:`,
        websiteButton: 'فتح الموقع',
        socials: (b) => `صفحات التواصل لـ ${b}:`,
        videoIntro: (b) => `هذا هو الطريق إلى ${b}، صوّره النشاط التجاري.`,
        videoButton: 'مشاهدة الفيديو',
        videoOffer: 'هل تريد فيديو الطريق؟',
        videoOfferButton: 'الحصول على الفيديو',
        consentQuestion: (b) => `هل يمكن لـ ${b} إرسال رسائل إليك عبر Wi-Mall بخصوص طلبك؟ يمكنك إيقافها في أي وقت.`,
        consentYes: 'نعم، لا بأس',
        consentNo: 'لا، شكرًا',
        consentGranted: (b) => `تم. يمكن لـ ${b} الآن مراسلتك عبر Wi-Mall. كل رسالة تتضمن زرًا لإيقافها.`,
        consentRefused: (b) => `تم. لن يراسلك ${b} عبر Wi-Mall.`,
    },
};

/** The stored value shapes of § C-3 `RevealResult.value`. */
export type RevealedValue =
    | { number: string; link: string }
    | { number: string; numbers?: string[] }
    | { address: string }
    | { url: string }
    | { links: Array<{ network: string; url: string }> }
    | { address: string; latitude: number; longitude: number; mapUrl: string }
    | { url: string; host: string };

export interface RevealReplyInput {
    listingId: string;
    vendorId: string;
    businessName: string;
    field: ListingFieldName;
    value: RevealedValue;
    /** Does the listing also have a video? (The offer after a location reveal.) */
    hasVideo: boolean;
    /** Was the video already revealed in this window? Then the offer is not drawn. */
    videoAlreadyRevealed: boolean;
    /** Ask the opt-in question after this reveal (the first reveal from this provider). */
    askConsent: boolean;
}

/** The consent question, as its own message (a `choice`, so it is a tap, never a typed yes). */
export function consentQuestionIntent(vendorId: string, businessName: string, language: string | null): BotSingleReplyIntent {
    const copy = pick(REVEAL, language);
    return {
        kind: 'choice',
        text: copy.consentQuestion(businessName),
        options: [
            { id: listingConsentActionId(vendorId, true), label: copy.consentYes },
            { id: listingConsentActionId(vendorId, false), label: copy.consentNo },
        ],
        listButton: copy.consentYes,
        sectionTitle: businessName.slice(0, 24) || copy.consentYes,
    };
}

export function consentAnsweredIntent(businessName: string, granted: boolean, language: string | null): BotReplyIntent {
    const copy = pick(REVEAL, language);
    return { kind: 'text', text: granted ? copy.consentGranted(businessName) : copy.consentRefused(businessName) };
}

/** The reply to a reveal tap: the value, in the shape that suits it, then the follow-ups. */
export function revealReplyIntent(input: RevealReplyInput, language: string | null): BotReplyIntent {
    const copy = pick(REVEAL, language);
    const b = input.businessName;
    const parts: BotSingleReplyIntent[] = [];
    const v = input.value as Record<string, unknown>;

    switch (input.field) {
        case 'whatsapp':
            parts.push({ kind: 'link', text: copy.whatsapp(b, String(v.number)), label: copy.chatButton, url: String(v.link) });
            break;
        case 'phone': {
            // Both numbers when the provider gave two (2026-11-08): one unlock, one message.
            const numbers = Array.isArray(v.numbers) && v.numbers.length ? (v.numbers as string[]) : [String(v.number)];
            parts.push({ kind: 'text', text: numbers.length > 1 ? copy.phones(b, numbers) : copy.phone(b, numbers[0]) });
            break;
        }
        case 'email':
            parts.push({ kind: 'text', text: copy.email(b, String(v.address)) });
            break;
        case 'website':
            parts.push({ kind: 'link', text: `${copy.website(b)} ${String(v.url)}`, label: copy.websiteButton, url: String(v.url) });
            break;
        case 'socials': {
            const links = (v.links as Array<{ network: string; url: string }>) ?? [];
            parts.push({ kind: 'text', text: [copy.socials(b), ...links.map((l) => `• ${l.url}`)].join('\n') });
            break;
        }
        case 'location': {
            const address = String(v.address || '').trim() || b;
            parts.push({ kind: 'place', latitude: Number(v.latitude), longitude: Number(v.longitude), name: b, address });
            if (input.hasVideo && !input.videoAlreadyRevealed) {
                parts.push({
                    kind: 'choice',
                    text: copy.videoOffer,
                    options: [{ id: listingRevealActionId(input.listingId, 'video'), label: copy.videoOfferButton }],
                    listButton: copy.videoOfferButton,
                    sectionTitle: b.slice(0, 24) || copy.videoOfferButton,
                });
            }
            break;
        }
        case 'video':
            // The link itself (stated defaults): WhatsApp previews a YouTube link, Telegram plays it.
            parts.push({ kind: 'link', text: `${copy.videoIntro(b)}\n${String(v.url)}`, label: copy.videoButton, url: String(v.url) });
            break;
    }

    if (input.askConsent) parts.push(consentQuestionIntent(input.vendorId, b, language));
    return parts.length === 1 ? parts[0] : { kind: 'sequence', parts };
}
