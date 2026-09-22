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

/**
 * The maintenance window, in the two shapes a customer can actually be in.
 *
 * ⚠ **`MAINTENANCE_GENERAL` is used TWICE ON PURPOSE** — as the `SYSTEM_MAINTENANCE_ACTIVE`
 * entry in the table below, and as what `maintenanceMessageFor` returns for a full stop. One
 * constant, so the sentence a direct reader of `customerMessage` sees and the sentence the
 * composed reply carries cannot drift apart. It is worded to be **true in every kind of
 * window**, which is what makes it safe as the fallback when the mode cannot be read.
 *
 * `MAINTENANCE_READONLY` is the only refinement, and it is worth having because it is the
 * difference between a customer leaving and a customer browsing: a read-only window blocks
 * writes and leaves every read working, so "the shop is closed" would be simply false.
 *
 * ⚠ **Neither sentence names a duration**, and that is the lesson of
 * `BOT_CONTACT_CODE_RESEND_TOO_SOON` above applied in advance: a window's end is an operator's
 * guess carried in `Retry-After`, and a sentence promising "five minutes" starts lying the
 * moment a migration runs long — in the direction nobody notices, because the customer who
 * came back and found it still closed does not report it.
 */
const MAINTENANCE_GENERAL: Copy = {
    en: 'We are doing a little maintenance right now. Please try again in a few minutes.',
    fr: 'Nous effectuons une petite maintenance en ce moment. Réessayez dans quelques minutes.',
    pt: 'Estamos a fazer uma pequena manutenção neste momento. Tente novamente daqui a alguns minutos.',
    es: 'Estamos haciendo un pequeño mantenimiento en este momento. Inténtalo de nuevo en unos minutos.',
    ar: 'نجري بعض أعمال الصيانة في الوقت الحالي. حاول مرة أخرى بعد بضع دقائق.',
};

const MAINTENANCE_READONLY: Copy = {
    en: 'We are doing a little maintenance, so I cannot place orders or save changes right now. You can still browse and check your orders.',
    fr: "Nous effectuons une petite maintenance : je ne peux ni enregistrer de commande ni sauvegarder de modification pour le moment. Vous pouvez toujours parcourir la boutique et consulter vos commandes.",
    pt: 'Estamos a fazer uma pequena manutenção, por isso não posso registar encomendas nem guardar alterações neste momento. Pode continuar a ver a loja e as suas encomendas.',
    es: 'Estamos haciendo un pequeño mantenimiento, así que ahora no puedo registrar pedidos ni guardar cambios. Puedes seguir viendo la tienda y tus pedidos.',
    ar: 'نجري بعض أعمال الصيانة، لذلك لا يمكنني تسجيل الطلبات أو حفظ التغييرات الآن. لا يزال بإمكانك تصفح المتجر ومراجعة طلباتك.',
};

const MAINTENANCE_COPY: Readonly<Record<'readonly' | 'down', Copy>> = Object.freeze({
    readonly: MAINTENANCE_READONLY,
    down: MAINTENANCE_GENERAL,
});

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

    /**
     * The basket already holds a different KIND of thing.
     *
     * ⚠ **The `conflict` category sentence — "That has already changed. Let me check where
     * things stand and try again." — is wrong in a way that wastes the turn.** Nothing
     * changed and retrying fails identically; what the customer has to do is finish or empty
     * the basket first. Observed live while testing product cards, on a basket holding a
     * physical item and a tap on a digital one.
     */
    [ERROR_CODES.CART_MIXED_PRODUCT_TYPES]: {
        en: 'Your basket already has a different kind of item in it. Check out with what is there, or empty it, and I will add this one.',
        fr: "Votre panier contient déjà un autre type d'article. Terminez la commande en cours ou videz-le, et j'ajoute celui-ci.",
        pt: 'O seu carrinho já tem um tipo de artigo diferente. Finalize o que lá está ou esvazie-o, e eu adiciono este.',
        es: 'Tu cesta ya tiene otro tipo de artículo. Termina el pedido o vacíala, y añado este.',
        ar: 'سلتك تحتوي بالفعل على نوع مختلف من المنتجات. أكمل الطلب الحالي أو أفرغ السلة وسأضيف هذا.',
    },

    /**
     * A bookable service cannot go in a basket — it is booked.
     *
     * ⚠ **Earns an entry because the `validation` category sentence is actively wrong here.**
     * *"That does not look right. Could you send it again?"* invites the customer to repeat
     * an action that will fail identically every time; nothing about what they sent was
     * malformed. Observed live on a product card whose "Add to cart" button was offered on a
     * yoga class — the card no longer offers one (`product-card.ts`), and this closes the
     * other door: the model can still reach `cart_add_item` with a service id.
     */
    [ERROR_CODES.CART_SERVICE_PRODUCT_NOT_ALLOWED]: {
        en: 'That one is booked rather than bought — tell me when suits you and I will check what is free.',
        fr: "Celui-ci se réserve plutôt qu'il ne s'achète — dites-moi quand vous arrange et je regarde les disponibilités.",
        pt: 'Esse é reservado, não comprado — diga-me quando lhe dá jeito e vejo as disponibilidades.',
        es: 'Ese se reserva en vez de comprarse — dime cuándo te viene bien y miro la disponibilidad.',
        ar: 'هذا يُحجز ولا يُشترى — أخبرني بالوقت المناسب لك وسأتحقق من المواعيد المتاحة.',
    },

    // ── Product cards ────────────────────────────────────────────────────────
    // Both earn an entry for the reason the address flow does: the remedy is an ACTION, and
    // the category sentences are actively wrong here. `not_found`'s "I could not find that"
    // is false — nothing is missing, a window closed — and a customer tapping a stale button
    // has done nothing they can correct by repeating it.
    [ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED]: {
        en: 'That list is no longer available. Tell me what you are looking for and I will search again.',
        fr: "Cette liste n'est plus disponible. Dites-moi ce que vous cherchez et je relance la recherche.",
        pt: 'Essa lista já não está disponível. Diga-me o que procura e volto a pesquisar.',
        es: 'Esa lista ya no está disponible. Dime qué buscas y vuelvo a buscar.',
        ar: 'لم تعد هذه القائمة متاحة. أخبرني بما تبحث عنه وسأبحث من جديد.',
    },
    /**
     * ⚠ **This table held NO review copy at all**, so every review refusal reached a customer as
     * the category fallback — and the two that matter most are indistinguishable there. *"You
     * have already reviewed this"* and *"you cannot review this yet"* are different answers to
     * different questions, and a customer was getting neither.
     *
     * ⚠ `REVIEW_NOT_ELIGIBLE` names the CONDITION rather than the rule: the platform waits for
     * the delivery to be confirmed, so the sentence says when the customer may come back rather
     * than that they are not allowed.
     */
    [ERROR_CODES.REVIEW_ALREADY_EXISTS]: {
        en: 'You have already reviewed this one.',
        fr: 'Vous avez déjà donné votre avis sur cet article.',
        pt: 'Já deixou a sua opinião sobre este artigo.',
        es: 'Ya has valorado este artículo.',
        ar: 'لقد قيّمت هذا المنتج من قبل.',
    },
    [ERROR_CODES.REVIEW_NOT_ELIGIBLE]: {
        en: 'You can review this once the order has been confirmed as delivered.',
        fr: 'Vous pourrez donner votre avis une fois la commande confirmée comme livrée.',
        pt: 'Poderá avaliar assim que a encomenda for confirmada como entregue.',
        es: 'Podrás valorarlo cuando el pedido esté confirmado como entregado.',
        ar: 'يمكنك التقييم بعد تأكيد تسليم الطلب.',
    },
    [ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND]: {
        en: 'I could not find what that review was for.',
        fr: "Je n'ai pas trouvé l'article concerné par cet avis.",
        pt: 'Não encontrei o artigo a que essa opinião se refere.',
        es: 'No encontré el artículo al que se refiere esa valoración.',
        ar: 'لم أجد المنتج الذي يخصّه هذا التقييم.',
    },
    [ERROR_CODES.REVIEW_SUBJECT_NOT_REVIEWABLE]: {
        en: 'That one cannot be reviewed.',
        fr: 'Cet article ne peut pas être noté.',
        pt: 'Esse artigo não pode ser avaliado.',
        es: 'Ese artículo no se puede valorar.',
        ar: 'لا يمكن تقييم هذا المنتج.',
    },
    [ERROR_CODES.REVIEW_ROLE_NOT_ALLOWED]: {
        en: 'Only the customer who bought it can review it.',
        fr: "Seul le client qui l'a acheté peut donner un avis.",
        pt: 'Só o cliente que o comprou pode avaliá-lo.',
        es: 'Solo el cliente que lo compró puede valorarlo.',
        ar: 'يمكن فقط للعميل الذي اشتراه أن يقيّمه.',
    },
    /**
     * ⚠ **Four refusals about a file the customer OWNS, which until now read
     * *"You do not have access to that"*** — the `authorization` category fallback, and the
     * one sentence guaranteed to make somebody who paid for a download think they were
     * cheated. All four are 403s the digital service raises by name.
     */
    [ERROR_CODES.DIGITAL_DOWNLOAD_LIMIT_EXCEEDED]: {
        en: 'You have used all the downloads for that item.',
        fr: 'Vous avez utilisé tous les téléchargements de cet article.',
        pt: 'Já usou todas as transferências desse artigo.',
        es: 'Has usado todas las descargas de ese artículo.',
        ar: 'لقد استهلكت جميع مرات تنزيل هذا المنتج.',
    },
    [ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED]: {
        en: 'Your access to that download has expired.',
        fr: 'Votre accès à ce téléchargement a expiré.',
        pt: 'O seu acesso a essa transferência expirou.',
        es: 'Tu acceso a esa descarga ha caducado.',
        ar: 'انتهت صلاحية وصولك إلى هذا التنزيل.',
    },
    /** ⚠ Invites the customer to say what happened: a revocation is usually somebody's mistake. */
    [ERROR_CODES.DIGITAL_ENTITLEMENT_REVOKED]: {
        en: 'That download is no longer available. Tell me what happened and I will pass it on.',
        fr: "Ce téléchargement n'est plus disponible. Dites-moi ce qui s'est passé et je transmettrai.",
        pt: 'Essa transferência já não está disponível. Diga-me o que aconteceu e eu transmito.',
        es: 'Esa descarga ya no está disponible. Cuéntame qué pasó y lo transmito.',
        ar: 'لم يعد هذا التنزيل متاحًا. أخبرني بما حدث وسأنقل ذلك.',
    },
    [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND]: {
        en: 'I could not find that purchase.',
        fr: "Je n'ai pas trouvé cet achat.",
        pt: 'Não encontrei essa compra.',
        es: 'No encontré esa compra.',
        ar: 'لم أجد هذه العملية.',
    },
    /**
     * ⚠ **THE FIRST SENTENCE IN THIS TABLE TO NAME A NUMBER, and it is a deliberate exception
     * with a guard attached.** "About two minutes" hardcodes
     * `CONTACT_RESEND_COOLDOWN_SECONDS = 120`: change that constant alone and all five
     * sentences begin lying in the direction nobody notices — the customer is told two minutes
     * and refused at three. Stream H pins both halves together (the constant IS 120, and each
     * translation still names two minutes), so moving one without the other goes red naming
     * which. The alternative considered and rejected was "wait a little", which removes the
     * coupling and is also exactly what somebody retries immediately.
     *
     * ⚠ It says **"that"**, not "code" and not "link", because what went out is one or the
     * other depending on which contact change is pending. The exact remaining wait still
     * travels mechanically in `details.retryAfterSeconds`.
     */
    [ERROR_CODES.BOT_CONTACT_CODE_RESEND_TOO_SOON]: {
        en: 'I sent that a moment ago. Please wait about two minutes before asking for it again.',
        fr: "Je viens de l'envoyer. Veuillez patienter environ deux minutes avant de le redemander.",
        pt: 'Acabei de o enviar. Aguarde cerca de dois minutos antes de pedir de novo.',
        es: 'Acabo de enviarlo. Espera unos dos minutos antes de volver a pedirlo.',
        ar: 'أرسلته للتو. انتظر نحو دقيقتين قبل طلبه مرة أخرى.',
    },
    /**
     * ⚠ **Deliberately says nothing about WHICH screen and offers no fresh search.** One
     * sentence serves checkout, orders, stores and the support form, and the honest common
     * remedy for all four is "ask for it again" — the caller's own next turn names the thing.
     */
    [ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED]: {
        en: 'That screen is no longer open. Ask me again and I will open a fresh one.',
        fr: "Cet écran n'est plus ouvert. Demandez-le-moi à nouveau et j'en ouvrirai un autre.",
        pt: 'Esse ecrã já não está aberto. Peça-me outra vez e abro um novo.',
        es: 'Esa pantalla ya no está abierta. Pídemelo otra vez y abro una nueva.',
        ar: 'لم تعد هذه الشاشة مفتوحة. اطلب مني ذلك مرة أخرى وسأفتح واحدة جديدة.',
    },
    [ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN]: {
        en: 'That button is no longer active. Tell me what you would like to do and I will help.',
        fr: "Ce bouton n'est plus actif. Dites-moi ce que vous souhaitez faire et je vous aide.",
        pt: 'Esse botão já não está ativo. Diga-me o que pretende fazer e eu ajudo.',
        es: 'Ese botón ya no está activo. Dime qué quieres hacer y te ayudo.',
        ar: 'لم يعد هذا الزر فعّالًا. أخبرني بما تريد فعله وسأساعدك.',
    },
    /**
     * `chat_answer_question` with nothing to answer. ⚠ **It points at the buttons**, because the
     * commonest real case is a question that IS on the screen and cannot be answered in words — an
     * account closure, or a checkout offering several addresses — where a tap is the only answer.
     */
    [ERROR_CODES.BOT_NO_PENDING_QUESTION]: {
        en: 'There is no question waiting for your answer right now. If a message above has buttons, tap the one you want, or tell me what you would like to do.',
        fr: "Aucune question n'attend votre réponse pour le moment. Si un message ci-dessus comporte des boutons, appuyez sur celui que vous voulez, ou dites-moi ce que vous souhaitez faire.",
        pt: 'Não há nenhuma pergunta à espera da sua resposta neste momento. Se uma mensagem acima tiver botões, toque no que pretende, ou diga-me o que quer fazer.',
        es: 'Ahora mismo no hay ninguna pregunta esperando tu respuesta. Si un mensaje de arriba tiene botones, toca el que quieras, o dime qué quieres hacer.',
        ar: 'لا يوجد سؤال بانتظار إجابتك الآن. إذا كانت في رسالة أعلاه أزرار، فاضغط على الزر الذي تريده، أو أخبرني بما تريد فعله.',
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

    // ── Orders — cancelling and confirming (Stream G, 2026-09-16) ────────────
    // Each of these earned an entry by the file's own criterion: the category sentence was not
    // merely vague but WRONG under a button. `business_rule`'s "not possible right now" says
    // waiting helps, and for a paid or shipped order it never will. `conflict`'s "try again" is
    // what a customer read after a DOUBLE TAP on Yes — the first tap succeeded, and trying again
    // 409s again. ⚠ There is no refund tool on the bot surface, so none of these promises a refund
    // flow; they offer support, which exists.
    [ERROR_CODES.ORDER_CANCEL_REQUIRES_REFUND]: {
        en: 'This order is already paid, so it cannot be cancelled here. Tell me what is wrong and I will get you help.',
        fr: "Cette commande est déjà payée, elle ne peut donc pas être annulée ici. Dites-moi ce qui ne va pas et je vous trouve de l'aide.",
        pt: 'Esta encomenda já está paga, por isso não pode ser cancelada aqui. Diga-me o que está errado e eu arranjo-lhe ajuda.',
        es: 'Este pedido ya está pagado, así que no se puede cancelar aquí. Dime qué va mal y te consigo ayuda.',
        ar: 'هذا الطلب مدفوع بالفعل، لذا لا يمكن إلغاؤه هنا. أخبرني بما هو الخطأ وسأوفّر لك المساعدة.',
    },
    [ERROR_CODES.ORDER_NOT_CANCELLABLE]: {
        en: 'This order can no longer be cancelled. If something is wrong with it, tell me and I will get you help.',
        fr: "Cette commande ne peut plus être annulée. Si quelque chose ne va pas, dites-le-moi et je vous trouve de l'aide.",
        pt: 'Esta encomenda já não pode ser cancelada. Se algo estiver errado, diga-me e eu arranjo-lhe ajuda.',
        es: 'Este pedido ya no se puede cancelar. Si algo va mal, dímelo y te consigo ayuda.',
        ar: 'لم يعد من الممكن إلغاء هذا الطلب. إذا كان هناك خطأ ما، أخبرني وسأوفّر لك المساعدة.',
    },
    /** The SELLER's own cancellation policy refused it (`assertCancellationAllowed`). */
    [ERROR_CODES.CANCELLATION_NOT_ALLOWED]: {
        en: "The seller's cancellation policy does not allow cancelling this order. Tell me what is wrong and I will get you help.",
        fr: "La politique d'annulation du vendeur ne permet pas d'annuler cette commande. Dites-moi ce qui ne va pas et je vous trouve de l'aide.",
        pt: 'A política de cancelamento do vendedor não permite cancelar esta encomenda. Diga-me o que está errado e eu arranjo-lhe ajuda.',
        es: 'La política de cancelación del vendedor no permite cancelar este pedido. Dime qué va mal y te consigo ayuda.',
        ar: 'لا تسمح سياسة الإلغاء لدى البائع بإلغاء هذا الطلب. أخبرني بما هو الخطأ وسأوفّر لك المساعدة.',
    },
    /** The likeliest trigger is a double tap on Yes — so this states the outcome, never "try again". */
    [ERROR_CODES.SHIPMENT_ALREADY_CONFIRMED]: {
        en: 'You have already confirmed this parcel as received.',
        fr: 'Vous avez déjà confirmé la réception de ce colis.',
        pt: 'Já confirmou a receção desta encomenda.',
        es: 'Ya has confirmado que recibiste este paquete.',
        ar: 'لقد أكّدت بالفعل استلام هذا الطرد.',
    },
    [ERROR_CODES.ORDER_ALREADY_CANCELLED]: {
        en: 'This order is already cancelled.',
        fr: 'Cette commande est déjà annulée.',
        pt: 'Esta encomenda já está cancelada.',
        es: 'Este pedido ya está cancelado.',
        ar: 'هذا الطلب ملغى بالفعل.',
    },

    // ── Payments (Stream D, 2026-09-16) ──────────────────────────────────────
    /**
     * ⚠ Names the field the way the checkout SCREEN does (`inapp-copy.ts` `checkoutPhone`), in all
     * five languages, so a customer told about it in the chat and on the screen hears one word.
     */
    /**
     * A gateway this deployment does not offer — today, cards: no Stripe keys in production, and
     * the owner's rule of 2026-09-22 is mobile money only. The installed app still showed a
     * "Card" option; the answer names what DOES work rather than only refusing.
     */
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED]: {
        en: 'Card payments are not available right now. You can pay with mobile money (MTN or Orange) instead.',
        fr: "Le paiement par carte n'est pas disponible pour le moment. Vous pouvez payer par mobile money (MTN ou Orange).",
        pt: 'Os pagamentos com cartão não estão disponíveis de momento. Pode pagar com mobile money (MTN ou Orange).',
        es: 'Los pagos con tarjeta no están disponibles por ahora. Puedes pagar con mobile money (MTN u Orange).',
        ar: 'الدفع بالبطاقة غير متاح حاليًا. يمكنك الدفع عبر المحفظة المحمولة (MTN أو Orange).',
    },
    /**
     * ⚠ **Most often a SECOND tap on Place order**, after the first one placed the order and the
     * basket emptied with it (`confirmCheckoutTap`). Without a sentence of its own it answered
     * "That does not look right. Could you send it again?" — inviting a customer who had just
     * ordered to try again. It does not claim the order went through: the basket can be empty for
     * other reasons, so it points at where the answer is.
     */
    [ERROR_CODES.CART_EMPTY_CHECKOUT]: {
        en: 'Your basket is empty now. If you have just placed an order, ask me for your orders to see it.',
        fr: 'Votre panier est vide maintenant. Si vous venez de passer une commande, demandez-moi vos commandes pour la voir.',
        pt: 'O seu cesto está vazio agora. Se acabou de fazer uma encomenda, peça-me as suas encomendas para a ver.',
        es: 'Tu carrito está vacío ahora. Si acabas de hacer un pedido, pídeme tus pedidos para verlo.',
        ar: 'سلتك فارغة الآن. إذا كنت قد قدمت طلبًا للتو، اطلب مني عرض طلباتك لرؤيته.',
    },
    [ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED]: {
        en: 'I need a mobile money number to take this payment. Send me the number you want to pay with.',
        fr: "J'ai besoin d'un numéro mobile money pour ce paiement. Envoyez-moi le numéro avec lequel vous souhaitez payer.",
        pt: 'Preciso de um número de mobile money para este pagamento. Envie-me o número com que quer pagar.',
        es: 'Necesito un número de mobile money para este pago. Envíame el número con el que quieres pagar.',
        ar: 'أحتاج إلى رقم محفظة محمولة لإتمام هذا الدفع. أرسل لي الرقم الذي تريد الدفع به.',
    },
    /**
     * Raised seven times across the surface, and the category sentence — "I could not find that." —
     * said neither WHAT was missing nor what to do under a payment button. ⚠ Not-found and
     * not-yours answer identically on purpose: confirming that a transaction id exists IS the
     * disclosure, so this copy must never hint which one it was.
     */
    [ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND]: {
        en: 'I could not find that payment on your account. Ask me about your latest order and I will look it up.',
        fr: "Je n'ai pas trouvé ce paiement sur votre compte. Demandez-moi votre dernière commande et je la retrouverai.",
        pt: 'Não encontrei esse pagamento na sua conta. Pergunte-me pela sua última encomenda e eu procuro-a.',
        es: 'No encontré ese pago en tu cuenta. Pregúntame por tu último pedido y lo busco.',
        ar: 'لم أجد هذا الدفع في حسابك. اسألني عن آخر طلب لك وسأبحث عنه.',
    },
    /**
     * ⚠ **The most likely reason a customer meets this is that the thing sold out between the
     * card being drawn and the button being pressed** — a card lives in a chat history
     * indefinitely, and `executePurchase` re-resolves the rung on every write rather than
     * trusting the button. Without an entry here it fell back to the category sentence, *"That
     * is not possible right now"*, which reads as the shop being broken rather than as one item
     * being gone. It names what to do next, because the customer's question is "so now what?".
     */
    [ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK]: {
        en: 'That one is sold out just now. Pick another option, or ask me for something similar.',
        fr: "Celui-ci est épuisé pour le moment. Choisissez une autre option ou demandez-moi quelque chose de similaire.",
        pt: 'Esse está esgotado de momento. Escolha outra opção ou peça-me algo parecido.',
        es: 'Ese está agotado ahora mismo. Elige otra opción o pídeme algo parecido.',
        ar: 'هذا غير متوفر حاليًا. اختر خيارًا آخر أو اطلب مني شيئًا مشابهًا.',
    },
    /**
     * ⚠ **Raised on BOTH sides of the checkout spend, so the sentence must be true either way.**
     * It says what to do and never whether anything was placed — a sentence that claimed "no
     * order was created" would be a lie on one of the two paths, and that is the lie a customer
     * acts on by ordering again.
     */
    [ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED]: {
        en: 'I could not tell which mobile money network that number belongs to. Check it, or send me a different number.',
        fr: "Je n'ai pas pu déterminer l'opérateur mobile money de ce numéro. Vérifiez-le ou envoyez-moi un autre numéro.",
        pt: 'Não consegui identificar a operadora de mobile money desse número. Verifique-o ou envie-me outro número.',
        es: 'No pude identificar el operador de mobile money de ese número. Revísalo o envíame otro número.',
        ar: 'لم أتمكن من تحديد شبكة المحفظة المحمولة لهذا الرقم. تحقق منه أو أرسل لي رقمًا آخر.',
    },

    /**
     * A maintenance window.
     *
     * ⚠ **Deliberately the NEUTRAL sentence, and it is the same constant `maintenanceMessageFor`
     * returns for a full stop.** One sentence in one place, so the two cannot drift.
     *
     * The mode-specific refinement happens in `bot-recovery-actions.ts`, which has the
     * `details.mode` this function is not given. A reader of `customerMessage` alone therefore
     * gets a sentence that is **true in every kind of window** rather than one that is precise
     * in one and false in the other — which matters because the automation layer may read that
     * field directly, without the `reply` this surface composes beside it.
     */
    [ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE]: MAINTENANCE_GENERAL,
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
 * The maintenance sentence for the window the platform is actually in.
 *
 * ⚠ **A separate function rather than a `mode` parameter on `customerMessageFor`**, because
 * the error handler that calls that one has no mode to pass — the mode reaches the bot surface
 * on `error.details`, which only the reply composer reads. Widening the general resolver for a
 * single code would put an always-undefined argument at 623 call sites.
 *
 * ⚠ **This is not a second copy table on the failure path.** It resolves out of the same file,
 * against the same five languages, under the same boot assertion — which is the property that
 * matters, since the failure it prevents is a customer reading two different apologies for one
 * fault.
 */
export function maintenanceMessageFor(
    mode: 'readonly' | 'down',
    language: string | null | undefined,
): string {
    const lang = toBotCopyLanguage(language);
    const copy = MAINTENANCE_COPY[mode] ?? MAINTENANCE_COPY.down;
    return copy[lang] ?? copy[DEFAULT_LANGUAGE];
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
    /**
     * ⚠ **The maintenance copy is asserted TOO, and it would not be otherwise** — it is reached
     * through `maintenanceMessageFor` rather than through either table, so the two loops above
     * walk straight past it. A sentence outside the boot assert is one a customer discovers is
     * missing on the worst possible day, which for this particular sentence is *during an
     * outage*.
     */
    for (const [mode, copy] of Object.entries(MAINTENANCE_COPY)) check(`maintenance ${mode}`, copy);

    if (gaps.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] bot error copy is missing translations: ${gaps.join(', ')}`);
    }
}

/** Exported for `test:bot-surface`, which asserts coverage and the no-code-leaks rule. */
export const __BOT_ERROR_COPY = Object.freeze({ CATEGORY_COPY, CODE_COPY, MAINTENANCE_COPY });
