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
