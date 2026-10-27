/**
 * What the CHAT says about WHERE an appointment happens — five languages (2026-10-27).
 *
 * Two conversations live here:
 *
 *   1. **The address step**, for a service the provider travels to (owner decisions A-1…A-7):
 *      which saved address, or type one, or share a location; a map match to tap; the town when
 *      the map found nothing; an optional description; then the time picker.
 *   2. **The place itself**, sent when the customer asks or taps Show the place (A-5): a map pin,
 *      the address and its description, and the shop's instructions or the session link — each
 *      only once the website would show it (`customerAppointmentFields`).
 *
 * ⚠ **Nothing here decides.** Whether an address or an instruction may be shown is the booking
 * module's call; these functions word what they are handed. A sentence that said "here is the
 * link" without being handed one is the failure this split prevents.
 *
 * ⚠ **Button titles stay within 20 characters** (WhatsApp reply buttons) in all five languages.
 */
import { Language } from '../../notifications/catalog/notification-i18n';

const pick = <T>(table: Record<Language, T>, language: string | null | undefined): T =>
    table[(language ?? 'en') as Language] ?? table.en;

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The address step
// ─────────────────────────────────────────────────────────────────────────────

export interface BookingAddressStepCopy {
    /** Above the saved-address buttons. */
    pickSaved: string;
    /** The location request, when saved addresses were offered above it. */
    typeOrShareToo: string;
    /** The location request, when the customer has no saved address. */
    typeOrShareOnly: string;
    /** Above the map matches of a typed address. */
    chooseMatch: string;
    /** A pin resolved to one address: is it right? */
    confirmPin: string;
    /** A typed address the map knows nothing about. */
    notFound: string;
    /** A pin the map has no address for. */
    pinNotFound: string;
    askCity: string;
    askDescription: string;
    /** The address is on the account now; the picker follows. */
    saved: (address: string) => string;
    stopped: string;
    /** An answer arrived after the step had gone. */
    expired: string;
    /** The saved address's own name. */
    addressLabel: string;
    // Controls — ≤ 20 characters.
    cancelButton: string;
    useTypedButton: string;
    noDescriptionButton: string;
    /** WhatsApp list-open button and section title. */
    listButton: string;
    sectionTitle: string;
}

const ADDRESS_STEP: Record<Language, BookingAddressStepCopy> = {
    en: {
        pickSaved: 'The provider comes to you. Where should they come? Pick one of your addresses:',
        typeOrShareToo: 'Or type a new address (street, area, town), or share your location.',
        typeOrShareOnly: 'The provider comes to you. Type the address (street, area, town), or share your location.',
        chooseMatch: 'Which one is it? Or keep the address as you typed it.',
        confirmPin: 'Is this the place?',
        notFound: "I couldn't find that on the map. Keep it as you typed it, write it differently, or share your location.",
        pinNotFound: "I couldn't find an address at that point. Type the address instead (street, area, town).",
        askCity: 'Which town or city is it in?',
        askDescription: 'Add a description to help the provider find you: a landmark, the gate colour, the floor. Or tap No description.',
        saved: (a) => `Saved: ${a}. Now choose a time.`,
        stopped: "OK, I've stopped. Tap Book again whenever you're ready.",
        expired: 'That question has expired. Tap Book on the service again.',
        addressLabel: 'Appointment',
        cancelButton: 'Cancel',
        useTypedButton: 'Use what I typed',
        noDescriptionButton: 'No description',
        listButton: 'See addresses',
        sectionTitle: 'Addresses',
    },
    fr: {
        pickSaved: 'Le prestataire vient chez vous. Où doit-il venir ? Choisissez une de vos adresses :',
        typeOrShareToo: 'Ou écrivez une nouvelle adresse (rue, quartier, ville), ou partagez votre position.',
        typeOrShareOnly: 'Le prestataire vient chez vous. Écrivez l\'adresse (rue, quartier, ville), ou partagez votre position.',
        chooseMatch: 'Laquelle est-ce ? Ou gardez l\'adresse telle que vous l\'avez écrite.',
        confirmPin: 'Est-ce bien ici ?',
        notFound: 'Je ne trouve pas cette adresse sur la carte. Gardez-la telle quelle, écrivez-la autrement, ou partagez votre position.',
        pinNotFound: 'Je ne trouve pas d\'adresse à cet endroit. Écrivez plutôt l\'adresse (rue, quartier, ville).',
        askCity: 'Dans quelle ville est-ce ?',
        askDescription: 'Ajoutez une description pour aider le prestataire à vous trouver : un repère, la couleur du portail, l\'étage. Ou touchez Sans description.',
        saved: (a) => `Enregistrée : ${a}. Choisissez maintenant un horaire.`,
        stopped: 'D\'accord, j\'arrête. Touchez Réserver quand vous voulez.',
        expired: 'Cette question a expiré. Touchez à nouveau Réserver sur le service.',
        addressLabel: 'Rendez-vous',
        cancelButton: 'Annuler',
        useTypedButton: 'Garder mon texte',
        noDescriptionButton: 'Sans description',
        listButton: 'Voir les adresses',
        sectionTitle: 'Adresses',
    },
    pt: {
        pickSaved: 'O prestador vai até si. Onde deve ir? Escolha um dos seus endereços:',
        typeOrShareToo: 'Ou escreva um novo endereço (rua, bairro, cidade), ou partilhe a sua localização.',
        typeOrShareOnly: 'O prestador vai até si. Escreva o endereço (rua, bairro, cidade), ou partilhe a sua localização.',
        chooseMatch: 'Qual é? Ou mantenha o endereço tal como o escreveu.',
        confirmPin: 'É este o local?',
        notFound: 'Não encontrei isso no mapa. Mantenha-o como escreveu, escreva-o de outra forma, ou partilhe a sua localização.',
        pinNotFound: 'Não encontrei um endereço nesse ponto. Escreva o endereço (rua, bairro, cidade).',
        askCity: 'Em que cidade fica?',
        askDescription: 'Adicione uma descrição para o prestador o encontrar: um ponto de referência, a cor do portão, o andar. Ou toque em Sem descrição.',
        saved: (a) => `Guardado: ${a}. Agora escolha uma hora.`,
        stopped: 'Está bem, parei. Toque em Reservar quando quiser.',
        expired: 'Essa pergunta expirou. Toque novamente em Reservar no serviço.',
        addressLabel: 'Marcação',
        cancelButton: 'Cancelar',
        useTypedButton: 'Usar o que escrevi',
        noDescriptionButton: 'Sem descrição',
        listButton: 'Ver endereços',
        sectionTitle: 'Endereços',
    },
    es: {
        pickSaved: 'El profesional va a tu casa. ¿Adónde debe ir? Elige una de tus direcciones:',
        typeOrShareToo: 'O escribe una dirección nueva (calle, barrio, ciudad), o comparte tu ubicación.',
        typeOrShareOnly: 'El profesional va a tu casa. Escribe la dirección (calle, barrio, ciudad), o comparte tu ubicación.',
        chooseMatch: '¿Cuál es? O deja la dirección tal como la escribiste.',
        confirmPin: '¿Es este el lugar?',
        notFound: 'No encuentro eso en el mapa. Déjala como la escribiste, escríbela de otra forma o comparte tu ubicación.',
        pinNotFound: 'No encuentro una dirección en ese punto. Escribe la dirección (calle, barrio, ciudad).',
        askCity: '¿En qué ciudad está?',
        askDescription: 'Añade una descripción para que el profesional te encuentre: una referencia, el color del portón, el piso. O toca Sin descripción.',
        saved: (a) => `Guardada: ${a}. Ahora elige una hora.`,
        stopped: 'De acuerdo, lo dejo. Toca Reservar cuando quieras.',
        expired: 'Esa pregunta ha caducado. Toca de nuevo Reservar en el servicio.',
        addressLabel: 'Cita',
        cancelButton: 'Cancelar',
        useTypedButton: 'Usar lo que escribí',
        noDescriptionButton: 'Sin descripción',
        listButton: 'Ver direcciones',
        sectionTitle: 'Direcciones',
    },
    ar: {
        pickSaved: 'مقدم الخدمة يأتي إليك. إلى أين يأتي؟ اختر أحد عناوينك:',
        typeOrShareToo: 'أو اكتب عنوانًا جديدًا (الشارع، الحي، المدينة)، أو شارك موقعك.',
        typeOrShareOnly: 'مقدم الخدمة يأتي إليك. اكتب العنوان (الشارع، الحي، المدينة)، أو شارك موقعك.',
        chooseMatch: 'أيها هو؟ أو احتفظ بالعنوان كما كتبته.',
        confirmPin: 'هل هذا هو المكان؟',
        notFound: 'لم أجد ذلك على الخريطة. احتفظ به كما كتبته، أو اكتبه بطريقة أخرى، أو شارك موقعك.',
        pinNotFound: 'لم أجد عنوانًا في تلك النقطة. اكتب العنوان بدلًا من ذلك (الشارع، الحي، المدينة).',
        askCity: 'في أي مدينة يقع؟',
        askDescription: 'أضف وصفًا ليساعد مقدم الخدمة في العثور عليك: معلم قريب، لون البوابة، الطابق. أو اضغط بدون وصف.',
        saved: (a) => `تم الحفظ: ${a}. اختر الآن موعدًا.`,
        stopped: 'حسنًا، توقفت. اضغط احجز مرة أخرى متى شئت.',
        expired: 'انتهت صلاحية هذا السؤال. اضغط احجز على الخدمة مرة أخرى.',
        addressLabel: 'موعد',
        cancelButton: 'إلغاء',
        useTypedButton: 'استخدم ما كتبته',
        noDescriptionButton: 'بدون وصف',
        listButton: 'عرض العناوين',
        sectionTitle: 'العناوين',
    },
};

export function bookingAddressStepCopy(language: string | null | undefined): BookingAddressStepCopy {
    return pick(ADDRESS_STEP, language);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The place itself
// ─────────────────────────────────────────────────────────────────────────────

/** Why the instructions or the link are not shown yet — the access view's own reasons. */
export type PlaceLockReason = 'not_confirmed' | 'not_paid' | 'too_early' | 'ended';

export interface BookingPlaceReplyCopy {
    /** A vendor-address booking the shop has not accepted. */
    addressAfterAccept: string;
    /** No place was set on the service when it was booked. */
    noPlace: string;
    /** The customer's own address. */
    atYourAddress: (address: string) => string;
    instructions: (text: string) => string;
    instructionsLater: Record<Exclude<PlaceLockReason, 'ended'>, (when: string) => string>;
    link: (url: string) => string;
    linkLater: Record<PlaceLockReason, (when: string) => string>;
    /** Online, and the shop has not added a link (yet). */
    linkNotSet: string;
    /** ≤ 20 characters. */
    showPlaceButton: string;
}

const PLACE_REPLY: Record<Language, BookingPlaceReplyCopy> = {
    en: {
        addressAfterAccept: 'The address is shown once the shop accepts your booking.',
        noPlace: "The shop hasn't said yet where this appointment takes place.",
        atYourAddress: (a) => `The provider comes to you: ${a}`,
        instructions: (t) => `Instructions from the shop: ${t}`,
        instructionsLater: {
            not_confirmed: () => "The shop's instructions appear once it accepts your booking.",
            not_paid: () => "The shop's instructions appear once the appointment is paid.",
            too_early: (w) => `The shop's instructions appear here from ${w}.`,
        },
        link: (u) => `Your link: ${u}`,
        linkLater: {
            not_confirmed: () => 'Your link appears once the shop accepts your booking.',
            not_paid: () => 'Your link appears once the appointment is paid.',
            too_early: (w) => `Your link appears here from ${w}.`,
            ended: () => 'This session has ended.',
        },
        linkNotSet: 'This is an online session. The shop will add the link before it starts.',
        showPlaceButton: 'Show the place',
    },
    fr: {
        addressAfterAccept: 'L\'adresse s\'affiche dès que la boutique accepte votre réservation.',
        noPlace: 'La boutique n\'a pas encore indiqué où a lieu ce rendez-vous.',
        atYourAddress: (a) => `Le prestataire vient chez vous : ${a}`,
        instructions: (t) => `Instructions de la boutique : ${t}`,
        instructionsLater: {
            not_confirmed: () => 'Les instructions de la boutique s\'affichent dès qu\'elle accepte votre réservation.',
            not_paid: () => 'Les instructions de la boutique s\'affichent une fois le rendez-vous payé.',
            too_early: (w) => `Les instructions de la boutique s'affichent ici à partir de ${w}.`,
        },
        link: (u) => `Votre lien : ${u}`,
        linkLater: {
            not_confirmed: () => 'Votre lien s\'affiche dès que la boutique accepte votre réservation.',
            not_paid: () => 'Votre lien s\'affiche une fois le rendez-vous payé.',
            too_early: (w) => `Votre lien s'affiche ici à partir de ${w}.`,
            ended: () => 'Cette séance est terminée.',
        },
        linkNotSet: 'C\'est une séance en ligne. La boutique ajoutera le lien avant le début.',
        showPlaceButton: 'Voir le lieu',
    },
    pt: {
        addressAfterAccept: 'O endereço aparece assim que a loja aceitar a sua reserva.',
        noPlace: 'A loja ainda não indicou onde é esta marcação.',
        atYourAddress: (a) => `O prestador vai até si: ${a}`,
        instructions: (t) => `Instruções da loja: ${t}`,
        instructionsLater: {
            not_confirmed: () => 'As instruções da loja aparecem assim que ela aceitar a sua reserva.',
            not_paid: () => 'As instruções da loja aparecem quando a marcação estiver paga.',
            too_early: (w) => `As instruções da loja aparecem aqui a partir de ${w}.`,
        },
        link: (u) => `O seu link: ${u}`,
        linkLater: {
            not_confirmed: () => 'O seu link aparece assim que a loja aceitar a sua reserva.',
            not_paid: () => 'O seu link aparece quando a marcação estiver paga.',
            too_early: (w) => `O seu link aparece aqui a partir de ${w}.`,
            ended: () => 'Esta sessão terminou.',
        },
        linkNotSet: 'É uma sessão online. A loja vai adicionar o link antes do início.',
        showPlaceButton: 'Ver o local',
    },
    es: {
        addressAfterAccept: 'La dirección aparece en cuanto la tienda acepte tu reserva.',
        noPlace: 'La tienda aún no ha indicado dónde es esta cita.',
        atYourAddress: (a) => `El profesional va a tu casa: ${a}`,
        instructions: (t) => `Instrucciones de la tienda: ${t}`,
        instructionsLater: {
            not_confirmed: () => 'Las instrucciones de la tienda aparecen en cuanto acepte tu reserva.',
            not_paid: () => 'Las instrucciones de la tienda aparecen cuando la cita esté pagada.',
            too_early: (w) => `Las instrucciones de la tienda aparecen aquí a partir de ${w}.`,
        },
        link: (u) => `Tu enlace: ${u}`,
        linkLater: {
            not_confirmed: () => 'Tu enlace aparece en cuanto la tienda acepte tu reserva.',
            not_paid: () => 'Tu enlace aparece cuando la cita esté pagada.',
            too_early: (w) => `Tu enlace aparece aquí a partir de ${w}.`,
            ended: () => 'Esta sesión ha terminado.',
        },
        linkNotSet: 'Es una sesión en línea. La tienda añadirá el enlace antes de empezar.',
        showPlaceButton: 'Ver el lugar',
    },
    ar: {
        addressAfterAccept: 'يظهر العنوان بمجرد أن يقبل المتجر حجزك.',
        noPlace: 'لم يحدد المتجر بعد مكان هذا الموعد.',
        atYourAddress: (a) => `مقدم الخدمة يأتي إليك: ${a}`,
        instructions: (t) => `تعليمات المتجر: ${t}`,
        instructionsLater: {
            not_confirmed: () => 'تظهر تعليمات المتجر بمجرد أن يقبل حجزك.',
            not_paid: () => 'تظهر تعليمات المتجر بعد دفع الموعد.',
            too_early: (w) => `تظهر تعليمات المتجر هنا ابتداءً من ${w}.`,
        },
        link: (u) => `رابطك: ${u}`,
        linkLater: {
            not_confirmed: () => 'يظهر رابطك بمجرد أن يقبل المتجر حجزك.',
            not_paid: () => 'يظهر رابطك بعد دفع الموعد.',
            too_early: (w) => `يظهر رابطك هنا ابتداءً من ${w}.`,
            ended: () => 'انتهت هذه الجلسة.',
        },
        linkNotSet: 'هذه جلسة عبر الإنترنت. سيضيف المتجر الرابط قبل البدء.',
        showPlaceButton: 'عرض المكان',
    },
};

export function bookingPlaceReplyCopy(language: string | null | undefined): BookingPlaceReplyCopy {
    return pick(PLACE_REPLY, language);
}
