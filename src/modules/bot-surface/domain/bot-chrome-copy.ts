import { BOT_COPY_LANGUAGES, BotCopyLanguage, toBotCopyLanguage } from './bot-error-copy';

/**
 * The words that are BUTTONS rather than sentences — a keyboard label, a list header, the
 * text on a call-to-action.
 *
 * ── WHY THIS IS A THIRD COPY TABLE AND NOT A GROWTH OF THE OTHER TWO ────────
 * `bot-error-copy.ts` words a failure and `bot-onboarding-copy.ts` words a question. Both
 * produce a SENTENCE the customer reads in the message body. What is here is chrome: text
 * that is rendered by the messaging client as a control, is subject to that client's own
 * length caps (WhatsApp truncates a reply-button title at 20 characters and a list row at
 * 24 — `WA_LIMITS`), and has no meaning at all outside the widget it labels.
 *
 * Keeping it separate is what makes those caps checkable. A sentence has no cap and a
 * button does; mixing them means either a boot assert that cannot be written or a caption
 * that arrives cut in half on one channel and intact on the other.
 *
 * ── IT EXISTS BECAUSE THE WALKTHROUGH ADMITTED THE GAP IN WRITING ───────────
 * `api-doc/n8n/TELEGRAM-ONBOARDING-WALKTHROUGH.md` used to tell the automation layer:
 * *"The button's own label is the one string you must supply, because it is Telegram chrome
 * rather than a message. Key it off `identity.language` from a four-entry table in the
 * workflow."*
 *
 * That is the same premise `bot-error-copy.ts` was written to correct, arriving by a third
 * door: **the automation layer has no copy table.** One four-entry table in an n8n
 * expression is one table nobody translates, nobody reviews and nobody notices has gone
 * stale — and it sits on the single most important turn in the whole product, the one where
 * a stranger decides whether to hand over their phone number.
 *
 * The rule is now complete rather than nearly complete: **every character the customer
 * sees is written here, body and chrome alike.**
 */

type Copy = Record<BotCopyLanguage, string>;

/**
 * The Telegram `request_contact` button.
 *
 * The emoji is part of the label rather than prepended by the renderer: a button that
 * carries one on Telegram and not on WhatsApp would be two designs, and the renderer's job
 * is to place text, never to decorate it.
 */
const CONTACT_BUTTON: Copy = {
    en: '📱 Share my number',
    fr: '📱 Partager mon numéro',
    pt: '📱 Partilhar o meu número',
    es: '📱 Compartir mi número',
    ar: '📱 مشاركة رقمي',
};

/**
 * The question above a list of address candidates.
 *
 * ⚠ **Deliberately says nothing about addresses.** It labels a CHOICE, and the address
 * picker is simply the first thing that needed one. A payment-method picker and a
 * "which order did you mean" picker are the same widget with different rows, and a
 * sentence naming addresses would have to be replaced rather than reused on the day one of
 * those lands.
 */
const CHOOSE_PROMPT: Copy = {
    en: 'Which one is right?',
    fr: 'Laquelle est la bonne ?',
    pt: 'Qual é a correta?',
    es: '¿Cuál es la correcta?',
    ar: 'أيٌّ منها الصحيح؟',
};

/** WhatsApp's list-open button. `WA_LIMITS.LIST_BUTTON` is 20 characters. */
const CHOOSE_LIST_BUTTON: Copy = {
    en: 'Choose',
    fr: 'Choisir',
    pt: 'Escolher',
    es: 'Elegir',
    ar: 'اختر',
};

/** WhatsApp's list section heading. `WA_LIMITS.LIST_SECTION_TITLE` is 24 characters. */
const CHOOSE_SECTION_TITLE: Copy = {
    en: 'Options',
    fr: 'Options',
    pt: 'Opções',
    es: 'Opciones',
    ar: 'الخيارات',
};

/**
 * Decline an optional step.
 *
 * ⚠ **This label replaced a WORD THE CUSTOMER HAD TO TYPE.** The prompts used to end with
 * *"just say \"skip\" if you would rather not"*, which meant a French customer typed
 * *« passer »* and something downstream had to know that five spellings are one intent —
 * in the layer with no copy table. The label is translated; the id it carries
 * (`skipActionId`) is not. `WA_LIMITS.BUTTON_REPLY_TITLE` is 20 characters.
 */
const SKIP_BUTTON: Copy = {
    en: 'Skip',
    fr: 'Passer',
    pt: 'Saltar',
    es: 'Omitir',
    ar: 'تخطٍّ',
};

/** The body above a payment link. */
const PAY_PROMPT: Copy = {
    en: 'Tap below to pay securely.',
    fr: 'Appuyez ci-dessous pour payer en toute sécurité.',
    pt: 'Toque abaixo para pagar em segurança.',
    es: 'Toca abajo para pagar de forma segura.',
    ar: 'اضغط أدناه للدفع بأمان.',
};

/** The payment button. `WA_LIMITS.CTA_DISPLAY_TEXT` is 20 characters. */
const PAY_BUTTON: Copy = {
    en: 'Pay now',
    fr: 'Payer maintenant',
    pt: 'Pagar agora',
    es: 'Pagar ahora',
    ar: 'ادفع الآن',
};

/**
 * What to say when the ASSISTANT cannot answer — the model errored, timed out, or came back
 * with nothing.
 *
 * ⚠ **This is a sentence, not a control**, like `choosePrompt` and `payPrompt` beside it. It
 * is here rather than in `bot-error-copy.ts` because that table is keyed on an error CODE
 * this service raised, and this failure happens in the automation layer — there is no code,
 * no request and no response to attach it to. It reaches the caller on the sync payload
 * (`BotSyncDto.fallback`) precisely so the one layer that cannot translate does not have to.
 *
 * ⚠ **It is NOT the "onboarding finished" turn.** That one deliberately says nothing at all
 * — see `setOnboardingReply`, which explains why a cheerful "all done!" would talk over the
 * model. This is the opposite situation: the model is what failed, so something must be said
 * in its place.
 */
const ASSISTANT_UNAVAILABLE: Copy = {
    en: 'Sorry, I could not answer that just now. Please try again in a moment.',
    fr: "Désolé, je n'ai pas pu répondre à l'instant. Veuillez réessayer dans un moment.",
    pt: 'Desculpe, não consegui responder agora. Tente novamente dentro de momentos.',
    es: 'Lo siento, no he podido responder ahora. Inténtalo de nuevo en un momento.',
    ar: 'عذرًا، لم أتمكّن من الإجابة الآن. يُرجى المحاولة بعد قليل.',
};

/**
 * The Telegram `request_location` button.
 *
 * ⚠ **Telegram only.** WhatsApp's `location_request_message` draws its own button and takes
 * no label at all, so this string is never sent there — the same asymmetry `contactButton`
 * has, one control further on.
 */
const LOCATION_BUTTON: Copy = {
    en: '📍 Send my location',
    fr: '📍 Envoyer ma position',
    pt: '📍 Enviar localização',
    es: '📍 Enviar mi ubicación',
    ar: '📍 إرسال موقعي',
};

/**
 * What to say when an address search matched NOTHING.
 *
 * ⚠ **This closes a real silence.** `pickerFor` returns `null` on zero candidates, so the
 * turn carried no `reply` at all and the customer — who had just been asked where to deliver
 * — was answered with nothing. Observed live on 2026-09-06: a customer typed *"My address"*,
 * got five unrelated districts, said so, and the conversation stopped dead.
 *
 * It names what to do differently rather than apologising, because the customer usually typed
 * something a geocoder cannot use ("my address", "home") and the remedy is specificity.
 */
const ADDRESS_NOT_FOUND: Copy = {
    en: 'I could not find that. Try a street and city, or a nearby landmark.',
    fr: "Je n'ai pas trouvé. Essayez une rue et une ville, ou un point de repère proche.",
    pt: 'Não encontrei. Tente uma rua e cidade, ou um ponto de referência próximo.',
    es: 'No lo he encontrado. Prueba con una calle y ciudad, o un punto de referencia cercano.',
    ar: 'لم أعثر على ذلك. جرّب اسم شارع ومدينة، أو معلمًا قريبًا.',
};

/**
 * The question above what a customer's LOCATION PIN resolved to.
 *
 * ⚠ **A separate string from `choosePrompt`, and the difference is not cosmetic.** That one
 * labels a choice between things the customer described; this one labels a single row the
 * platform derived from coordinates they sent. *"Which one is right?"* asks somebody to pick
 * between alternatives that are not there — `reverse` returns exactly one candidate or none
 * (`IGeocodingProvider.reverse` is `Promise<GeoCandidate | null>`) — and a customer who
 * cannot tell whether a street name they have never written down is "right" simply stops.
 *
 * So it states what the row IS (the closest match to their pin) and tells an unsure customer
 * what to do. It stays true if reverse ever returns several: the top row is the nearest.
 */
const CONFIRM_PIN_PROMPT: Copy = {
    en: 'Here is the closest match to your pin. Not sure? Pick the first one.',
    fr: "Voici l'adresse la plus proche de votre position. Vous hésitez ? Choisissez la première.",
    pt: 'Esta é a morada mais próxima do seu ponto. Na dúvida, escolha a primeira.',
    es: 'Esta es la dirección más cercana a tu ubicación. ¿No estás seguro? Elige la primera.',
    ar: 'هذا أقرب عنوان إلى موقعك. إن لم تكن متأكدًا، اختر الأول.',
};

/**
 * What to say after `contact_change_email` has opened a change.
 *
 * ⚠ **Names no address, on purpose.** The customer typed it a moment ago, so repeating it
 * buys nothing — and a sentence with a value in it needs interpolation, which this table
 * deliberately does not do: a placeholder is one more thing to get wrong in five languages,
 * and a half-filled one reaches the customer as `{{email}}`.
 *
 * ⚠ **The second half is the load-bearing one.** `login_email` does NOT move until the link
 * is opened, and a customer who is not told that will believe they have already changed how
 * they sign in — and then find the old address still works, which reads as a broken change.
 */
const CONTACT_EMAIL_CHANGE_STARTED: Copy = {
    en: 'I have sent a confirmation link to that address. Open it to finish the change — until you do, you still sign in with your current email.',
    fr: "J'ai envoyé un lien de confirmation à cette adresse. Ouvrez-le pour terminer le changement — d'ici là, vous vous connectez toujours avec votre adresse actuelle.",
    pt: 'Enviei um link de confirmação para esse endereço. Abra-o para concluir a alteração — até lá, continua a entrar com o seu e-mail atual.',
    es: 'He enviado un enlace de confirmación a esa dirección. Ábrelo para completar el cambio — hasta entonces, sigues entrando con tu correo actual.',
    ar: 'أرسلت رابط تأكيد إلى ذلك العنوان. افتحه لإتمام التغيير — وحتى ذلك الحين تسجّل الدخول ببريدك الحالي.',
};

/**
 * What to say after `contact_change_phone` has opened a change.
 *
 * ⚠ **This is the sentence the whole step turns on, and it states a CONSEQUENCE rather than
 * a next step.** The platform proves a new number by requiring a WhatsApp connection whose
 * identity IS that number — there is no SMS provider here, and a template message to a
 * number that has not written to us needs a credit wallet a customer does not have. So
 * "connect that number on WhatsApp" is not a nicety: it is the only path, and a customer who
 * is not told it is holding a pending change they cannot complete.
 *
 * The second half is the same guarantee the email copy makes, for the same reason:
 * `login_phone` does not move until it is proved.
 */
const CONTACT_PHONE_CHANGE_STARTED: Copy = {
    en: 'Now write to us on WhatsApp from that number and connect it, then confirm the change here. Until you do, you still sign in with your current number.',
    fr: "Écrivez-nous maintenant sur WhatsApp depuis ce numéro et connectez-le, puis confirmez le changement ici. D'ici là, vous vous connectez toujours avec votre numéro actuel.",
    pt: 'Agora escreva-nos no WhatsApp a partir desse número e ligue-o, depois confirme a alteração aqui. Até lá, continua a entrar com o seu número atual.',
    es: 'Ahora escríbenos por WhatsApp desde ese número y conéctalo, luego confirma el cambio aquí. Hasta entonces, sigues entrando con tu número actual.',
    ar: 'راسلنا الآن على واتساب من ذلك الرقم واربطه، ثم أكّد التغيير هنا. وحتى ذلك الحين تسجّل الدخول برقمك الحالي.',
};

/** What to say once `login_phone` has actually moved. */
const CONTACT_PHONE_CHANGED: Copy = {
    en: 'Your number has been changed. Use it to sign in from now on.',
    fr: 'Votre numéro a été modifié. Utilisez-le pour vous connecter désormais.',
    pt: 'O seu número foi alterado. Use-o para entrar a partir de agora.',
    es: 'Tu número ha sido cambiado. Úsalo para entrar a partir de ahora.',
    ar: 'تم تغيير رقمك. استخدمه لتسجيل الدخول من الآن فصاعدًا.',
};

/**
 * One sentence for BOTH cancels, and that is deliberate rather than lazy.
 *
 * The customer knows which one they just abandoned; naming it would need either
 * interpolation or two near-identical strings in five languages, and two strings that must
 * stay in step is how one of them goes stale.
 */
const CONTACT_CHANGE_CANCELLED: Copy = {
    en: 'That change has been cancelled. Nothing about how you sign in has moved.',
    fr: "Ce changement a été annulé. Rien n'a changé dans votre façon de vous connecter.",
    pt: 'Essa alteração foi cancelada. Nada mudou na forma como entra na sua conta.',
    es: 'Ese cambio se ha cancelado. Nada ha cambiado en cómo entras a tu cuenta.',
    ar: 'تم إلغاء ذلك التغيير. لم يتغيّر شيء في طريقة تسجيل دخولك.',
};

/** What to say once a messaging app has been unbound from the account. */
const CONNECTION_DISCONNECTED: Copy = {
    en: 'That app is no longer connected to your account.',
    fr: "Cette application n'est plus connectée à votre compte.",
    pt: 'Essa aplicação já não está ligada à sua conta.',
    es: 'Esa aplicación ya no está conectada a tu cuenta.',
    ar: 'لم يعد ذلك التطبيق مرتبطًا بحسابك.',
};

/**
 * ⭐ **The sentence a customer must read BEFORE an account is closed** — the second half of
 * ADR-A02 D-2, and the reason `account_close_preview` exists as a route at all.
 *
 * ⚠ **It says "closed" and "removed", never "deleted".** ADR-A02 D-2 is explicit that no
 * erasure obligation has been established in this market and that nothing may be described
 * to a customer as satisfying one. It also refuses to let the retention go unsaid: a person
 * who believes their orders vanish and later finds a delivery record has been misled by
 * omission, which is the failure this string exists to make impossible.
 *
 * ⚠ **Written here rather than left to the flow.** This is the single most consequential
 * sentence in the product, and the automation layer has no copy table and no translator —
 * the same argument that put `error.customerMessage` and the whole `reply` body on this
 * side of the wire, arriving for the fifth time on the one turn that cannot be taken back.
 */
const ACCOUNT_CLOSURE_PROMPT: Copy = {
    en: 'Closing your account removes your name, phone number, email address and saved addresses. Your past orders are kept as business records, without your details. This cannot be undone.',
    fr: "La fermeture de votre compte supprime votre nom, votre numéro de téléphone, votre adresse e-mail et vos adresses enregistrées. Vos commandes passées sont conservées comme documents commerciaux, sans vos coordonnées. C'est irréversible.",
    pt: 'Encerrar a sua conta remove o seu nome, número de telefone, e-mail e moradas guardadas. As suas encomendas anteriores são mantidas como registos comerciais, sem os seus dados. Isto não pode ser desfeito.',
    es: 'Cerrar tu cuenta elimina tu nombre, número de teléfono, correo electrónico y direcciones guardadas. Tus pedidos anteriores se conservan como registros comerciales, sin tus datos. Esto no se puede deshacer.',
    ar: 'إغلاق حسابك يحذف اسمك ورقم هاتفك وبريدك الإلكتروني وعناوينك المحفوظة. تُحفظ طلباتك السابقة كسجلات تجارية دون بياناتك. لا يمكن التراجع عن هذا.',
};

/** The same promise in the past tense, once the closure has committed. */
const ACCOUNT_CLOSED: Copy = {
    en: 'Your account is closed and your personal details have been removed. Your past orders are kept as business records, without your name or contact details.',
    fr: 'Votre compte est fermé et vos données personnelles ont été supprimées. Vos commandes passées sont conservées comme documents commerciaux, sans votre nom ni vos coordonnées.',
    pt: 'A sua conta está encerrada e os seus dados pessoais foram removidos. As suas encomendas anteriores são mantidas como registos comerciais, sem o seu nome nem os seus contactos.',
    es: 'Tu cuenta está cerrada y tus datos personales se han eliminado. Tus pedidos anteriores se conservan como registros comerciales, sin tu nombre ni tus datos de contacto.',
    ar: 'أُغلق حسابك وحُذفت بياناتك الشخصية. تُحفظ طلباتك السابقة كسجلات تجارية دون اسمك أو بيانات تواصلك.',
};

// ─────────────────────────────────────────────────────────────────────────────
// Product cards — the buttons under a picture, and the two sentences around them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The button that opens the Telegram Mini App.
 *
 * ⚠ **Capped at 20 even though Telegram allows 64**, because the same label is the only
 * candidate if this ever becomes a WhatsApp `cta_url`, where `WA_LIMITS.CTA_DISPLAY_TEXT` is
 * 20. Sizing it to the tighter of the two costs nothing and stops a channel-specific second
 * string being written later.
 *
 * It says what the customer will SEE, not what will happen technically. "Open Mini App" names
 * a Telegram feature; "Browse the products" names the thing they asked for.
 */
const BROWSE_PRODUCTS_BUTTON: Copy = {
    en: 'Browse the products',
    fr: 'Voir les produits',
    pt: 'Ver os produtos',
    es: 'Ver los productos',
    ar: 'تصفح المنتجات',
};

/**
 * The message the Mini App button sits under.
 *
 * ⚠ **This is the sentence the whole Telegram path turns on**, and it is written to be read
 * *after* the model's own answer: the model has just said what it found, and this says how to
 * look at it. It names what the customer gets (pictures and prices) rather than what the
 * button is, because "open the Mini App" describes Telegram's feature and not their shopping.
 *
 * It also stands alone. A "See more" page has no model sentence above it at all, and this has
 * to make sense as the only thing in the message.
 */
const BROWSE_PRODUCTS_PROMPT: Copy = {
    en: 'Tap below to see them with pictures and prices.',
    fr: 'Appuyez ci-dessous pour les voir avec photos et prix.',
    pt: 'Toque abaixo para vê-los com fotos e preços.',
    es: 'Toca abajo para verlos con fotos y precios.',
    ar: 'اضغط أدناه لرؤيتها بالصور والأسعار.',
};

/** `WA_LIMITS.BUTTON_REPLY_TITLE` is 20 characters, and Arabic is the tight one here. */
const BUY_NOW_BUTTON: Copy = {
    en: 'Buy now',
    fr: 'Acheter',
    pt: 'Comprar',
    es: 'Comprar',
    ar: 'اشترِ الآن',
};

/**
 * ⚠ **French is 17 characters and is the reason this label is not "Add to basket".**
 * *« Ajouter au panier »* is the only natural rendering, and a longer English original would
 * have pushed it past 20 and been silently truncated by Meta into *« Ajouter au pani… »*.
 */
const ADD_TO_CART_BUTTON: Copy = {
    en: 'Add to cart',
    fr: 'Ajouter au panier',
    pt: 'Adicionar',
    es: 'Añadir',
    ar: 'أضف إلى السلة',
};

/** Next page of the same list. On WhatsApp it is a reply button; on Telegram an inline one. */
const SEE_MORE_BUTTON: Copy = {
    en: 'See more',
    fr: 'Voir plus',
    pt: 'Ver mais',
    es: 'Ver más',
    ar: 'المزيد',
};

/** Opens the product's own storefront page. A URL button on both channels. */
const DETAILS_BUTTON: Copy = {
    en: 'Details',
    fr: 'Détails',
    pt: 'Detalhes',
    es: 'Detalles',
    ar: 'التفاصيل',
};

/**
 * The line above a page of cards the PLATFORM produced rather than the model.
 *
 * ⚠ **Only ever used for a "See more" page.** The first page's intro is the model's own
 * sentence, written in the conversation it is having — this table has no idea what the
 * customer asked for and a generic "here are some products" over the top of a real answer is
 * exactly the talking-over that `setOnboardingReply` refuses to do. A later page has no such
 * sentence, because nobody asked the model anything; it is a button press.
 */
const MORE_PRODUCTS_PROMPT: Copy = {
    en: 'Here are a few more.',
    fr: 'En voici quelques autres.',
    pt: 'Aqui estão mais alguns.',
    es: 'Aquí tienes algunos más.',
    ar: 'إليك المزيد.',
};

/** Confirmation after an `add:` tap. Names no product — see `contactChangeCancelled`. */
const ADDED_TO_CART: Copy = {
    en: 'Added to your basket.',
    fr: 'Ajouté à votre panier.',
    pt: 'Adicionado ao seu carrinho.',
    es: 'Añadido a tu cesta.',
    ar: 'أُضيف إلى سلتك.',
};

/**
 * The same thing after a **Buy now** tap.
 *
 * ⚠ **It does not claim an order was placed, because none was.** Checkout on this platform
 * needs a delivery address and a payment method, and a bot-registered customer routinely has
 * neither — so the button adds the item and this sentence hands them back to the assistant
 * with the next step named. Saying "purchased" here would be a lie the customer discovers at
 * the worst possible moment.
 */
const ADDED_TO_CART_CHECKOUT: Copy = {
    en: 'Added to your basket. Say "checkout" whenever you are ready and I will take you through it.',
    fr: "Ajouté à votre panier. Dites « commander » quand vous êtes prêt et je m'occupe du reste.",
    pt: 'Adicionado ao seu carrinho. Diga "finalizar" quando estiver pronto e eu trato do resto.',
    es: 'Añadido a tu cesta. Di "pagar" cuando estés listo y te acompaño en el proceso.',
    ar: 'أُضيف إلى سلتك. قل «إتمام الطلب» متى كنت مستعدًا وسأتولى الباقي.',
};

// ─────────────────────────────────────────────────────────────────────────────
//  The rich-UI vocabulary
//
//  ⚠ **Declared in ONE pass, deliberately, including strings nothing renders yet.**
//  Several workstreams build on this table at once, in one working tree, and two sessions
//  writing one file is a lost write rather than a merge conflict. More pressingly:
//  `assertBotChromeCopyFits` runs at BOOT, so a session adding a key mid-flight and getting a
//  cap or a translation wrong stops the server for everyone. Adding them together, once, is
//  what makes the rest of the work parallel-safe.
//
//  Every string below is capped at 20 — WhatsApp's reply-button title — except where noted.
// ─────────────────────────────────────────────────────────────────────────────

/** Rung 1 of the purchase ladder. See `purchase-affordance.ts`. */
const BARGAIN_BUTTON: Copy = {
    en: 'Bargain',
    fr: 'Négocier',
    pt: 'Negociar',
    es: 'Negociar',
    ar: 'فاوض',
};

/** Rung 4 — a service. Never "Buy": the cart refuses services outright. */
const BOOK_BUTTON: Copy = {
    en: 'Book',
    fr: 'Réserver',
    pt: 'Reservar',
    es: 'Reservar',
    ar: 'احجز',
};

/**
 * What the customer is asked after tapping **Bargain**.
 *
 * ⚠ **A QUESTION, not an opening offer, and the reason is structural rather than stylistic.**
 * The bargaining agent lives in n8n; jovi-mall's negotiation surface is n8n calling *in*, and
 * there is no outbound path from here that makes the agent take a turn. So a message this
 * service pushes reaches the **customer** and does not wake the **agent** — what wakes it is
 * the customer's reply, arriving through the ordinary inbound webhook. A sentence that did not
 * invite a reply would leave the haggle waiting for a turn that never comes.
 *
 * ⚠ **No placeholder.** The product's title is composed as data above this sentence, so the
 * string stays plainly translatable and no translator has to move a token through a clause.
 */
const BARGAIN_INVITE_PROMPT: Copy = {
    en: 'Make me an offer — what would you like to pay for this?',
    fr: "Faites-moi une offre — combien voulez-vous payer pour cet article ?",
    pt: 'Faça-me uma proposta — quanto gostaria de pagar por isto?',
    es: '¿Cuánto te gustaría pagar por esto? Hazme una oferta.',
    ar: 'اعرض عليّ سعرًا — كم تودّ أن تدفع مقابل هذا؟',
};

/** What the customer is asked after tapping **Book**. Same no-placeholder rule. */
const BOOK_INVITE_PROMPT: Copy = {
    en: 'When would you like this? Tell me a day and a time.',
    fr: 'Quand le souhaitez-vous ? Indiquez-moi un jour et une heure.',
    pt: 'Quando prefere? Diga-me um dia e uma hora.',
    es: '¿Para cuándo lo quieres? Dime un día y una hora.',
    ar: 'متى تريد ذلك؟ أخبرني باليوم والوقت.',
};

// ── Orders and fulfilment ────────────────────────────────────────────────────

/**
 * The sentence above "See all" when `open:ol` is tapped — the whole order history.
 *
 * ⚠ **Replaces `loadMoreRow` doing a body's job.** That key is a WhatsApp list ROW title capped at 24
 * characters, and it was being used as the message text for the order-history button.
 *
 * ⚠ **True on BOTH paths, deliberately.** In production there is no screen origin, so this sits
 * above a storefront link rather than a screen — "tap below to see" is honest either way, where
 * "open your order screen" would be false in production today. Same shape as
 * `BROWSE_PRODUCTS_PROMPT`.
 */
const VIEW_ORDERS_PROMPT: Copy = {
    en: 'Tap below to see all your orders.',
    fr: 'Appuyez ci-dessous pour voir toutes vos commandes.',
    pt: 'Toque abaixo para ver todas as suas encomendas.',
    es: 'Toca abajo para ver todos tus pedidos.',
    ar: 'اضغط أدناه لرؤية جميع طلباتك.',
};

/** The order detail's second action. Destructive, so it opens a confirm rather than acting. */
const CANCEL_ORDER_BUTTON: Copy = {
    en: 'Cancel order',
    fr: 'Annuler',
    pt: 'Cancelar',
    es: 'Cancelar',
    ar: 'إلغاء الطلب',
};

/**
 * ⚠ **A two-answer question that is collected as FREE TEXT today**, in five languages, which
 * is why it earns a pair of buttons more than almost anything else on this surface.
 */
const CONFIRM_DELIVERY_PROMPT: Copy = {
    en: 'Did your parcel arrive?',
    fr: 'Avez-vous bien reçu votre colis ?',
    pt: 'A sua encomenda chegou?',
    es: '¿Te llegó tu paquete?',
    ar: 'هل وصلك طردك؟',
};

/** The confirm in front of a cancellation. Never cancels on the first tap. */
const CANCEL_ORDER_PROMPT: Copy = {
    en: 'Cancel this order? This cannot be undone.',
    fr: 'Annuler cette commande ? Cette action est définitive.',
    pt: 'Cancelar esta encomenda? Não é possível desfazer.',
    es: '¿Cancelar este pedido? No se puede deshacer.',
    ar: 'إلغاء هذا الطلب؟ لا يمكن التراجع عن ذلك.',
};

/**
 * ⚠ **The reason is TYPED, never picked from a list.** Owner's decision: a canned reason tells
 * the vendor less than a sentence does, and the list would have to guess at the cases.
 */
// ─────────────────────────────────────────────────────────────────────────────
//  Discovery and bargaining (Stream B)
// ─────────────────────────────────────────────────────────────────────────────

const SIMILAR_ITEMS_BUTTON: Copy = {
    en: 'Similar items',
    fr: 'Articles similaires',
    pt: 'Artigos semelhantes',
    es: 'Artículos similares',
    ar: 'منتجات مشابهة',
};

/** ⛔ Owner's decision: this REPLACES "Notify me". Nothing here can announce a restock. */
const SAVE_FOR_LATER_BUTTON: Copy = {
    en: 'Save for later',
    fr: 'Mettre de côté',
    pt: 'Guardar para depois',
    es: 'Guardar para luego',
    ar: 'احفظه لوقت لاحق',
};

const READ_ALL_REVIEWS_BUTTON: Copy = {
    en: 'Read all reviews',
    fr: 'Lire tous les avis',
    pt: 'Ler as opiniões',
    es: 'Leer las opiniones',
    ar: 'اقرأ كل التقييمات',
};

const BARGAIN_AGAIN_BUTTON: Copy = {
    en: 'Bargain again',
    fr: 'Renégocier',
    pt: 'Negociar de novo',
    es: 'Negociar de nuevo',
    ar: 'فاوض مجددًا',
};

/**
 * ⚠ **`cap: null`, and that is measured rather than lax.** It is never a whole control title:
 * Telegram draws `"<label> · <price>"`, which has no 20-character limit, and WhatsApp draws the
 * option's `shortLabel` (`"✓ <price>"`). So the price is on the button the customer presses on
 * both channels, and capping the label would cut the label rather than the price.
 */
const LOCK_IT_IN_BUTTON: Copy = {
    en: 'Lock it in',
    fr: 'Je valide',
    pt: 'Fechar negócio',
    es: 'Cerrar trato',
    ar: 'ثبّت السعر',
};

const BROWSE_CATEGORIES_PROMPT: Copy = {
    en: 'What kind of thing are you looking for?',
    fr: "Quel genre d'article cherchez-vous ?",
    pt: 'Que tipo de artigo procura?',
    es: '¿Qué tipo de artículo buscas?',
    ar: 'ما نوع المنتج الذي تبحث عنه؟',
};

const NO_CATEGORIES_PROMPT: Copy = {
    en: "There's nothing listed yet. Tell me what you're after and I'll look.",
    fr: "Rien n'est encore en vente. Dites-moi ce que vous cherchez et je regarde.",
    pt: 'Ainda não há nada à venda. Diga-me o que procura e eu procuro.',
    es: 'Todavía no hay nada a la venta. Dime qué buscas y lo miro.',
    ar: 'لا توجد منتجات معروضة بعد. أخبرني بما تبحث عنه وسأبحث لك.',
};

/** A tapped category that has since emptied. The grid of everything follows. */
const CATEGORY_GONE_PROMPT: Copy = {
    en: "That category has nothing in it any more. Here's everything instead.",
    fr: 'Cette catégorie est désormais vide. Voici tout le reste à la place.',
    pt: 'Essa categoria já não tem nada. Aqui está tudo o resto.',
    es: 'Esa categoría ya no tiene nada. Aquí tienes todo lo demás.',
    ar: 'لم يعد في هذه الفئة أي منتج. إليك كل المنتجات بدلًا من ذلك.',
};

/**
 * ⚠ **Not `moreProductsPrompt`.** "Here are some more" is true after a See-more tap and wrong
 * after a Similar-items tap: the customer asked for things LIKE the one they were looking at,
 * not for more of a list they were paging.
 */
const SIMILAR_ITEMS_PROMPT: Copy = {
    en: 'Here are some similar items.',
    fr: 'Voici des articles similaires.',
    pt: 'Aqui estão alguns artigos semelhantes.',
    es: 'Aquí tienes algunos artículos similares.',
    ar: 'إليك بعض المنتجات المشابهة.',
};

const NO_SIMILAR_ITEMS_PROMPT: Copy = {
    en: "I couldn't find anything similar right now.",
    fr: "Je n'ai rien trouvé de similaire pour le moment.",
    pt: 'Não encontrei nada semelhante de momento.',
    es: 'No he encontrado nada similar por ahora.',
    ar: 'لم أجد شيئًا مشابهًا في الوقت الحالي.',
};

/** ⛔ Must not imply a restock message will ever arrive (owner's decision). */
const SAVED_FOR_LATER_PROMPT: Copy = {
    en: "Saved. You'll find it in your saved items.",
    fr: "C'est noté. Vous le retrouverez dans vos articles enregistrés.",
    pt: 'Guardado. Vai encontrá-lo nos seus artigos guardados.',
    es: 'Guardado. Lo encontrarás en tus artículos guardados.',
    ar: 'تم الحفظ. ستجده ضمن المنتجات المحفوظة لديك.',
};

const NO_REVIEWS_YET_PROMPT: Copy = {
    en: 'No one has reviewed this yet.',
    fr: "Personne n'a encore laissé d'avis sur cet article.",
    pt: 'Ainda ninguém deixou uma opinião sobre este artigo.',
    es: 'Nadie ha opinado todavía sobre este artículo.',
    ar: 'لم يقيّم أحد هذا المنتج بعد.',
};

/** Followed by `addedToCartActions` — a won bargain lands exactly like an ordinary add. */
const DEAL_LOCKED_PROMPT: Copy = {
    en: "Deal — it's in your basket at that price.",
    fr: 'Marché conclu — c\'est dans votre panier à ce prix.',
    pt: 'Negócio fechado — está no seu cesto a esse preço.',
    es: 'Trato hecho — ya está en tu cesta a ese precio.',
    ar: 'تم الاتفاق — أُضيف إلى سلتك بهذا السعر.',
};

/** The pressed offer was replaced; the latest offer's button follows. */
const DEAL_SUPERSEDED_PROMPT: Copy = {
    en: "That offer has changed since. Here's the latest one.",
    fr: 'Cette offre a changé depuis. Voici la plus récente.',
    pt: 'Essa oferta mudou entretanto. Aqui está a mais recente.',
    es: 'Esa oferta ha cambiado. Aquí tienes la más reciente.',
    ar: 'تغيّر هذا العرض منذ ذلك الحين. إليك أحدث عرض.',
};

const DEAL_ALREADY_ORDERED_PROMPT: Copy = {
    en: "You've already ordered this at the agreed price.",
    fr: 'Vous avez déjà commandé cet article au prix convenu.',
    pt: 'Já encomendou este artigo ao preço combinado.',
    es: 'Ya pediste este artículo al precio acordado.',
    ar: 'لقد طلبت هذا المنتج بالفعل بالسعر المتفق عليه.',
};

/** Bargain again follows. */
const DEAL_UNAVAILABLE_PROMPT: Copy = {
    en: "I can't find that offer any more. Want to talk about the price again?",
    fr: 'Je ne retrouve plus cette offre. Voulez-vous rediscuter du prix ?',
    pt: 'Já não encontro essa oferta. Quer voltar a falar sobre o preço?',
    es: 'Ya no encuentro esa oferta. ¿Quieres que volvamos a hablar del precio?',
    ar: 'لم أعد أجد هذا العرض. هل تريد أن نتحدث عن السعر مرة أخرى؟',
};

/**
 * ⛔ **An expired deal must never read as though it never happened** (the owner's rule), which
 * is why neither this nor the next is a fresh "would you like to haggle?" — both name what
 * lapsed. Neither promises anything about the basket: at the moment they render, the item is
 * not in it, and the model may be about to add it at the shelf price.
 *
 * ⚠ Neither names a seller. `bargaining-agent.md` § 11 records the agent inventing a human
 * seller and the prompt being rewritten to stop it; there is no human in this loop.
 */
const BARGAIN_LOCK_EXPIRED_PROMPT: Copy = {
    en: 'The price we agreed has run out. Want to talk about it again?',
    fr: 'Le prix convenu a expiré. Voulez-vous en rediscuter ?',
    pt: 'O preço combinado expirou. Quer voltar a falar sobre ele?',
    es: 'El precio acordado ha caducado. ¿Quieres que lo hablemos otra vez?',
    ar: 'انتهت صلاحية السعر الذي اتفقنا عليه. هل تريد أن نتحدث عنه مرة أخرى؟',
};

const BARGAIN_PRICE_CHANGED_PROMPT: Copy = {
    en: 'This price has changed since we agreed it. Want to talk about it again?',
    fr: 'Ce prix a changé depuis notre accord. Voulez-vous en rediscuter ?',
    pt: 'Este preço mudou desde o nosso acordo. Quer voltar a falar sobre ele?',
    es: 'Este precio ha cambiado desde nuestro acuerdo. ¿Quieres que lo hablemos otra vez?',
    ar: 'تغيّر هذا السعر منذ اتفاقنا. هل تريد أن نتحدث عنه مرة أخرى؟',
};

// ─────────────────────────────────────────────────────────────────────────────
//  The account surface (Stream H)
//
//  ⚠ **The menu is ONE list of eight** (the owner's decision), which forces every row title
//  to the 24-character WhatsApp list cap rather than the 20-character button cap: eight
//  options cannot be buttons, because a WhatsApp message carries three.
//
//  ⚠ **Nothing here interpolates**, the rule this whole table keeps. Where a value must
//  appear — the name of the app being disconnected, the site and code in a sign-in message —
//  the handler puts it on its own line ABOVE the fixed sentence. A placeholder inside a
//  translated sentence is a word order decision made by whoever wrote the English.
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_MENU_PROMPT: Copy = {
    en: 'What would you like to see?',
    fr: 'Que voulez-vous consulter ?',
    pt: 'O que quer ver?',
    es: '¿Qué quieres ver?',
    ar: 'ما الذي تريد الاطلاع عليه؟',
};

const ACCOUNT_ROW_PROFILE: Copy = {
    en: 'My details',
    fr: 'Mes informations',
    pt: 'Os meus dados',
    es: 'Mis datos',
    ar: 'بياناتي',
};

const ACCOUNT_ROW_ADDRESSES: Copy = {
    en: 'My addresses',
    fr: 'Mes adresses',
    pt: 'As minhas moradas',
    es: 'Mis direcciones',
    ar: 'عناويني',
};

const ACCOUNT_ROW_PAYMENTS: Copy = {
    en: 'Payment methods',
    fr: 'Moyens de paiement',
    pt: 'Formas de pagamento',
    es: 'Métodos de pago',
    ar: 'طرق الدفع',
};

const ACCOUNT_ROW_NOTIFY_SETTINGS: Copy = {
    en: 'Notification settings',
    fr: 'Réglages des alertes',
    pt: 'Definições de avisos',
    es: 'Ajustes de avisos',
    ar: 'إعدادات الإشعارات',
};

const ACCOUNT_ROW_INBOX: Copy = {
    en: 'Recent notifications',
    fr: 'Alertes récentes',
    pt: 'Avisos recentes',
    es: 'Avisos recientes',
    ar: 'أحدث الإشعارات',
};

const ACCOUNT_ROW_CHANNELS: Copy = {
    en: 'Connected apps',
    fr: 'Applications liées',
    pt: 'Aplicações ligadas',
    es: 'Apps conectadas',
    ar: 'التطبيقات المرتبطة',
};

const ACCOUNT_ROW_LANGUAGE: Copy = {
    en: 'Language',
    fr: 'Langue',
    pt: 'Idioma',
    es: 'Idioma',
    ar: 'اللغة',
};

const ACCOUNT_ROW_CLOSE: Copy = {
    en: 'Close my account',
    fr: 'Fermer mon compte',
    pt: 'Encerrar a minha conta',
    es: 'Cerrar mi cuenta',
    ar: 'إغلاق حسابي',
};

/** The answer to "Keep my account" — it must say that nothing happened, not merely stop. */
const ACCOUNT_KEPT: Copy = {
    en: 'Your account is staying open. Nothing has changed.',
    fr: "Votre compte reste ouvert. Rien n'a changé.",
    pt: 'A sua conta continua aberta. Nada mudou.',
    es: 'Tu cuenta sigue abierta. No ha cambiado nada.',
    ar: 'حسابك لا يزال مفتوحًا. لم يتغيّر شيء.',
};

const CONNECTIONS_PROMPT: Copy = {
    en: 'These apps can reach your account. Choose one to disconnect it.',
    fr: 'Ces applications ont accès à votre compte. Choisissez-en une pour la déconnecter.',
    pt: 'Estas aplicações têm acesso à sua conta. Escolha uma para a desligar.',
    es: 'Estas apps tienen acceso a tu cuenta. Elige una para desconectarla.',
    ar: 'هذه التطبيقات يمكنها الوصول إلى حسابك. اختر واحدًا لفصله.',
};

/**
 * ⚠ **The branch where there is nothing to offer.** The app a customer is TALKING on can
 * never be disconnected, and the set is closed at two — so a customer connected only here
 * has no choice to make, and must be told that rather than shown an empty list.
 */
const CONNECTIONS_ONLY_CURRENT: Copy = {
    en: 'This is the only app connected to your account.',
    fr: "C'est la seule application connectée à votre compte.",
    pt: 'Esta é a única aplicação ligada à sua conta.',
    es: 'Esta es la única app conectada a tu cuenta.',
    ar: 'هذا هو التطبيق الوحيد المرتبط بحسابك.',
};

/** ⚠ Says what SURVIVES, because that is the question a customer is actually asking. */
const CONNECTION_DISCONNECT_PROMPT: Copy = {
    en: 'Disconnect this app? You can connect it again at any time. Your account and your orders stay exactly as they are.',
    fr: "Déconnecter cette application ? Vous pourrez la reconnecter à tout moment. Votre compte et vos commandes restent inchangés.",
    pt: 'Desligar esta aplicação? Pode voltar a ligá-la quando quiser. A sua conta e as suas encomendas ficam como estão.',
    es: '¿Desconectar esta app? Puedes volver a conectarla cuando quieras. Tu cuenta y tus pedidos no cambian.',
    ar: 'هل تريد فصل هذا التطبيق؟ يمكنك ربطه مرة أخرى في أي وقت. يبقى حسابك وطلباتك كما هي.',
};

const DISCONNECT_BUTTON: Copy = {
    en: 'Disconnect',
    fr: 'Déconnecter',
    pt: 'Desligar',
    es: 'Desconectar',
    ar: 'فصل',
};

const KEEP_CONNECTED_BUTTON: Copy = {
    en: 'Keep connected',
    fr: 'Rester connecté',
    pt: 'Manter ligada',
    es: 'Mantener',
    ar: 'الإبقاء عليه',
};

const CONNECTION_KEPT: Copy = {
    en: 'Nothing has changed — that app is still connected.',
    fr: "Rien n'a changé — cette application est toujours connectée.",
    pt: 'Nada mudou — essa aplicação continua ligada.',
    es: 'No ha cambiado nada: esa app sigue conectada.',
    ar: 'لم يتغيّر شيء — لا يزال ذلك التطبيق مرتبطًا.',
};

const LANGUAGE_PROMPT: Copy = {
    en: 'Which language should I use?',
    fr: 'Quelle langue dois-je utiliser ?',
    pt: 'Que idioma devo usar?',
    es: '¿Qué idioma debo usar?',
    ar: 'ما اللغة التي أستخدمها؟',
};

/**
 * ⚠ **The one key rendered in the language just CHOSEN rather than the one in force**, which
 * is why each translation names its own language rather than carrying a placeholder. The five
 * options themselves are endonyms (English · Français · Português · Español · العربية) and are
 * deliberately NOT copy: a language's own name is not translated.
 */
const LANGUAGE_SET: Copy = {
    en: "I'll write in English from now on.",
    fr: "Je vous écrirai en français à partir de maintenant.",
    pt: 'A partir de agora escrevo em português.',
    es: 'A partir de ahora te escribo en español.',
    ar: 'سأكتب بالعربية من الآن فصاعدًا.',
};

const ADDRESS_BOOK_PROMPT: Copy = {
    en: 'Your saved addresses. Choose one to make it your default or to remove it.',
    fr: 'Vos adresses enregistrées. Choisissez-en une pour la définir par défaut ou la supprimer.',
    pt: 'As suas moradas guardadas. Escolha uma para a tornar padrão ou removê-la.',
    es: 'Tus direcciones guardadas. Elige una para hacerla predeterminada o eliminarla.',
    ar: 'عناوينك المحفوظة. اختر واحدًا لجعله الافتراضي أو لحذفه.',
};

const PAYMENT_METHODS_PROMPT: Copy = {
    en: 'Your saved payment methods. Choose one to make it your default or to remove it.',
    fr: 'Vos moyens de paiement enregistrés. Choisissez-en un pour le définir par défaut ou le supprimer.',
    pt: 'As suas formas de pagamento guardadas. Escolha uma para a tornar padrão ou removê-la.',
    es: 'Tus métodos de pago guardados. Elige uno para hacerlo predeterminado o eliminarlo.',
    ar: 'طرق الدفع المحفوظة لديك. اختر واحدة لجعلها الافتراضية أو لحذفها.',
};

const SET_DEFAULT_BUTTON: Copy = {
    en: 'Make default',
    fr: 'Par défaut',
    pt: 'Tornar padrão',
    es: 'Predeterminada',
    ar: 'اجعله الافتراضي',
};

const REMOVE_BUTTON: Copy = {
    en: 'Remove',
    fr: 'Supprimer',
    pt: 'Remover',
    es: 'Eliminar',
    ar: 'حذف',
};

/** ⚠ Shared by addresses and payment methods — one sentence, no ambiguity, two fewer keys. */
const DEFAULT_SET: Copy = {
    en: 'That is your default now.',
    fr: "C'est maintenant votre choix par défaut.",
    pt: 'Passou a ser o seu padrão.',
    es: 'Ahora es tu opción predeterminada.',
    ar: 'أصبح هذا خيارك الافتراضي.',
};

/** Shared, as `defaultSet` is. */
const ITEM_REMOVED: Copy = {
    en: 'Removed.',
    fr: 'Supprimé.',
    pt: 'Removido.',
    es: 'Eliminado.',
    ar: 'تم الحذف.',
};

const ADD_ADDRESS_BUTTON: Copy = {
    en: 'Add an address',
    fr: 'Ajouter une adresse',
    pt: 'Adicionar morada',
    es: 'Añadir dirección',
    ar: 'إضافة عنوان',
};

const RESEND_CODE_BUTTON: Copy = {
    en: 'Send it again',
    fr: 'Renvoyer',
    pt: 'Enviar de novo',
    es: 'Enviar de nuevo',
    ar: 'إعادة الإرسال',
};

const CANCEL_CHANGE_BUTTON: Copy = {
    en: 'Cancel change',
    fr: 'Annuler',
    pt: 'Cancelar',
    es: 'Cancelar',
    ar: 'إلغاء التغيير',
};

const CONTACT_CODE_RESENT: Copy = {
    en: 'I have sent it again.',
    fr: "Je l'ai renvoyé.",
    pt: 'Enviei de novo.',
    es: 'Te lo he enviado de nuevo.',
    ar: 'أعدت إرساله.',
};

/**
 * ⚠ **Shown AFTER the setup questions, never before** (the owner's decision). A menu offered
 * to somebody who has not finished telling us who they are interrupts the one conversation
 * they came to have.
 */
const WELCOME_PROMPT: Copy = {
    en: 'You are all set. What would you like to do?',
    fr: 'Tout est prêt. Que souhaitez-vous faire ?',
    pt: 'Está tudo pronto. O que quer fazer?',
    es: 'Todo listo. ¿Qué quieres hacer?',
    ar: 'كل شيء جاهز. ماذا تريد أن تفعل؟',
};

/**
 * The button under a booking receipt, and the only chat copy the bookings screens need here —
 * their receipt sentences live in that stream's own copy file, so one definition serves the
 * chat, the screen and the WhatsApp form without passing through this registry.
 *
 * Emits `open:bl`.
 */
const MY_BOOKINGS_BUTTON: Copy = {
    en: 'My bookings',
    fr: 'Mes réservations',
    pt: 'As minhas reservas',
    es: 'Mis reservas',
    ar: 'حجوزاتي',
};

// ── Reviews ──────────────────────────────────────────────────────────────────
/**
 * ⚠ **The star options themselves need NO copy**, and that is the point of asking with stars:
 * ★★★★★ … ★ is language-neutral, five characters, and inside WhatsApp's 24-character row title.
 * Only the three sentences around them are words.
 */
const RATE_PROMPT: Copy = {
    en: 'How was it?',
    fr: "Alors, ça s'est bien passé ?",
    pt: 'Então, correu bem?',
    es: '¿Qué tal fue?',
    ar: 'كيف كانت تجربتك؟',
};

/** Asked only when the order held SEVERAL products — one product is one tap, never a question. */
const RATE_WHICH_PRODUCT_PROMPT: Copy = {
    en: 'Which one are you rating?',
    fr: 'Lequel notez-vous ?',
    pt: 'Qual está a avaliar?',
    es: '¿Cuál estás valorando?',
    ar: 'أيّ منتج تقيّمه؟',
};

const RATE_THANKS_PROMPT: Copy = {
    en: 'Thank you — your review is in.',
    fr: 'Merci — votre avis est enregistré.',
    pt: 'Obrigado — a sua opinião foi registada.',
    es: 'Gracias — tu opinión quedó registrada.',
    ar: 'شكرًا لك — تم تسجيل تقييمك.',
};

// ── Digital downloads ────────────────────────────────────────────────────────

const DOWNLOAD_BUTTON: Copy = {
    en: 'Download',
    fr: 'Télécharger',
    pt: 'Transferir',
    es: 'Descargar',
    ar: 'تنزيل',
};

const DOWNLOADS_PROMPT: Copy = {
    en: 'Which one would you like to download?',
    fr: 'Lequel voulez-vous télécharger ?',
    pt: 'Qual deseja transferir?',
    es: '¿Cuál quieres descargar?',
    ar: 'أيّها تريد تنزيله؟',
};

const NO_DOWNLOADS_PROMPT: Copy = {
    en: 'You have nothing to download yet.',
    fr: "Vous n'avez encore rien à télécharger.",
    pt: 'Ainda não tem nada para transferir.',
    es: 'Todavía no tienes nada que descargar.',
    ar: 'لا يوجد لديك ما تنزّله بعد.',
};

/**
 * ⭐ **The expiry is stated IN WORDS, and the number is baked into the sentence rather than
 * interpolated** — this table has no placeholders, by the decision `bargainInvitePrompt`
 * records. The discovery stream's suite pins the service's fifteen-minute TTL against these
 * five sentences, so changing the service turns a test red instead of turning the copy
 * quietly false.
 *
 * ⚠ It says *tap it now* because the link is single-use and short-lived, and because a
 * customer who saves it for later finds it dead.
 */
const DOWNLOAD_READY_PROMPT: Copy = {
    en: 'Here it is. The link opens once and expires in 15 minutes — tap it now.',
    fr: "Le voici. Le lien s'ouvre une seule fois et expire dans 15 minutes — appuyez maintenant.",
    pt: 'Aqui está. O link abre uma única vez e expira em 15 minutos — toque agora.',
    es: 'Aquí está. El enlace se abre una sola vez y caduca en 15 minutos — tócalo ahora.',
    ar: 'تفضل. يفتح الرابط مرة واحدة فقط وتنتهي صلاحيته خلال 15 دقيقة — اضغط الآن.',
};

/**
 * ⚠ **The honest answer when the file cannot be handed over at all**, which is a CONFIGURATION
 * state rather than a fault: the service returns a relative path and the tap must make it
 * absolute from `API_PUBLIC_URL`, so an unset or non-HTTPS origin leaves no way to deliver it.
 * Telegram refuses an inline URL button on a non-HTTPS scheme and drops the WHOLE message, and
 * the URL cannot go in the text because the chat app's link preview would spend the single-use
 * token before the customer tapped it. So the tap mints nothing and says this.
 */
const DOWNLOAD_UNAVAILABLE_PROMPT: Copy = {
    en: "I can't hand you that download right now. Tell me and I'll get it sorted.",
    fr: 'Je ne peux pas vous remettre ce téléchargement pour le moment. Dites-le-moi et je règle ça.',
    pt: 'Não consigo entregar essa transferência de momento. Diga-me e eu trato disso.',
    es: 'Ahora mismo no puedo entregarte esa descarga. Dímelo y lo soluciono.',
    ar: 'لا يمكنني تسليمك هذا الملف الآن. أخبرني وسأتولى الأمر.',
};

// ── The sign-in message ──────────────────────────────────────────────────────
/**
 * ⭐ **Six fixed phrases that an assembler stacks around three values** — the site, the code and
 * the validity — with every value on its OWN LINE under its label.
 *
 * ⚠ **That shape is what makes it safe in Arabic.** A URL or a digit string placed inside a
 * right-to-left sentence is reordered by the bidi algorithm, and the damage looks exactly like a
 * corrupted code: the customer types what they see and it is refused. A value alone on its line
 * cannot be reordered into anything.
 *
 * ⚠ **`signInCodeIntro` and `signInCodeOnly` are a PAIR and must stay one.** The first is used
 * when a link was offered above it ("**Or** sign in…"), the second when the code is the only
 * credential. Dropping either leaves a dangling "Or" in five languages.
 */
const SIGN_IN_TAP_TO_OPEN: Copy = {
    en: 'Tap to sign in on this device:',
    fr: 'Touchez pour vous connecter sur cet appareil :',
    pt: 'Toque para entrar neste dispositivo:',
    es: 'Toca para iniciar sesión en este dispositivo:',
    ar: 'اضغط لتسجيل الدخول على هذا الجهاز:',
};

const SIGN_IN_CODE_INTRO: Copy = {
    en: 'Or sign in with your phone number and this code:',
    fr: 'Ou connectez-vous avec votre numéro de téléphone et ce code :',
    pt: 'Ou entre com o seu número de telefone e este código:',
    es: 'O inicia sesión con tu número de teléfono y este código:',
    ar: 'أو سجّل الدخول برقم هاتفك وهذا الرمز:',
};

const SIGN_IN_CODE_ONLY: Copy = {
    en: 'Sign in with your phone number and this code:',
    fr: 'Connectez-vous avec votre numéro de téléphone et ce code :',
    pt: 'Entre com o seu número de telefone e este código:',
    es: 'Inicia sesión con tu número de teléfono y este código:',
    ar: 'سجّل الدخول برقم هاتفك وهذا الرمز:',
};

const SIGN_IN_WEBSITE: Copy = {
    en: 'Website:',
    fr: 'Site web :',
    pt: 'Site:',
    es: 'Sitio web:',
    ar: 'الموقع:',
};

/** The duration prints as `15 min`, a symbol that does not inflect — so no plural has to agree. */
const SIGN_IN_VALID_FOR: Copy = {
    en: 'Valid for:',
    fr: 'Valable :',
    pt: 'Válido:',
    es: 'Válido:',
    ar: 'صالح لمدة:',
};

const SIGN_IN_IGNORE: Copy = {
    en: 'If you did not ask to sign in, ignore this message.',
    fr: "Si vous n'avez pas demandé à vous connecter, ignorez ce message.",
    pt: 'Se não pediu para entrar, ignore esta mensagem.',
    es: 'Si no pediste iniciar sesión, ignora este mensaje.',
    ar: 'إن لم تطلب تسجيل الدخول، تجاهل هذه الرسالة.',
};

// ── The notification inbox ───────────────────────────────────────────────────
const INBOX_PROMPT: Copy = {
    en: 'Your five most recent notifications.',
    fr: 'Vos cinq notifications les plus récentes.',
    pt: 'As suas cinco notificações mais recentes.',
    es: 'Tus cinco notificaciones más recientes.',
    ar: 'أحدث خمسة إشعارات لديك.',
};

const MARK_ALL_READ_BUTTON: Copy = {
    en: 'Mark all read',
    fr: 'Tout marquer lu',
    pt: 'Marcar todas lidas',
    es: 'Marcar todas leídas',
    ar: 'تعليم الكل كمقروء',
};

const ALL_MARKED_READ: Copy = {
    en: 'All marked as read.',
    fr: 'Tout est marqué comme lu.',
    pt: 'Tudo marcado como lido.',
    es: 'Todo marcado como leído.',
    ar: 'تم تعليم الكل كمقروء.',
};

// ── Notification settings, in the chat ───────────────────────────────────────
/**
 * The owner's shape: ONE channel choice and FOUR switches, in the conversation rather than on a
 * screen. The four keys are the real preference names (`orderUpdates`, `bookingUpdates`,
 * `bookingReminders`, `marketing`), not a second vocabulary.
 *
 * ⚠ **THE FIVE ROW LABELS ARE CAPPED AT 22, NOT 24, AND THAT IS NOT A TYPO.** Each renders with
 * a state marker appended — "Order updates ✓" — inside WhatsApp's 24-character row title. A
 * 24-character label would have its marker truncated away, and **every switch would read as
 * on**. The cap is where that gets caught.
 *
 * ⚠ **The switches carry a TARGET STATE, never a toggle** (`acct:ntf:<key>:on|off`): a toggle
 * flips whatever the state happens to be when an old button is finally pressed, which is the
 * stale-button defect with a different name.
 */
const NOTIFY_SETTINGS_PROMPT: Copy = {
    en: 'What I send you, and where.',
    fr: 'Ce que je vous envoie, et où.',
    pt: 'O que lhe envio, e para onde.',
    es: 'Lo que te envío, y dónde.',
    ar: 'ما أرسله إليك، وإلى أين.',
};

const NOTIFY_ROW_CHANNEL: Copy = {
    en: 'Where to send',
    fr: 'Où envoyer',
    pt: 'Para onde enviar',
    es: 'Dónde enviar',
    ar: 'إلى أين أرسل',
};

const NOTIFY_ROW_ORDER_UPDATES: Copy = {
    en: 'Order updates',
    fr: 'Suivi commandes',
    pt: 'Estado de encomendas',
    es: 'Estado de pedidos',
    ar: 'تحديثات الطلبات',
};

const NOTIFY_ROW_BOOKING_UPDATES: Copy = {
    en: 'Booking updates',
    fr: 'Suivi réservations',
    pt: 'Estado de reservas',
    es: 'Estado de reservas',
    ar: 'تحديثات الحجوزات',
};

const NOTIFY_ROW_BOOKING_REMINDERS: Copy = {
    en: 'Booking reminders',
    fr: 'Rappels de RDV',
    pt: 'Lembretes de reserva',
    es: 'Recordatorios',
    ar: 'تذكيرات الحجز',
};

const NOTIFY_ROW_MARKETING: Copy = {
    en: 'Offers and news',
    fr: 'Offres et actus',
    pt: 'Ofertas e novidades',
    es: 'Ofertas y novedades',
    ar: 'العروض والأخبار',
};

const NOTIFY_CHANNEL_PROMPT: Copy = {
    en: 'Where should I send them?',
    fr: 'Où dois-je les envoyer ?',
    pt: 'Para onde devo enviá-las?',
    es: '¿Dónde debo enviarlas?',
    ar: 'إلى أين أرسلها؟',
};

/** ⚠ Telegram and WhatsApp get no key — brand literals, like the language endonyms. */
const NOTIFY_CHANNEL_EMAIL: Copy = {
    en: 'Email',
    fr: 'E-mail',
    pt: 'E-mail',
    es: 'Correo',
    ar: 'البريد الإلكتروني',
};

const NOTIFY_CHANNEL_NONE: Copy = {
    en: 'Do not send any',
    fr: 'Ne rien envoyer',
    pt: 'Não enviar nada',
    es: 'No enviar nada',
    ar: 'لا ترسل شيئًا',
};

const NOTIFY_UPDATED: Copy = {
    en: 'Saved.',
    fr: 'Enregistré.',
    pt: 'Guardado.',
    es: 'Guardado.',
    ar: 'تم الحفظ.',
};

const MY_ORDERS_BUTTON: Copy = {
    en: 'My orders',
    fr: 'Mes commandes',
    pt: 'Encomendas',
    es: 'Mis pedidos',
    ar: 'طلباتي',
};

/**
 * The sentence over the button that opens the order-history screen.
 *
 * ⚠ **It exists because a ROW TITLE was doing a BODY's job.** `open:ol` was passing
 * `loadMoreRow` ("Load more") as the message body, which is four words describing a control
 * rather than a sentence introducing a screen — and the shared default introduces *products*,
 * which an order list is not.
 */
const ORDERS_SCREEN_PROMPT: Copy = {
    en: 'Here are your orders.',
    fr: 'Voici vos commandes.',
    pt: 'Aqui estão as suas encomendas.',
    es: 'Aquí tienes tus pedidos.',
    ar: 'إليك طلباتك.',
};

/**
 * The sentence over the button that opens the support form.
 *
 * ⚠ **It promises ONE screen, and that promise is load-bearing.** A customer with a problem is
 * already out of patience; "it takes one screen" is what makes them open a form rather than
 * type a paragraph the assistant then has to take apart. The form must stay one screen for
 * this sentence to stay true.
 *
 * The button beside it reuses `getHelpButton` — the same words the order card already offers,
 * so the same act has one name everywhere.
 */
const SUPPORT_FORM_PROMPT: Copy = {
    en: 'Tell me what happened — it takes one screen.',
    fr: "Dites-moi ce qui s'est passé — tout tient sur un seul écran.",
    pt: 'Diga-me o que aconteceu — cabe tudo num só ecrã.',
    es: 'Cuéntame qué ha pasado — cabe todo en una sola pantalla.',
    ar: 'أخبرني بما حدث — كل شيء في شاشة واحدة.',
};

const CANCEL_REASON_PROMPT: Copy = {
    en: 'What went wrong? Tell me in your own words and I will pass it on.',
    fr: "Que s'est-il passé ? Dites-le avec vos mots et je transmettrai.",
    pt: 'O que correu mal? Diga-me por palavras suas e eu transmito.',
    es: '¿Qué pasó? Cuéntamelo con tus palabras y lo transmito.',
    ar: 'ما الذي حدث؟ أخبرني بكلماتك وسأنقل ذلك.',
};

/**
 * ⚠ **A status the customer can SEE and cannot interpret.** `handing_over` appears on their
 * shipment when a delivery moves between agents mid-route. Today they get the status and
 * silence, which reads as something having gone wrong.
 */
const HANDOVER_PROMPT: Copy = {
    en: 'Your parcel is moving to a different delivery agent. It is still on its way.',
    fr: "Votre colis passe à un autre livreur. Il est toujours en route.",
    pt: 'A sua encomenda está a passar para outro estafeta. Continua a caminho.',
    es: 'Tu paquete está pasando a otro repartidor. Sigue en camino.',
    ar: 'طردك يُنقل إلى مندوب توصيل آخر. لا يزال في طريقه إليك.',
};

/** Opens the in-app product screen, where variants can actually be chosen. */
const OPEN_BUTTON: Copy = {
    en: 'Open',
    fr: 'Ouvrir',
    pt: 'Abrir',
    es: 'Abrir',
    ar: 'افتح',
};

/**
 * The next five cards, IN THE CHAT — distinct from `seeMoreButton`, which now opens the
 * in-app listing. Two different destinations needed two different words, and the pair appears
 * side by side on one message, so a customer must be able to tell them apart at a glance.
 */
const NEXT_PAGE_BUTTON: Copy = {
    en: 'Show 5 more',
    fr: '5 de plus',
    pt: 'Mais 5',
    es: '5 más',
    ar: '٥ أخرى',
};

/** Opens the in-app listing — the whole result set, not the next page of it. */
const BROWSE_ALL_BUTTON: Copy = {
    en: 'See all',
    fr: 'Tout voir',
    pt: 'Ver tudo',
    es: 'Ver todo',
    ar: 'عرض الكل',
};

/** Opens the in-app store listing. There are too many stores for a chat picker. */
const VIEW_STORES_BUTTON: Copy = {
    en: 'Stores',
    fr: 'Boutiques',
    pt: 'Lojas',
    es: 'Tiendas',
    ar: 'المتاجر',
};

/**
 * The last row of a chat list, opening the in-app listing for the rest.
 *
 * ⚠ Capped at **24**, not 20 — it is a WhatsApp list ROW title rather than a reply button,
 * and rows have the wider cap. It is never rendered as a button.
 */
const LOAD_MORE_ROW: Copy = {
    en: 'Load more',
    fr: 'Afficher plus',
    pt: 'Carregar mais',
    es: 'Cargar más',
    ar: 'تحميل المزيد',
};

/** The three that follow every add-to-basket. Exactly three — WhatsApp's hard cap. */
const VIEW_CART_BUTTON: Copy = {
    en: 'View basket',
    fr: 'Voir le panier',
    pt: 'Ver carrinho',
    es: 'Ver cesta',
    ar: 'عرض السلة',
};

const CHECKOUT_BUTTON: Copy = {
    en: 'Checkout',
    fr: 'Commander',
    pt: 'Finalizar',
    es: 'Pagar',
    ar: 'إتمام الطلب',
};

const BROWSE_MORE_BUTTON: Copy = {
    en: 'Keep shopping',
    fr: 'Continuer',
    pt: 'Continuar',
    es: 'Seguir viendo',
    ar: 'متابعة التسوق',
};

/**
 * The universal confirm pair.
 *
 * ⚠ **These exist so that no consequential action is ever ended by a TYPED word.** Closing an
 * account, cancelling an order, emptying a basket and confirming a delivery are all decided
 * today by parsing whatever the customer wrote, in five languages — which is the exact
 * failure `bot-action-id.ts` was written to abolish and the one place it was never applied.
 */
const CONFIRM_BUTTON: Copy = {
    en: 'Yes',
    fr: 'Oui',
    pt: 'Sim',
    es: 'Sí',
    ar: 'نعم',
};

const DECLINE_BUTTON: Copy = {
    en: 'No',
    fr: 'Non',
    pt: 'Não',
    es: 'No',
    ar: 'لا',
};

/** Order and shipment actions. */
const TRACK_BUTTON: Copy = {
    en: 'Track',
    fr: 'Suivre',
    pt: 'Rastrear',
    es: 'Seguir',
    ar: 'تتبع',
};

const SHIPMENTS_BUTTON: Copy = {
    en: 'Shipments',
    fr: 'Colis',
    pt: 'Envios',
    es: 'Envíos',
    ar: 'الشحنات',
};

const GET_HELP_BUTTON: Copy = {
    en: 'Get help',
    fr: 'Aide',
    pt: 'Ajuda',
    es: 'Ayuda',
    ar: 'مساعدة',
};

/** ⚠ There is deliberately no "Resend" companion — a replacement code comes from the agent. */
const GET_CODE_BUTTON: Copy = {
    en: 'Get code',
    fr: 'Voir le code',
    pt: 'Ver código',
    es: 'Ver código',
    ar: 'رمز التسليم',
};

/** The two that ride the payment-result message. */
const CHECK_STATUS_BUTTON: Copy = {
    en: 'Check status',
    fr: 'Vérifier',
    pt: 'Verificar',
    es: 'Verificar',
    ar: 'تحقق من الحالة',
};

const TRY_AGAIN_BUTTON: Copy = {
    en: 'Try again',
    fr: 'Réessayer',
    pt: 'Tentar de novo',
    es: 'Reintentar',
    ar: 'حاول مجددًا',
};

/**
 * Every chrome string, and the cap each one has to satisfy.
 *
 * The cap travels WITH the string rather than being applied at the call site, which is what
 * lets `assertBotChromeCopyFits` check the whole table at boot instead of trusting five
 * renderers to remember five different numbers. `null` means the string is a body rather
 * than a control and has no meaningful cap short of the channel's message limit.
 */
const CHROME = Object.freeze({
    contactButton: { copy: CONTACT_BUTTON, cap: null },
    choosePrompt: { copy: CHOOSE_PROMPT, cap: null },
    chooseListButton: { copy: CHOOSE_LIST_BUTTON, cap: 20 },
    chooseSectionTitle: { copy: CHOOSE_SECTION_TITLE, cap: 24 },
    skipButton: { copy: SKIP_BUTTON, cap: 20 },
    payPrompt: { copy: PAY_PROMPT, cap: null },
    payButton: { copy: PAY_BUTTON, cap: 20 },
    assistantUnavailable: { copy: ASSISTANT_UNAVAILABLE, cap: null },
    locationButton: { copy: LOCATION_BUTTON, cap: 24 },
    confirmPinPrompt: { copy: CONFIRM_PIN_PROMPT, cap: null },
    addressNotFound: { copy: ADDRESS_NOT_FOUND, cap: null },
    // ── Contact changes and account closure (MCP parity steps 6 and 7) ───────
    // All bodies, so all uncapped. Two of them are deliberately long: the phone-change
    // instruction and the closure prompt each state a consequence that cannot be shortened
    // without dropping the half that matters.
    contactEmailChangeStarted: { copy: CONTACT_EMAIL_CHANGE_STARTED, cap: null },
    contactPhoneChangeStarted: { copy: CONTACT_PHONE_CHANGE_STARTED, cap: null },
    contactPhoneChanged: { copy: CONTACT_PHONE_CHANGED, cap: null },
    contactChangeCancelled: { copy: CONTACT_CHANGE_CANCELLED, cap: null },
    connectionDisconnected: { copy: CONNECTION_DISCONNECTED, cap: null },
    accountClosurePrompt: { copy: ACCOUNT_CLOSURE_PROMPT, cap: null },
    accountClosed: { copy: ACCOUNT_CLOSED, cap: null },
    // ── Product cards ────────────────────────────────────────────────────────
    // The four buttons are capped at WhatsApp's 20-character reply-button title, which is the
    // tightest control any of them lands in. Telegram allows 64 and WhatsApp's carousel URL
    // button 20 as well, so one number covers every placement — and a fifth language added
    // later fails the boot here rather than arriving truncated in a customer's chat.
    browseProductsPrompt: { copy: BROWSE_PRODUCTS_PROMPT, cap: null },
    browseProductsButton: { copy: BROWSE_PRODUCTS_BUTTON, cap: 20 },
    buyNowButton: { copy: BUY_NOW_BUTTON, cap: 20 },
    addToCartButton: { copy: ADD_TO_CART_BUTTON, cap: 20 },
    seeMoreButton: { copy: SEE_MORE_BUTTON, cap: 20 },
    detailsButton: { copy: DETAILS_BUTTON, cap: 20 },
    moreProductsPrompt: { copy: MORE_PRODUCTS_PROMPT, cap: null },
    addedToCart: { copy: ADDED_TO_CART, cap: null },
    addedToCartCheckout: { copy: ADDED_TO_CART_CHECKOUT, cap: null },

    // ── The rich-UI vocabulary (declared together — see the block above) ─────
    bargainButton: { copy: BARGAIN_BUTTON, cap: 20 },
    bookButton: { copy: BOOK_BUTTON, cap: 20 },
    openButton: { copy: OPEN_BUTTON, cap: 20 },
    nextPageButton: { copy: NEXT_PAGE_BUTTON, cap: 20 },
    browseAllButton: { copy: BROWSE_ALL_BUTTON, cap: 20 },
    viewStoresButton: { copy: VIEW_STORES_BUTTON, cap: 20 },
    // ⚠ 24, not 20 — a WhatsApp list ROW title, never a reply button.
    loadMoreRow: { copy: LOAD_MORE_ROW, cap: 24 },
    viewCartButton: { copy: VIEW_CART_BUTTON, cap: 20 },
    checkoutButton: { copy: CHECKOUT_BUTTON, cap: 20 },
    browseMoreButton: { copy: BROWSE_MORE_BUTTON, cap: 20 },
    confirmButton: { copy: CONFIRM_BUTTON, cap: 20 },
    declineButton: { copy: DECLINE_BUTTON, cap: 20 },
    trackButton: { copy: TRACK_BUTTON, cap: 20 },
    shipmentsButton: { copy: SHIPMENTS_BUTTON, cap: 20 },
    getHelpButton: { copy: GET_HELP_BUTTON, cap: 20 },
    getCodeButton: { copy: GET_CODE_BUTTON, cap: 20 },
    checkStatusButton: { copy: CHECK_STATUS_BUTTON, cap: 20 },
    tryAgainButton: { copy: TRY_AGAIN_BUTTON, cap: 20 },
    // ── The two rungs that finish as a conversation, not as a write ──────────
    bargainInvitePrompt: { copy: BARGAIN_INVITE_PROMPT, cap: null },
    bookInvitePrompt: { copy: BOOK_INVITE_PROMPT, cap: null },
    // ── Orders and fulfilment ────────────────────────────────────────────────
    viewOrdersPrompt: { copy: VIEW_ORDERS_PROMPT, cap: null },
    cancelOrderButton: { copy: CANCEL_ORDER_BUTTON, cap: 20 },
    confirmDeliveryPrompt: { copy: CONFIRM_DELIVERY_PROMPT, cap: null },
    cancelOrderPrompt: { copy: CANCEL_ORDER_PROMPT, cap: null },
    cancelReasonPrompt: { copy: CANCEL_REASON_PROMPT, cap: null },
    handoverPrompt: { copy: HANDOVER_PROMPT, cap: null },
    ordersScreenPrompt: { copy: ORDERS_SCREEN_PROMPT, cap: null },
    myBookingsButton: { copy: MY_BOOKINGS_BUTTON, cap: 20 },

    // ── Reviews ──────────────────────────────────────────────────────────────
    ratePrompt: { copy: RATE_PROMPT, cap: null },
    rateWhichProductPrompt: { copy: RATE_WHICH_PRODUCT_PROMPT, cap: null },
    rateThanksPrompt: { copy: RATE_THANKS_PROMPT, cap: null },

    // ── Digital downloads ────────────────────────────────────────────────────
    downloadButton: { copy: DOWNLOAD_BUTTON, cap: 20 },
    downloadsPrompt: { copy: DOWNLOADS_PROMPT, cap: null },
    noDownloadsPrompt: { copy: NO_DOWNLOADS_PROMPT, cap: null },
    downloadReadyPrompt: { copy: DOWNLOAD_READY_PROMPT, cap: null },
    downloadUnavailablePrompt: { copy: DOWNLOAD_UNAVAILABLE_PROMPT, cap: null },
    supportFormPrompt: { copy: SUPPORT_FORM_PROMPT, cap: null },

    // ── Discovery and bargaining (Stream B) ──────────────────────────────────
    similarItemsButton: { copy: SIMILAR_ITEMS_BUTTON, cap: 20 },
    saveForLaterButton: { copy: SAVE_FOR_LATER_BUTTON, cap: 20 },
    readAllReviewsButton: { copy: READ_ALL_REVIEWS_BUTTON, cap: 20 },
    bargainAgainButton: { copy: BARGAIN_AGAIN_BUTTON, cap: 20 },
    // ⚠ Uncapped deliberately — see the constant: the price, not the label, is the title.
    lockItInButton: { copy: LOCK_IT_IN_BUTTON, cap: null },
    browseCategoriesPrompt: { copy: BROWSE_CATEGORIES_PROMPT, cap: null },
    noCategoriesPrompt: { copy: NO_CATEGORIES_PROMPT, cap: null },
    categoryGonePrompt: { copy: CATEGORY_GONE_PROMPT, cap: null },
    similarItemsPrompt: { copy: SIMILAR_ITEMS_PROMPT, cap: null },
    noSimilarItemsPrompt: { copy: NO_SIMILAR_ITEMS_PROMPT, cap: null },
    savedForLaterPrompt: { copy: SAVED_FOR_LATER_PROMPT, cap: null },
    noReviewsYetPrompt: { copy: NO_REVIEWS_YET_PROMPT, cap: null },
    dealLockedPrompt: { copy: DEAL_LOCKED_PROMPT, cap: null },
    dealSupersededPrompt: { copy: DEAL_SUPERSEDED_PROMPT, cap: null },
    dealAlreadyOrderedPrompt: { copy: DEAL_ALREADY_ORDERED_PROMPT, cap: null },
    dealUnavailablePrompt: { copy: DEAL_UNAVAILABLE_PROMPT, cap: null },
    bargainLockExpiredPrompt: { copy: BARGAIN_LOCK_EXPIRED_PROMPT, cap: null },
    bargainPriceChangedPrompt: { copy: BARGAIN_PRICE_CHANGED_PROMPT, cap: null },

    // ── The account surface (Stream H) ───────────────────────────────────────
    // ⚠ The eight menu rows are capped at 24 — a WhatsApp list ROW title, never a button.
    // Eight options cannot be buttons at all: a WhatsApp message carries three.
    accountMenuPrompt: { copy: ACCOUNT_MENU_PROMPT, cap: null },
    accountRowProfile: { copy: ACCOUNT_ROW_PROFILE, cap: 24 },
    accountRowAddresses: { copy: ACCOUNT_ROW_ADDRESSES, cap: 24 },
    accountRowPayments: { copy: ACCOUNT_ROW_PAYMENTS, cap: 24 },
    accountRowNotifySettings: { copy: ACCOUNT_ROW_NOTIFY_SETTINGS, cap: 24 },
    accountRowInbox: { copy: ACCOUNT_ROW_INBOX, cap: 24 },
    accountRowChannels: { copy: ACCOUNT_ROW_CHANNELS, cap: 24 },
    accountRowLanguage: { copy: ACCOUNT_ROW_LANGUAGE, cap: 24 },
    accountRowClose: { copy: ACCOUNT_ROW_CLOSE, cap: 24 },
    accountKept: { copy: ACCOUNT_KEPT, cap: null },
    connectionsPrompt: { copy: CONNECTIONS_PROMPT, cap: null },
    connectionsOnlyCurrent: { copy: CONNECTIONS_ONLY_CURRENT, cap: null },
    connectionDisconnectPrompt: { copy: CONNECTION_DISCONNECT_PROMPT, cap: null },
    disconnectButton: { copy: DISCONNECT_BUTTON, cap: 20 },
    keepConnectedButton: { copy: KEEP_CONNECTED_BUTTON, cap: 20 },
    connectionKept: { copy: CONNECTION_KEPT, cap: null },
    languagePrompt: { copy: LANGUAGE_PROMPT, cap: null },
    languageSet: { copy: LANGUAGE_SET, cap: null },
    addressBookPrompt: { copy: ADDRESS_BOOK_PROMPT, cap: null },
    paymentMethodsPrompt: { copy: PAYMENT_METHODS_PROMPT, cap: null },
    setDefaultButton: { copy: SET_DEFAULT_BUTTON, cap: 20 },
    removeButton: { copy: REMOVE_BUTTON, cap: 20 },
    defaultSet: { copy: DEFAULT_SET, cap: null },
    itemRemoved: { copy: ITEM_REMOVED, cap: null },
    addAddressButton: { copy: ADD_ADDRESS_BUTTON, cap: 20 },
    resendCodeButton: { copy: RESEND_CODE_BUTTON, cap: 20 },
    cancelChangeButton: { copy: CANCEL_CHANGE_BUTTON, cap: 20 },
    contactCodeResent: { copy: CONTACT_CODE_RESENT, cap: null },
    welcomePrompt: { copy: WELCOME_PROMPT, cap: null },
    myOrdersButton: { copy: MY_ORDERS_BUTTON, cap: 20 },

    // ── The sign-in message: fixed phrases only, values on their own lines ────
    signInTapToOpen: { copy: SIGN_IN_TAP_TO_OPEN, cap: null },
    signInCodeIntro: { copy: SIGN_IN_CODE_INTRO, cap: null },
    signInCodeOnly: { copy: SIGN_IN_CODE_ONLY, cap: null },
    signInWebsite: { copy: SIGN_IN_WEBSITE, cap: null },
    signInValidFor: { copy: SIGN_IN_VALID_FOR, cap: null },
    signInIgnore: { copy: SIGN_IN_IGNORE, cap: null },

    // ── The notification inbox ───────────────────────────────────────────────
    inboxPrompt: { copy: INBOX_PROMPT, cap: null },
    markAllReadButton: { copy: MARK_ALL_READ_BUTTON, cap: 20 },
    allMarkedRead: { copy: ALL_MARKED_READ, cap: null },

    // ── Notification settings in the chat ────────────────────────────────────
    // ⚠ 22, not 24: each row title carries a state marker inside WhatsApp's 24. See above.
    notifySettingsPrompt: { copy: NOTIFY_SETTINGS_PROMPT, cap: null },
    notifyRowChannel: { copy: NOTIFY_ROW_CHANNEL, cap: 22 },
    notifyRowOrderUpdates: { copy: NOTIFY_ROW_ORDER_UPDATES, cap: 22 },
    notifyRowBookingUpdates: { copy: NOTIFY_ROW_BOOKING_UPDATES, cap: 22 },
    notifyRowBookingReminders: { copy: NOTIFY_ROW_BOOKING_REMINDERS, cap: 22 },
    notifyRowMarketing: { copy: NOTIFY_ROW_MARKETING, cap: 22 },
    notifyChannelPrompt: { copy: NOTIFY_CHANNEL_PROMPT, cap: null },
    notifyChannelEmail: { copy: NOTIFY_CHANNEL_EMAIL, cap: 24 },
    notifyChannelNone: { copy: NOTIFY_CHANNEL_NONE, cap: 24 },
    notifyUpdated: { copy: NOTIFY_UPDATED, cap: null },
} as const);

export type BotChromeKey = keyof typeof CHROME;

/**
 * One chrome string, in the customer's language.
 *
 * Falls back to English on a language with no entry and never to the key — a customer shown
 * the word `payButton` has been shown an internal identifier, which is the failure the
 * whole copy layer exists to prevent.
 */
export function botChrome(key: BotChromeKey, language: string | null | undefined): string {
    const { copy } = CHROME[key];
    return copy[toBotCopyLanguage(language)] ?? copy.en;
}

/**
 * Refuse to boot on a missing translation OR on one that a messaging client would truncate.
 *
 * The second half is the one worth having. A missing string is loud the first time anybody
 * reads that language; a string two characters over WhatsApp's button cap is silent
 * forever, arrives as `Pagar agor…` to exactly the customers who read Portuguese, and is
 * the kind of defect that is only ever reported as "the bot looks broken".
 *
 * A bare `Error` — this runs before any request exists, beside the other boot assertions.
 */
export function assertBotChromeCopyFits(): void {
    const gaps: string[] = [];

    for (const key of Object.keys(CHROME) as BotChromeKey[]) {
        const { copy, cap } = CHROME[key];
        for (const lang of BOT_COPY_LANGUAGES) {
            const value = copy[lang];
            if (typeof value !== 'string' || value.trim().length === 0) {
                gaps.push(`${key}:${lang} is missing`);
                continue;
            }
            if (cap !== null && value.length > cap) {
                gaps.push(`${key}:${lang} is ${value.length} chars, cap is ${cap}`);
            }
        }
    }

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] chrome copy is unusable: ${gaps.join('; ')}`);
    }
}

/** ⚠ Exported for `test:bot-surface`, which re-checks the caps the assert above enforces. */
export const __CHROME_TABLE = CHROME;
