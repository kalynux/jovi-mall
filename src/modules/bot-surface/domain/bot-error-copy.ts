import { ERROR_CATEGORIES, ErrorCategory } from '../../../core/error-category';
import { ERROR_CODES, ErrorCode } from '../../../core/error-codes';

/**
 * What the CUSTOMER is told when a bot call fails — a sentence, in their language.
 *
 * ── WHY THE ERROR ENVELOPE WAS NOT ENOUGH ────────────────────────────────────
 * Phase 16's envelope carries `code`, `category` and a `message`, and that `message` is
 * written for the AUTOMATION LAYER — `DEFAULT_ERROR_MESSAGES`' own bot block says so in as
 * many words, on the grounds that n8n turns an outcome into copy and a second English
 * sentence here would be an un-localised duplicate of one it already owns.
 *
 * **That premise was wrong, and the product owner corrected it on 2026-08-26.** The
 * automation layer has no copy table and no translator: what it can do is relay a string.
 * So an error whose only human-readable half is *"No platform account is bound to this
 * messaging identity"* reaches a customer as either that sentence — which means nothing to
 * them and leaks the shape of our data model — or as nothing at all. The backend is the
 * only place that knows the code, the category AND the customer's language, so it is the
 * only place that can produce the sentence.
 *
 * ── TWO MESSAGES, NOT ONE, AND THEY ARE NOT INTERCHANGEABLE ─────────────────
 *
 *   `error.message`         — for the operator and the automation layer. Unchanged, still
 *                             English, still what `/system/errors` shows and what a
 *                             developer greps for.
 *   `error.customerMessage` — for the person in the chat. Localised, non-technical, never
 *                             names a code, a field, a collection or an internal concept.
 *
 * Replacing the first with the second was the tempting simplification and it would have
 * been a bad trade: an operator reading *"Something went wrong. Please try again."* in an
 * incident has been told nothing, and the code alone does not say which of a code's several
 * call sites fired.
 *
 * ── THE FALLBACK IS THE DESIGN, NOT THE GAP ─────────────────────────────────
 * There are 623 error codes and any of them can surface through a delegated call. Localising
 * all of them in five languages is 2 705 strings that would go stale the week after they
 * were written. So the catalogue below is **specific where being specific changes what the
 * customer does**, and everything else falls back to a sentence keyed on the nine-value
 * CATEGORY — which is always present, is derived rather than annotated, and already means
 * exactly "what kind of thing went wrong".
 *
 * The result: every error reaches the customer as a real sentence in a language they read,
 * a specific one where we have written it, and an honest general one where we have not.
 * There is no path to a raw code reaching a chat window.
 *
 * ⚠ **A missing translation falls back to ENGLISH, never to the code.** The completeness
 * assert below runs at import and refuses to boot on a half-translated entry, which is the
 * same discipline every notification catalog follows — but the runtime lookup is defensive
 * anyway, because a boot-time guarantee is worth nothing to a customer if it is ever
 * loosened.
 */

/** The five languages every notification catalog in this service has copy for. */
export const BOT_COPY_LANGUAGES = Object.freeze(['en', 'fr', 'pt', 'es', 'ar'] as const);
export type BotCopyLanguage = (typeof BOT_COPY_LANGUAGES)[number];

const DEFAULT_LANGUAGE: BotCopyLanguage = 'en';

type Copy = Record<BotCopyLanguage, string>;

/**
 * Resolve any language-ish string onto one we have copy for.
 *
 * Matches the PRIMARY SUBTAG, so Telegram's `pt-BR` and `en-GB` land on `pt` and `en`
 * rather than falling through to English by accident — a Brazilian customer reading English
 * because of a region suffix is a bug nobody would ever report.
 */
export function toBotCopyLanguage(raw: string | null | undefined): BotCopyLanguage {
    const primary = (raw ?? '').trim().toLowerCase().split(/[-_]/)[0];
    return (BOT_COPY_LANGUAGES as readonly string[]).includes(primary)
        ? (primary as BotCopyLanguage)
        : DEFAULT_LANGUAGE;
}

// ─────────────────────────────────────────────────────────────────────────────
// The category fallback — nine sentences, and they cover all 623 codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **These are written to be TRUE OF EVERY CODE in their category**, which is why they say
 * so little. A category sentence that guessed at specifics would be confidently wrong on
 * most of the codes it has to cover — and a customer acting on a wrong specific is worse
 * off than one told honestly that something did not work.
 *
 * `internal` and `external_service` deliberately do not distinguish themselves to the
 * customer: "our fault" and "our supplier's fault" are the same fact from a chat window,
 * and the boundary already masks both on the operator side for the same reason.
 */
const CATEGORY_COPY: Readonly<Record<ErrorCategory, Copy>> = Object.freeze({
    [ERROR_CATEGORIES.AUTHENTICATION]: {
        en: 'I could not confirm who you are. Please try again.',
        fr: "Je n'ai pas pu confirmer votre identité. Veuillez réessayer.",
        pt: 'Não consegui confirmar quem você é. Tente novamente.',
        es: 'No pude confirmar quién eres. Inténtalo de nuevo.',
        ar: 'لم أتمكن من التحقق من هويتك. يرجى المحاولة مرة أخرى.',
    },
    [ERROR_CATEGORIES.AUTHORIZATION]: {
        en: 'You do not have access to that.',
        fr: "Vous n'avez pas accès à cela.",
        pt: 'Você não tem acesso a isso.',
        es: 'No tienes acceso a eso.',
        ar: 'ليس لديك حق الوصول إلى ذلك.',
    },
    [ERROR_CATEGORIES.VALIDATION]: {
        en: "That does not look right. Could you send it again?",
        fr: "Cela ne semble pas correct. Pouvez-vous le renvoyer ?",
        pt: 'Isso não parece certo. Pode enviar novamente?',
        es: 'Eso no parece correcto. ¿Puedes enviarlo de nuevo?',
        ar: 'لا يبدو ذلك صحيحًا. هل يمكنك إرساله مرة أخرى؟',
    },
    [ERROR_CATEGORIES.NOT_FOUND]: {
        en: "I could not find that.",
        fr: "Je n'ai pas trouvé cela.",
        pt: 'Não consegui encontrar isso.',
        es: 'No pude encontrar eso.',
        ar: 'لم أتمكن من العثور على ذلك.',
    },
    [ERROR_CATEGORIES.CONFLICT]: {
        en: 'That has already changed. Let me check where things stand and try again.',
        fr: "Cela a déjà changé. Je vérifie la situation et réessaie.",
        pt: 'Isso já mudou. Vou verificar a situação e tentar de novo.',
        es: 'Eso ya ha cambiado. Voy a comprobarlo e intentarlo de nuevo.',
        ar: 'لقد تغيّر ذلك بالفعل. سأتحقق من الوضع وأحاول مرة أخرى.',
    },
    [ERROR_CATEGORIES.BUSINESS_RULE]: {
        en: 'That is not possible right now.',
        fr: "Ce n'est pas possible pour le moment.",
        pt: 'Isso não é possível neste momento.',
        es: 'Eso no es posible en este momento.',
        ar: 'هذا غير ممكن في الوقت الحالي.',
    },
    [ERROR_CATEGORIES.RATE_LIMIT]: {
        en: 'That was a lot at once. Give me a moment and try again.',
        fr: "Cela fait beaucoup d'un coup. Laissez-moi un instant et réessayez.",
        pt: 'Foi muita coisa de uma vez. Aguarde um momento e tente de novo.',
        es: 'Eso fue mucho de golpe. Dame un momento e inténtalo de nuevo.',
        ar: 'كان ذلك كثيرًا دفعة واحدة. امهلني لحظة ثم حاول مرة أخرى.',
    },
    [ERROR_CATEGORIES.EXTERNAL_SERVICE]: {
        en: 'Something went wrong on our side. Please try again in a moment.',
        fr: "Un problème est survenu de notre côté. Réessayez dans un instant.",
        pt: 'Algo deu errado do nosso lado. Tente novamente em instantes.',
        es: 'Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.',
        ar: 'حدث خطأ من جانبنا. يرجى المحاولة مرة أخرى بعد قليل.',
    },
    [ERROR_CATEGORIES.INTERNAL]: {
        en: 'Something went wrong on our side. Please try again in a moment.',
        fr: "Un problème est survenu de notre côté. Réessayez dans un instant.",
        pt: 'Algo deu errado do nosso lado. Tente novamente em instantes.',
        es: 'Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.',
        ar: 'حدث خطأ من جانبنا. يرجى المحاولة مرة أخرى بعد قليل.',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-code copy — only where being specific changes what the customer does
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ **The test for adding an entry here is "does the customer do something different?"**
 *
 * `BOT_GEO_CANDIDATE_EXPIRED` earns one because the customer must search again rather than
 * wait. `MESSAGING_IDENTITY_ALREADY_LINKED` earns one because the remedy is a different
 * conversation entirely. A code whose only honest customer-facing sentence is "that did not
 * work" does NOT earn one — its category already says exactly that, in five languages, and
 * a near-duplicate entry is one more string to keep in step for no gain.
 *
 * ⚠ **Nothing here may name an internal concept.** No "customer profile", no "identity", no
 * "token", no field name, no collection. A sentence a customer cannot act on is a sentence
 * that should have been left to the category fallback.
 */
const CODE_COPY: Partial<Record<ErrorCode, Copy>> = Object.freeze({
    // ── Registration and onboarding (GAP-002) ────────────────────────────────
    [ERROR_CODES.BOT_IDENTITY_UNRESOLVED]: {
        en: "I do not have an account for you yet. Send me a message and I will set one up.",
        fr: "Je n'ai pas encore de compte pour vous. Écrivez-moi et je vais en créer un.",
        pt: 'Ainda não tenho uma conta para você. Escreva-me e eu crio uma.',
        es: 'Todavía no tengo una cuenta para ti. Escríbeme y te creo una.',
        ar: 'ليس لديّ حساب لك بعد. راسلني وسأنشئ لك حسابًا.',
    },
    [ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT]: {
        en: 'I need your phone number first. Tap the button below to share it.',
        fr: "J'ai d'abord besoin de votre numéro de téléphone. Appuyez sur le bouton ci-dessous pour le partager.",
        pt: 'Preciso primeiro do seu número de telefone. Toque no botão abaixo para compartilhá-lo.',
        es: 'Primero necesito tu número de teléfono. Toca el botón de abajo para compartirlo.',
        ar: 'أحتاج أولًا إلى رقم هاتفك. اضغط على الزر أدناه لمشاركته.',
    },
    [ERROR_CODES.MAGIC_CONTACT_UNVERIFIED]: {
        en: 'That contact is not yours. Please use the button to share your own number.',
        fr: "Ce contact n'est pas le vôtre. Utilisez le bouton pour partager votre propre numéro.",
        pt: 'Esse contato não é seu. Use o botão para compartilhar o seu próprio número.',
        es: 'Ese contacto no es tuyo. Usa el botón para compartir tu propio número.',
        ar: 'جهة الاتصال هذه ليست لك. استخدم الزر لمشاركة رقمك الخاص.',
    },
    [ERROR_CODES.BOT_REGISTRATION_IDENTITY_TAKEN]: {
        en: 'This chat is already connected to a different account. Please contact support.',
        fr: "Cette conversation est déjà liée à un autre compte. Veuillez contacter le support.",
        pt: 'Esta conversa já está ligada a outra conta. Entre em contato com o suporte.',
        es: 'Este chat ya está vinculado a otra cuenta. Ponte en contacto con soporte.',
        ar: 'هذه المحادثة مرتبطة بالفعل بحساب آخر. يرجى التواصل مع الدعم.',
    },
    [ERROR_CODES.AUTH_ACCOUNT_SUSPENDED]: {
        en: 'Your account is not active at the moment. Please contact support.',
        fr: "Votre compte n'est pas actif pour le moment. Veuillez contacter le support.",
        pt: 'Sua conta não está ativa no momento. Entre em contato com o suporte.',
        es: 'Tu cuenta no está activa en este momento. Ponte en contacto con soporte.',
        ar: 'حسابك غير نشط في الوقت الحالي. يرجى التواصل مع الدعم.',
    },

    // ── The address flow (GAP-005) ───────────────────────────────────────────
    // Earns an entry because the remedy is an ACTION — search again — and the category
    // sentence ("that does not look right") would have the customer re-send the same thing.
    [ERROR_CODES.BOT_GEO_CANDIDATE_EXPIRED]: {
        en: 'That address search has expired. Tell me the address again and I will look it up.',
        fr: "Cette recherche d'adresse a expiré. Redonnez-moi l'adresse et je la rechercherai.",
        pt: 'Essa busca de endereço expirou. Diga-me o endereço novamente e eu procuro.',
        es: 'Esa búsqueda de dirección ha caducado. Dime la dirección otra vez y la busco.',
        ar: 'انتهت صلاحية البحث عن هذا العنوان. أخبرني بالعنوان مرة أخرى وسأبحث عنه.',
    },

    // ── Inbound files and ticket attachments (Step 7b) ───────────────────────
    // Both earn an entry, and both for the reason stated above: the remedy is an ACTION
    // the customer takes, and the category sentence would send them nowhere. The
    // `not_found` fallback ("I could not find that") is actively misleading for a stale
    // file handle — nothing is missing, the window closed — and the `conflict` fallback
    // ("try again") is wrong for a full ticket, where trying again fails identically.
    [ERROR_CODES.BOT_INBOUND_FILE_EXPIRED]: {
        en: 'I no longer have that file. Please send the photo again.',
        fr: "Je n'ai plus ce fichier. Veuillez renvoyer la photo.",
        pt: 'Já não tenho esse ficheiro. Envie a foto novamente, por favor.',
        es: 'Ya no tengo ese archivo. Envía la foto otra vez, por favor.',
        ar: 'لم يعد هذا الملف متاحًا لديّ. من فضلك أرسل الصورة مرة أخرى.',
    },
    [ERROR_CODES.TICKET_ATTACHMENT_LIMIT_EXCEEDED]: {
        en: 'That request already has the maximum of five files. Open a new one if you need to send more.',
        fr: "Cette demande contient déjà le maximum de cinq fichiers. Ouvrez-en une nouvelle si vous devez en envoyer d'autres.",
        pt: 'Esse pedido já tem o máximo de cinco ficheiros. Abra um novo se precisar de enviar mais.',
        es: 'Esa solicitud ya tiene el máximo de cinco archivos. Abre una nueva si necesitas enviar más.',
        ar: 'يحتوي هذا الطلب بالفعل على الحد الأقصى وهو خمسة ملفات. افتح طلبًا جديدًا إذا احتجت إلى إرسال المزيد.',
    },

    // ── Support routing (GAP-004) ────────────────────────────────────────────
    // Both earn an entry because both remedies are ACTIONS the customer takes,
    // and both category sentences ("I could not find that" / "that has already
    // changed") would send them back to repeat the same question.
    [ERROR_CODES.BOT_SUPPORT_NO_CONTEXT]: {
        en: 'Tell me which order or item this is about and I will point you to the right person — or I can pass you to our support team.',
        fr: "Dites-moi de quelle commande ou de quel article il s'agit et je vous orienterai vers la bonne personne — ou je peux vous mettre en relation avec notre support.",
        pt: 'Diga-me a que encomenda ou artigo se refere e eu indico a pessoa certa — ou posso encaminhá-lo para o nosso apoio ao cliente.',
        es: 'Dime a qué pedido o artículo se refiere y te indicaré con quién hablar — o puedo pasarte con nuestro soporte.',
        ar: 'أخبرني بالطلب أو المنتج المقصود وسأرشدك إلى الشخص المناسب، أو يمكنني تحويلك إلى فريق الدعم.',
    },
    [ERROR_CODES.BOT_SUPPORT_SCOPE_UNAVAILABLE]: {
        en: 'I do not have those contact details for this one yet. I can share the contacts I do have, or pass you to our support team.',
        fr: "Je n'ai pas encore ces coordonnées pour celui-ci. Je peux vous donner celles que j'ai, ou vous mettre en relation avec notre support.",
        pt: 'Ainda não tenho esses contactos para este caso. Posso partilhar os que tenho, ou encaminhá-lo para o nosso apoio ao cliente.',
        es: 'Todavía no tengo esos datos de contacto para este caso. Puedo darte los que sí tengo, o pasarte con nuestro soporte.',
        ar: 'لا تتوفر لديّ بيانات التواصل هذه بعد لهذه الحالة. يمكنني إعطاؤك ما لديّ، أو تحويلك إلى فريق الدعم.',
    },

    // ── Bookings (MCP parity step 4) ─────────────────────────────────────────
    //
    // ⚠ **The `conflict` category fallback is "That has already changed. Let me check
    // where things stand and try again." — and for this family it is WRONG in two
    // different ways.** For a slot that is gone it invites a retry that cannot succeed
    // however many times it runs; for a live charge it invites a SECOND payment prompt on
    // somebody's handset. Both earn an entry by the test above: the customer does
    // something different, and what the fallback tells them to do is the wrong thing.
    [ERROR_CODES.BOOKING_SLOT_UNAVAILABLE]: {
        en: 'That time was taken while we were talking. Shall I show you what is still free?',
        fr: "Ce créneau a été pris pendant notre conversation. Voulez-vous voir ce qui reste ?",
        pt: 'Esse horário foi ocupado enquanto conversávamos. Quer ver o que ainda está livre?',
        es: 'Esa hora se ocupó mientras hablábamos. ¿Le muestro lo que queda libre?',
        ar: 'حُجز هذا الموعد أثناء حديثنا. هل أعرض عليك المواعيد المتاحة؟',
    },
    [ERROR_CODES.BOOKING_SLOT_LOCKED]: {
        en: 'Someone else is booking that time right now. Shall I show you another?',
        fr: "Quelqu'un d'autre est en train de réserver ce créneau. Voulez-vous en voir un autre ?",
        pt: 'Outra pessoa está reservando esse horário agora. Quer ver outro?',
        es: 'Otra persona está reservando esa hora ahora mismo. ¿Le muestro otra?',
        ar: 'هناك شخص آخر يحجز هذا الموعد الآن. هل أعرض عليك موعدًا آخر؟',
    },
    [ERROR_CODES.BOOKING_SLOT_FULL]: {
        en: 'The last place at that time has gone. Shall I show you another?',
        fr: "La dernière place à ce créneau est partie. Voulez-vous en voir un autre ?",
        pt: 'A última vaga nesse horário acabou. Quer ver outro?',
        es: 'Se ha ido la última plaza a esa hora. ¿Le muestro otra?',
        ar: 'نفد آخر مكان في هذا الموعد. هل أعرض عليك موعدًا آخر؟',
    },
    [ERROR_CODES.BOOKING_NOT_RESCHEDULABLE]: {
        en: 'That appointment can no longer be moved. I can help you book a new one.',
        fr: "Ce rendez-vous ne peut plus être déplacé. Je peux vous aider à en réserver un nouveau.",
        pt: 'Esse agendamento não pode mais ser movido. Posso ajudar a marcar um novo.',
        es: 'Esa cita ya no se puede mover. Puedo ayudarle a reservar una nueva.',
        ar: 'لم يعد بالإمكان تغيير موعد هذا الحجز. يمكنني مساعدتك في حجز موعد جديد.',
    },
    // ⚠ The dangerous one. "Try again" here is a second charge on a real handset.
    [ERROR_CODES.PAYMENT_BOOKING_IN_PROGRESS]: {
        en: 'A payment for that is already going through. Please check your phone rather than paying again.',
        fr: "Un paiement est déjà en cours pour cela. Vérifiez votre téléphone plutôt que de payer à nouveau.",
        pt: 'Já existe um pagamento em andamento para isso. Verifique o seu telefone em vez de pagar de novo.',
        es: 'Ya hay un pago en curso para eso. Revise su teléfono en lugar de volver a pagar.',
        ar: 'هناك عملية دفع جارية بالفعل لهذا الحجز. يرجى التحقق من هاتفك بدلًا من الدفع مرة أخرى.',
    },
    [ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID]: {
        en: 'That appointment is already paid for. There is nothing left to pay.',
        fr: "Ce rendez-vous est déjà payé. Il n'y a plus rien à régler.",
        pt: 'Esse agendamento já está pago. Não há mais nada a pagar.',
        es: 'Esa cita ya está pagada. No queda nada por pagar.',
        ar: 'تم دفع قيمة هذا الحجز بالفعل. لا يوجد ما يستوجب الدفع.',
    },
    [ERROR_CODES.BOOKING_NO_BALANCE_DUE]: {
        en: 'There is nothing outstanding on that appointment.',
        fr: "Il n'y a rien à régler sur ce rendez-vous.",
        pt: 'Não há nada pendente nesse agendamento.',
        es: 'No hay nada pendiente en esa cita.',
        ar: 'لا يوجد أي مبلغ مستحق على هذا الحجز.',
    },
    // ── Retryable machinery ──────────────────────────────────────────────────
    // The three idempotency refusals are the automation layer's business, not the
    // customer's — but if one does reach a chat window it must not read as a rejection of
    // something they did. "Still working on it" is true of all three.
    [ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS]: {
        en: 'I am still working on that. Give me a moment.',
        fr: "Je m'en occupe encore. Un instant.",
        pt: 'Ainda estou tratando disso. Um momento.',
        es: 'Todavía estoy con eso. Un momento.',
        ar: 'ما زلت أعمل على ذلك. لحظة من فضلك.',
    },
    [ERROR_CODES.BOT_IDEMPOTENCY_STORE_UNAVAILABLE]: {
        en: 'I could not complete that just now. Please try again in a moment.',
        fr: "Je n'ai pas pu terminer cela maintenant. Réessayez dans un instant.",
        pt: 'Não consegui concluir isso agora. Tente novamente em instantes.',
        es: 'No he podido completar eso ahora. Inténtalo de nuevo en un momento.',
        ar: 'لم أتمكن من إتمام ذلك الآن. يرجى المحاولة مرة أخرى بعد قليل.',
    },

    // ── Contact changes (MCP parity step 6) ──────────────────────────────────
    //
    // ⚠ **Three of the six contact-change codes earn an entry and three do not**, by the
    // test at the top of this table. `CONTACT_CHANGE_SAME_IDENTIFIER` and
    // `CONTACT_CHANGE_IDENTIFIER_TAKEN` are `validation`/`conflict` and their fallbacks
    // already say the only true thing ("that does not look right" / "that has already
    // changed"); `CONTACT_CHANGE_TOKEN_INVALID` is raised on a path a chat never touches,
    // because the email confirm is a storefront page. The three below are the ones where
    // the fallback would send a customer to do the WRONG thing.

    /**
     * The `business_rule` fallback is *"that is not something I can do right now"* — which
     * invites waiting, and waiting is exactly what will not help: the number is proved by
     * CONNECTING it, and nothing happens until the customer does.
     */
    [ERROR_CODES.CONTACT_CHANGE_PHONE_UNPROVEN]: {
        en: 'I cannot confirm that number yet. Write to us on WhatsApp from it and connect it first, then ask me again.',
        fr: "Je ne peux pas encore confirmer ce numéro. Écrivez-nous sur WhatsApp depuis ce numéro et connectez-le, puis redemandez-moi.",
        pt: 'Ainda não posso confirmar esse número. Escreva-nos no WhatsApp a partir dele e ligue-o primeiro, depois peça-me de novo.',
        es: 'Todavía no puedo confirmar ese número. Escríbenos por WhatsApp desde él y conéctalo primero, luego pídemelo de nuevo.',
        ar: 'لا أستطيع تأكيد ذلك الرقم بعد. راسلنا على واتساب منه واربطه أولًا، ثم اطلب مني مرة أخرى.',
    },
    /**
     * The `conflict` fallback is *"that has already changed — let me check where things
     * stand and try again"*, and a retry here can never succeed: there is nothing pending,
     * so the remedy is to START one.
     */
    [ERROR_CODES.CONTACT_CHANGE_NOT_PENDING]: {
        en: 'There is no change waiting on your account. Tell me the new address or number and I will start one.',
        fr: "Aucun changement n'est en attente sur votre compte. Donnez-moi la nouvelle adresse ou le nouveau numéro et je le lance.",
        pt: 'Não há nenhuma alteração pendente na sua conta. Diga-me o novo e-mail ou número e eu inicio uma.',
        es: 'No hay ningún cambio pendiente en tu cuenta. Dime el nuevo correo o número y lo empiezo.',
        ar: 'لا يوجد تغيير قيد الانتظار على حسابك. أخبرني بالبريد أو الرقم الجديد وسأبدأ العملية.',
    },
    [ERROR_CODES.CONTACT_CHANGE_EXPIRED]: {
        en: 'That change took too long and has expired. Tell me the new address or number again and I will start over.',
        fr: "Ce changement a expiré. Redonnez-moi la nouvelle adresse ou le nouveau numéro et je recommence.",
        pt: 'Essa alteração demorou demasiado e expirou. Diga-me de novo o e-mail ou número e eu recomeço.',
        es: 'Ese cambio ha tardado demasiado y ha caducado. Dime otra vez el correo o el número y vuelvo a empezar.',
        ar: 'استغرق ذلك التغيير وقتًا طويلًا وانتهت صلاحيته. أخبرني بالبريد أو الرقم الجديد مرة أخرى وسأبدأ من جديد.',
    },

    // ── Connections and account closure (MCP parity step 7) ──────────────────

    /**
     * The one refusal this surface adds over the customer API. It earns an entry because
     * the remedy is a DIFFERENT PLACE — the storefront, where the session does not depend
     * on the connection being removed — and no category sentence can say that.
     */
    [ERROR_CODES.BOT_CONNECTION_ACTIVE_CHANNEL]: {
        en: 'I cannot disconnect the app we are talking in — I would not be able to reach you. You can do it from your account page on the website.',
        fr: "Je ne peux pas déconnecter l'application dans laquelle nous discutons — je ne pourrais plus vous joindre. Vous pouvez le faire depuis votre compte sur le site.",
        pt: 'Não posso desligar a aplicação em que estamos a falar — deixaria de conseguir contactá-lo. Pode fazê-lo na sua conta no site.',
        es: 'No puedo desconectar la aplicación en la que estamos hablando — dejaría de poder contactarte. Puedes hacerlo desde tu cuenta en la web.',
        ar: 'لا يمكنني فصل التطبيق الذي نتحدث فيه — لن أستطيع الوصول إليك بعدها. يمكنك فعل ذلك من صفحة حسابك على الموقع.',
    },
    /**
     * Both closure refusals earn an entry, and for the same reason: a customer who asked to
     * close their account and is told *"that is not something I can do right now"* has been
     * told nothing about a decision that is theirs to make. The details are deliberately
     * NOT interpolated — `details.blockingRoles` and `details.activeOrderCount` ride the
     * envelope for the flow to use, and a sentence with a number in it is a sentence that
     * needs five plural rules.
     */
    [ERROR_CODES.ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE]: {
        en: 'This account also sells or delivers on the platform, so I cannot close it from here. Our support team can help.',
        fr: "Ce compte sert aussi à vendre ou à livrer sur la plateforme, je ne peux donc pas le fermer d'ici. Notre support peut vous aider.",
        pt: 'Esta conta também vende ou entrega na plataforma, por isso não a posso encerrar aqui. A nossa equipa de apoio pode ajudar.',
        es: 'Esta cuenta también vende o entrega en la plataforma, así que no puedo cerrarla desde aquí. Nuestro equipo de soporte puede ayudarte.',
        ar: 'يُستخدم هذا الحساب أيضًا للبيع أو التوصيل على المنصة، لذا لا يمكنني إغلاقه من هنا. يمكن لفريق الدعم مساعدتك.',
    },
    [ERROR_CODES.ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT]: {
        en: 'You still have orders on the way. I can close your account once they have arrived — otherwise we would have no way to reach you about them.',
        fr: "Vous avez encore des commandes en cours. Je pourrai fermer votre compte une fois qu'elles seront arrivées — sinon nous n'aurions aucun moyen de vous joindre à leur sujet.",
        pt: 'Ainda tem encomendas a caminho. Posso encerrar a sua conta assim que chegarem — de outro modo não teríamos como o contactar sobre elas.',
        es: 'Todavía tienes pedidos en camino. Puedo cerrar tu cuenta cuando hayan llegado — de lo contrario no tendríamos forma de contactarte sobre ellos.',
        ar: 'لا تزال لديك طلبات في الطريق. يمكنني إغلاق حسابك بعد وصولها — وإلا فلن تكون لدينا وسيلة للتواصل معك بشأنها.',
    },
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sentence to relay to the customer, for any code, in any language. Never empty.
 *
 * Three tiers, first match wins: the per-code entry in the requested language, that entry
 * in English, then the category sentence. There is deliberately no fourth tier and no path
 * that returns the code — a raw `BOT_IDENTITY_UNRESOLVED` in a chat window is the exact
 * failure this function exists to make impossible.
 */
export function customerMessageFor(
    code: string,
    category: ErrorCategory,
    language: string | null | undefined,
): string {
    const lang = toBotCopyLanguage(language);
    const specific = CODE_COPY[code as ErrorCode];

    if (specific) return specific[lang] ?? specific[DEFAULT_LANGUAGE];

    const fallback = CATEGORY_COPY[category] ?? CATEGORY_COPY[ERROR_CATEGORIES.INTERNAL];
    return fallback[lang] ?? fallback[DEFAULT_LANGUAGE];
}

/**
 * Refuse to boot on a half-translated entry.
 *
 * The same startup completeness assert all four notification stacks run, and for the same
 * reason: a missing language is invisible until a customer who reads it hits that exact
 * error, at which point they get English and nobody finds out. Called from `lifecycle.ts`
 * beside the other boot assertions.
 *
 * A bare `Error` — this runs before any request exists and the only correct outcome is that
 * the process does not start.
 */
export function assertBotErrorCopyComplete(): void {
    const gaps: string[] = [];

    const check = (label: string, copy: Copy): void => {
        for (const lang of BOT_COPY_LANGUAGES) {
            if (typeof copy[lang] !== 'string' || copy[lang].trim().length === 0) {
                gaps.push(`${label}:${lang}`);
            }
        }
    };

    for (const [category, copy] of Object.entries(CATEGORY_COPY)) check(`category ${category}`, copy);
    for (const [code, copy] of Object.entries(CODE_COPY)) check(`code ${code}`, copy as Copy);

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] bot error copy is missing translations: ${gaps.join(', ')}`);
    }
}

/** Exported for `test:bot-surface`, which asserts coverage and the no-code-leaks rule. */
export const __BOT_ERROR_COPY = Object.freeze({ CATEGORY_COPY, CODE_COPY });
