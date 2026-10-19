import { storefrontUrl } from '../../../core/utils/storefront-link.util';
import { GuideApp, GuideLanguage, GuideTopic, T as topic } from './website-guide-types';
import { VENDOR_GUIDE } from './website-guide-vendor';
import { AGENCY_GUIDE } from './website-guide-agency';
import { AGENT_GUIDE } from './website-guide-agent';

export type { GuideApp, GuideLanguage, GuideTopic } from './website-guide-types';

/**
 * The website guide — every customer action on wi-mall.com, written for the chat assistant
 * (owner, 2026-10-03: "have the AI agent redirect the user to the platform for actions he can't
 * perform in the chat … a book that contains all actions that can be performed on the website").
 *
 * ── AND, SINCE 2026-10-09, THE THREE BUSINESS APPS ───────────────────────────
 * Owner: "to be able to efficiently guide the user on any of the dashboards, you need to know
 * where the different buttons are placed, how to get to a specific page". The vendor dashboard,
 * the agency dashboard and the Wi-Mall Agent app each have their own file
 * (`website-guide-{vendor,agency,agent}.ts`), read from those repositories the same way. A
 * topic's `app` decides its link and what signing in means. The admin dashboard is left out on
 * purpose — see `GuideApp`.
 *
 * ── HOW THE MODEL FINDS A TOPIC ──────────────────────────────────────────────
 * ⚠ The n8n tool truncates what it reads at 6000 characters, so the whole catalogue can no
 * longer be one list. No key (or an unknown one) answers the storefront topics plus the four
 * APP keys — `shop`, `vendor`, `agency`, `agent` — and each app key answers that app's list.
 * Every app has a `…menu` topic: the map of its navigation, for "where is the X button?".
 *
 * ── WHO READS IT ─────────────────────────────────────────────────────────────
 * The MODEL, through the `Read-Website-Guide` tool in `wi-mall-core`, never the customer
 * directly. So each topic is plain text with exact button labels: the assistant retells the
 * steps in its own short words and hands over the link. A customer asking "how do I change my
 * address?" gets *where* and *what to tap*, rather than "I can't do that from here".
 *
 * ── WHERE THE CONTENT CAME FROM ──────────────────────────────────────────────
 * Read from `frontend/landing` itself on 2026-10-03: every route under `/shop`, `(auth)` and
 * `pay`, its components and `messages/{en,fr}.json`. **The labels are quoted, not paraphrased**
 * — "Make default" / "Définir par défaut" is what the button says, and a guide that names a
 * button the customer cannot find is worse than no guide. When the landing app changes a label,
 * this file is stale; nothing checks the WORDS. The PATHS are checked: `verify:landing-routes`
 * resolves every `path` below against that repository's routes.
 *
 * ── LANGUAGES ────────────────────────────────────────────────────────────────
 * English and French only, the two the chat offers (`CHAT_LANGUAGES`, Cameroon). A customer on
 * another language reads English text — but the LINK still carries their locale prefix, because
 * the website does serve all five.
 *
 * ── IMPORTS ONE UTILITY, NO MODEL ────────────────────────────────────────────
 * Pure apart from `storefrontUrl`, the one implementation of the website's `as-needed` locale
 * rule (English bare, others prefixed). Hand-joining the base and a path here would be the third
 * copy of that rule, and the second copy is the one that 404'd every notification button.
 */

const T = topic;

/** The storefront's topics (`app: 'shop'`). Customer sign-in pages are `/shop/account/**` and `/shop/checkout/**`. */
export const SHOP_GUIDE: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'signin',
        app: 'shop',
        path: '/login',
        signIn: false,
        copy: {
            en: {
                title: 'Signing in to the website',
                summary: 'How a customer signs in (there is no password)',
                steps: [
                    'Customers have no password. In this chat, send /login (or ask me to send a sign-in link).',
                    'Tap the link that arrives: it signs you in by itself.',
                    'Or open the sign-in page and tap the "Customer" card ("I want to shop"), choose "Phone" or "Email", enter the number you use with this chat and the 8-character "Sign-in code" ("Get code" shows how to ask the bot for one), then tap "Sign in".',
                ],
                notes: [
                    'The link and the code last 10 minutes and work once; using one cancels the other.',
                    'There is no sign-up form for customers: the account was created in this chat.',
                ],
            },
            fr: {
                title: 'Se connecter au site',
                summary: 'Comment un client se connecte (il n’y a pas de mot de passe)',
                steps: [
                    'Les clients n’ont pas de mot de passe. Dans ce chat, envoyez /login (ou demandez-moi un lien de connexion).',
                    'Ouvrez le lien reçu : il vous connecte automatiquement.',
                    'Ou ouvrez la page de connexion et touchez la carte « Client » (« Je veux faire mes achats »), choisissez « Téléphone » ou « E-mail », saisissez le numéro utilisé avec ce chat et le « Code de connexion » à 8 caractères (« Obtenir » explique comment le demander au bot), puis appuyez sur « Se connecter ».',
                ],
                notes: [
                    'Le lien et le code durent 10 minutes et ne servent qu’une fois ; utiliser l’un annule l’autre.',
                    'Il n’y a pas de formulaire d’inscription pour les clients : le compte a été créé dans ce chat.',
                ],
            },
        },
    }),
    T({
        key: 'addresses',
        app: 'shop',
        path: '/shop/account/addresses',
        signIn: true,
        copy: {
            en: {
                title: 'Delivery addresses: add, set default, remove, change',
                summary: 'Add, remove or change a saved delivery address, or pick the default',
                steps: [
                    'Open Account → "Addresses".',
                    'To add one: tap "Add", type at least 3 letters in "Search for your address" and PICK a result, check the fields, optionally tick "Use as my default delivery address", then tap "Save address".',
                    'To make one the default: tap "Make default" on it.',
                    'To remove one: tap "Remove" on it, then confirm.',
                    'To CHANGE an address: there is no edit button — add the correct address first (as default), then remove the wrong one.',
                ],
                notes: [
                    'Always pick the address from the search results: a typed address has no map position and is refused at checkout.',
                    'Removing an address does not affect orders already on their way.',
                ],
            },
            fr: {
                title: 'Adresses de livraison : ajouter, définir par défaut, retirer, modifier',
                summary: 'Ajouter, retirer ou modifier une adresse, ou choisir celle par défaut',
                steps: [
                    'Ouvrez Compte → « Adresses ».',
                    'Pour en ajouter une : appuyez sur « Ajouter », tapez au moins 3 lettres dans la recherche d’adresse et CHOISISSEZ un résultat, vérifiez les champs, cochez si besoin l’option « par défaut », puis appuyez sur « Enregistrer l’adresse ».',
                    'Pour en faire l’adresse par défaut : appuyez sur « Définir par défaut ».',
                    'Pour en retirer une : appuyez sur « Retirer », puis confirmez.',
                    'Pour MODIFIER une adresse : il n’y a pas de bouton modifier — ajoutez d’abord la bonne adresse (par défaut), puis retirez l’ancienne.',
                ],
                notes: [
                    'Choisissez toujours l’adresse dans les résultats de recherche : une adresse tapée n’a pas de position sur la carte et est refusée au paiement.',
                    'Retirer une adresse ne change rien aux commandes déjà en route.',
                ],
            },
        },
    }),
    T({
        key: 'paymentmethods',
        app: 'shop',
        path: '/shop/account/payment-methods',
        signIn: true,
        copy: {
            en: {
                title: 'Saved payment methods (mobile money)',
                summary: 'Save, remove or choose the default mobile-money number',
                steps: [
                    'Open Account → "Payment methods".',
                    'To add one: tap "Add", choose the "Provider" (MTN Mobile Money, Orange Money or Moov Money), enter the "Wallet number" with the country code, optionally make it the default, then tap "Save method".',
                    'Use "Make default" or "Remove" on a saved method.',
                ],
                notes: [
                    'Only mobile-money wallets can be saved; cards are never stored.',
                    'Up to 10 methods, and the same number cannot be saved twice on one network.',
                ],
            },
            fr: {
                title: 'Moyens de paiement enregistrés (mobile money)',
                summary: 'Enregistrer, retirer ou choisir le numéro mobile money par défaut',
                steps: [
                    'Ouvrez Compte → « Moyens de paiement ».',
                    'Pour en ajouter un : appuyez sur « Ajouter », choisissez l’« Opérateur » (MTN Mobile Money, Orange Money ou Moov Money), saisissez le « Numéro mobile money » avec l’indicatif, mettez-le par défaut si vous voulez, puis enregistrez.',
                    'Utilisez « Définir par défaut » ou « Retirer » sur un moyen enregistré.',
                ],
                notes: [
                    'Seuls les portefeuilles mobile money s’enregistrent ; aucune carte n’est conservée.',
                    '10 moyens au maximum, et un même numéro ne peut pas être enregistré deux fois sur un réseau.',
                ],
            },
        },
    }),
    T({
        key: 'orders',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Orders: see, pay, cancel, confirm delivery',
                summary: 'See an order, pay an unpaid one, cancel, confirm delivery, cash-on-delivery code',
                steps: [
                    'Open Account → "My orders" and tap the order (one entry per checkout, with one card per seller).',
                    'Unpaid: tap "Pay {amount}", choose a method and confirm. "Already paid? Check now" re-checks a payment.',
                    'To cancel: tap "Cancel order" on the seller\'s card, then confirm.',
                    'To confirm you received it: tap "I received this parcel" on the parcel, or "Confirm delivery" on the order.',
                    'Cash on delivery: the code card is on the order. Give the code to the courier only AFTER you have the parcel and have paid. "Send a new code" if needed.',
                ],
                notes: [
                    'Cancel is only offered while the order is unpaid and not yet shipped. A paid or shipped order goes through the seller\'s refund process: open a support request of type "Refund".',
                    'Orders from several sellers ship separately and can arrive on different days.',
                ],
            },
            fr: {
                title: 'Commandes : voir, payer, annuler, confirmer la livraison',
                summary: 'Voir une commande, payer, annuler, confirmer la livraison, code de paiement à la livraison',
                steps: [
                    'Ouvrez Compte → « Mes commandes » et appuyez sur la commande (une entrée par paiement, une carte par vendeur).',
                    'Non payée : appuyez sur « Payer {montant} », choisissez un moyen et confirmez. « Déjà payé ? Vérifier maintenant » revérifie un paiement.',
                    'Pour annuler : appuyez sur « Annuler la commande » sur la carte du vendeur, puis confirmez.',
                    'Pour confirmer la réception : appuyez sur « J’ai reçu ce colis » sur le colis, ou « Confirmer la livraison » sur la commande.',
                    'Paiement à la livraison : la carte du code est sur la commande. Donnez le code au livreur seulement APRÈS avoir reçu le colis et payé. « Envoyer un nouveau code » si besoin.',
                ],
                notes: [
                    'L’annulation n’est proposée que si la commande n’est ni payée ni expédiée. Une commande payée ou expédiée passe par le remboursement du vendeur : ouvrez une demande d’assistance de type « Remboursement ».',
                    'Les commandes de plusieurs vendeurs sont expédiées séparément et peuvent arriver à des jours différents.',
                ],
            },
        },
    }),
    T({
        key: 'tracking',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Tracking a delivery on the map',
                summary: 'Follow a parcel live on the map',
                steps: [
                    'Open Account → "My orders" → tap the order.',
                    'Each parcel on its way shows a live map with the arrival time; "Open in maps" opens it in your maps app.',
                    'The delivery company\'s Call / WhatsApp / Email buttons are on the parcel.',
                ],
                notes: ['Nothing shows until the parcel has left: "Nothing on the road yet". Downloads have nothing to track.'],
            },
            fr: {
                title: 'Suivre une livraison sur la carte',
                summary: 'Suivre un colis en direct sur la carte',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → appuyez sur la commande.',
                    'Chaque colis en route affiche une carte en direct avec l’heure d’arrivée ; « Ouvrir dans Maps » l’ouvre dans votre application de cartes.',
                    'Les boutons Appeler / WhatsApp / e-mail de la société de livraison sont sur le colis.',
                ],
                notes: ['Rien ne s’affiche tant que le colis n’est pas parti. Les téléchargements n’ont rien à suivre.'],
            },
        },
    }),
    T({
        key: 'paylink',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Letting someone else pay (payment link)',
                summary: 'Send a card payment link so someone else pays an order',
                steps: [
                    'Open Account → "My orders" → the order → "Pay {amount}".',
                    'Under "Someone else paying?" tap "Send a payment link" and share it. They pay by card, with no account.',
                    '"Send a new link" replaces it; the old link then stops working.',
                ],
                notes: ['Card only, and not for cash-on-delivery orders or while a mobile-money prompt is still waiting.'],
            },
            fr: {
                title: 'Faire payer quelqu’un d’autre (lien de paiement)',
                summary: 'Envoyer un lien de paiement par carte pour qu’une autre personne paie',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → la commande → « Payer {montant} ».',
                    'Sous « Quelqu’un d’autre paie ? » appuyez sur « Envoyer un lien de paiement » et partagez-le. La personne paie par carte, sans compte.',
                    '« Envoyer un nouveau lien » le remplace ; l’ancien ne marche plus.',
                ],
                notes: ['Carte uniquement, et pas pour un paiement à la livraison ni pendant qu’une demande mobile money attend.'],
            },
        },
    }),
    T({
        key: 'bookings',
        app: 'shop',
        path: '/shop/account/bookings',
        signIn: true,
        copy: {
            en: {
                title: 'Bookings: book, pay, move, cancel',
                summary: 'Book a service, pay for a booking, move it to another time or cancel it',
                steps: [
                    'To book: open the service, pick a time, add a note if you want, then tap "Book · {price}". The time is held for about 15 minutes.',
                    'Open Account → "My bookings" and tap the booking.',
                    '"Pay now" — available once the seller has accepted. Unpaid bookings are released after a while.',
                    '"Move to another time" → pick a new time → "Move my booking".',
                    '"Cancel booking" → "Cancel it".',
                    '"Pay the balance" appears if the final price ended up higher than quoted.',
                ],
                notes: [
                    'Move and cancel are only possible while the booking is awaiting the seller or confirmed, and within the seller\'s cancellation window.',
                    'Refunds follow the seller\'s policy.',
                ],
            },
            fr: {
                title: 'Réservations : réserver, payer, déplacer, annuler',
                summary: 'Réserver un service, payer, déplacer à un autre moment ou annuler',
                steps: [
                    'Pour réserver : ouvrez le service, choisissez un horaire, ajoutez une note si vous voulez, puis « Réserver · {prix} ». L’horaire est retenu environ 15 minutes.',
                    'Ouvrez Compte → « Mes réservations » et appuyez sur la réservation.',
                    '« Payer maintenant » — possible une fois que le vendeur a accepté. Les réservations non payées sont libérées au bout d’un moment.',
                    '« Déplacer à un autre moment » → choisissez un horaire → « Déplacer ma réservation ».',
                    '« Annuler la réservation » → « L’annuler ».',
                    '« Payer le solde » apparaît si le prix final est plus élevé que prévu.',
                ],
                notes: [
                    'Déplacer ou annuler n’est possible que si la réservation attend le vendeur ou est confirmée, et dans le délai d’annulation du vendeur.',
                    'Les remboursements suivent la politique du vendeur.',
                ],
            },
        },
    }),
    T({
        key: 'downloads',
        app: 'shop',
        path: '/shop/account/downloads',
        signIn: true,
        copy: {
            en: {
                title: 'Downloading a digital purchase',
                summary: 'Download a digital product that was bought',
                steps: ['Open Account → "My downloads" and tap "Download" on the item.'],
                notes: [
                    'Items appear as soon as payment clears. Each one shows how many downloads are left and until when.',
                    'An expired or revoked item can no longer be downloaded.',
                ],
            },
            fr: {
                title: 'Télécharger un achat numérique',
                summary: 'Télécharger un produit numérique acheté',
                steps: ['Ouvrez Compte → « Mes téléchargements » et appuyez sur « Télécharger ».'],
                notes: [
                    'Les articles apparaissent dès que le paiement est confirmé, avec le nombre de téléchargements restants et la date limite.',
                    'Un article expiré ou révoqué ne peut plus être téléchargé.',
                ],
            },
        },
    }),
    T({
        key: 'reviews',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Rating a product or a delivery',
                summary: 'Write a review of a product, a booking or a delivery',
                steps: [
                    'Open Account → "My orders" → the completed order (or the completed booking).',
                    'Tap "Rate this" on the item, or "Rate the delivery" on the parcel.',
                    'Choose 1 to 5 stars, optionally add a title and a few words, then tap "Submit".',
                    'Your reviews are listed under Account → "My reviews".',
                ],
                notes: ['Only once the order is complete, one review per item, and a review cannot be edited later. A review appears as soon as it is sent (the website may still say text is checked first — it no longer is); Wi-Mall can hide one afterwards.'],
            },
            fr: {
                title: 'Noter un produit ou une livraison',
                summary: 'Laisser un avis sur un produit, une réservation ou une livraison',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → la commande terminée (ou la réservation terminée).',
                    'Appuyez sur « Donner un avis » sur l’article, ou « Noter la livraison » sur le colis.',
                    'Choisissez de 1 à 5 étoiles, ajoutez si vous voulez un titre et un texte, puis « Valider ».',
                    'Vos avis sont listés dans Compte → « Mes avis ».',
                ],
                notes: ['Seulement une fois la commande terminée, un avis par article, et un avis ne peut pas être modifié. Un avis apparaît dès son envoi (le site peut encore dire que le texte est vérifié avant — ce n’est plus le cas) ; Wi-Mall peut le masquer ensuite.'],
            },
        },
    }),
    T({
        key: 'saved',
        app: 'shop',
        path: '/shop/saved',
        signIn: false,
        copy: {
            en: {
                title: 'Saved products (favourites) and recently viewed',
                summary: 'See saved products and recently viewed ones',
                steps: [
                    'Tap the heart on any product to save it.',
                    'Open the "Saved" tab: "Saved" shows your favourites, "Recently viewed" what you looked at ("Clear history" empties it).',
                ],
                notes: ['Signed out, favourites stay on that device only; sign in to keep them on your account.'],
            },
            fr: {
                title: 'Produits favoris et vus récemment',
                summary: 'Voir les produits favoris et ceux vus récemment',
                steps: [
                    'Appuyez sur le cœur d’un produit pour l’ajouter aux favoris.',
                    'Ouvrez l’onglet « Favoris » : « Favoris » montre vos produits, « Vus récemment » ce que vous avez consulté (« Effacer l’historique » le vide).',
                ],
                notes: ['Sans connexion, les favoris restent sur cet appareil ; connectez-vous pour les garder sur votre compte.'],
            },
        },
    }),
    T({
        key: 'notifications',
        app: 'shop',
        path: '/shop/account/notifications/settings',
        signIn: true,
        copy: {
            en: {
                title: 'Notification settings and connecting WhatsApp / Telegram (customers)',
                summary: 'Choose which messages arrive and where; connect WhatsApp or Telegram',
                steps: [
                    'Tap the bell at the top of the shop, then the gear icon. (There is no Notifications row on the Account page.)',
                    'Under "What you hear about" switch "Order updates", "Booking updates", "Booking reminders" or "Offers & news" on or off.',
                    'Under "Delivery channel" switch on ONE extra channel ("Email", "Telegram" or "WhatsApp"); turning one on turns the others off. A greyed-out one is not connected yet.',
                    'To connect a chat app: under "Chat channels" tap "Connect", send /connect to that app\'s Wi-Mall chat (or tap "Open WhatsApp" / "Open Telegram"), type the 6-character code, then tap "Connect". "Disconnect" removes it.',
                    'Email is usable once the account has a confirmed email: Account → "Sign-in details" → type the "New email address" → "Change" → open the link in the mailbox.',
                ],
                notes: [
                    'Every switch saves at once ("Preferences saved") — there is no Save button.',
                    '"Payments & refunds" and "Cancellations" are always sent, and so are in-app and push messages.',
                    '"Offers & news" sends nothing yet. The /connect code lasts 10 minutes and works once, even a failed try.',
                ],
            },
            fr: {
                title: 'Réglages des notifications et connexion WhatsApp / Telegram',
                summary: 'Choisir quels messages arrivent et où ; connecter WhatsApp ou Telegram',
                steps: [
                    'Appuyez sur la cloche en haut de la boutique, puis sur l’engrenage. (Il n’y a pas de ligne Notifications sur la page Compte.)',
                    'Sous « Ce dont vous êtes informé », activez ou coupez « Mises à jour des commandes », « Mises à jour des réservations », « Rappels de réservation » ou « Offres et actualités ».',
                    'Sous « Canal de réception », activez UN canal en plus (« E-mail », « Telegram » ou « WhatsApp ») ; en activer un désactive les autres. Un canal grisé n’est pas encore connecté.',
                    'Pour connecter une messagerie : sous « Messageries », appuyez sur « Connecter », envoyez /connect au chat Wi-Mall de cette application (ou « Ouvrir WhatsApp » / « Ouvrir Telegram »), saisissez le code à 6 caractères, puis « Connecter ». « Déconnecter » la retire.',
                    'L’e-mail devient utilisable quand le compte a un e-mail confirmé : Compte → « Identifiants de connexion » → saisissez la nouvelle adresse → « Modifier » → ouvrez le lien reçu.',
                ],
                notes: [
                    'Chaque interrupteur s’enregistre tout de suite (« Préférences enregistrées ») — il n’y a pas de bouton Enregistrer.',
                    '« Paiements et remboursements » et « Annulations » sont toujours envoyés, ainsi que les messages dans l’application et en push.',
                    '« Offres et actualités » n’envoie encore rien. Le code /connect dure 10 minutes et ne sert qu’une fois, même en cas d’échec.',
                ],
            },
        },
    }),
    T({
        key: 'emailphone',
        app: 'shop',
        path: '/shop/account/security',
        signIn: true,
        copy: {
            en: {
                title: 'Changing the sign-in email or phone number',
                summary: 'Change the email or phone number the account signs in with',
                steps: [
                    'Open Account → "Sign-in details".',
                    'Email: type the "New email address", tap "Change", then open the confirmation link sent to that new address.',
                    'Phone: type the new number (+237…), tap "Change", then type the 6-digit code that arrives on WhatsApp and tap "Confirm".',
                ],
                notes: [
                    'The old email or number keeps working until the change is confirmed. "Cancel this change" abandons an email change, "Cancel" a phone change; "Send a new code" resends the phone code.',
                    'If the phone code never arrives, contact support from that page.',
                ],
            },
            fr: {
                title: 'Changer l’e-mail ou le numéro de connexion',
                summary: 'Changer l’e-mail ou le numéro de téléphone du compte',
                steps: [
                    'Ouvrez Compte → « Identifiants de connexion ».',
                    'E-mail : saisissez la nouvelle adresse, appuyez sur « Modifier », puis ouvrez le lien de confirmation envoyé à cette nouvelle adresse.',
                    'Téléphone : saisissez le nouveau numéro (+237…), appuyez sur « Modifier », puis saisissez le code à 6 chiffres reçu sur WhatsApp et « Confirmer ».',
                ],
                notes: [
                    'L’ancien e-mail ou numéro reste valable jusqu’à la confirmation. « Annuler ce changement » abandonne un changement d’e-mail, « Annuler » un changement de téléphone ; « Envoyer un nouveau code » renvoie le code.',
                    'Si le code n’arrive jamais, contactez l’assistance depuis cette page.',
                ],
            },
        },
    }),
    T({
        key: 'support',
        app: 'shop',
        path: '/shop/account/support/new',
        signIn: true,
        copy: {
            en: {
                title: 'Opening a support request (ticket)',
                summary: 'Open a support request, reply to one, or close it',
                steps: [
                    'Open Account → "Support" → "New".',
                    'Choose what it is about (an order, a product or something else) and pick the order or product.',
                    'Choose the "Type" (e.g. Refund, Late delivery) and how urgent it is.',
                    'Write a subject and what happened, add photos or a video if useful, then tap "Open ticket".',
                    'Open tickets are under Account → "Support": reply there, or tap "Close ticket".',
                ],
                notes: [
                    'Urgency cannot be changed later. Some sellers require a photo, video or tracking number.',
                    'A closed ticket cannot be replied to — open a new one.',
                    'A request about a problem with the customer’s own order or booking, opened within 3 days of delivery, puts the seller’s payment on hold until the request is closed. Closing it releases the payment.',
                ],
            },
            fr: {
                title: 'Ouvrir une demande d’assistance (ticket)',
                summary: 'Ouvrir une demande d’assistance, y répondre ou la fermer',
                steps: [
                    'Ouvrez Compte → « Assistance » → « Nouveau ».',
                    'Choisissez le sujet (une commande, un produit ou autre chose) puis la commande ou le produit.',
                    'Choisissez le « Type » (ex. Remboursement, Livraison en retard) et l’urgence.',
                    'Écrivez un sujet et ce qui s’est passé, ajoutez des photos ou une vidéo si utile, puis « Ouvrir le ticket ».',
                    'Les tickets ouverts sont dans Compte → « Assistance » : répondez-y, ou « Fermer le ticket ».',
                ],
                notes: [
                    'L’urgence ne peut pas être modifiée ensuite. Certains vendeurs exigent une photo, une vidéo ou un numéro de suivi.',
                    'Un ticket fermé ne peut plus recevoir de réponse — ouvrez-en un nouveau.',
                    'Une demande concernant un problème sur la propre commande ou réservation du client, ouverte dans les 3 jours suivant la livraison, suspend le paiement du vendeur jusqu’à la clôture de la demande. La clôturer libère le paiement.',
                ],
            },
        },
    }),
    T({
        key: 'checkout',
        app: 'shop',
        path: '/shop/cart',
        signIn: false,
        copy: {
            en: {
                title: 'Buying on the website: cart and checkout',
                summary: 'Pay for the cart on the website instead of in the chat',
                steps: [
                    'Open the "Cart" tab, adjust quantities, then tap "Checkout".',
                    'Pick a "Delivery address" (or "Add an address").',
                    'Pick a "Payment method": MTN Mobile Money, Orange Money, Moov Money, Card or Cash on delivery; for mobile money enter the number.',
                    'Tap "Pay {amount}" (or "Place order" for cash on delivery) and approve the prompt on your phone.',
                ],
                notes: [
                    'A cart holds either physical items or a single digital product; services are booked, not added to a cart.',
                    'Each seller may require a minimum order. Cash on delivery is not offered for digital products or above the cash limit.',
                    'The cart is the same in this chat and on the website once you are signed in.',
                ],
            },
            fr: {
                title: 'Acheter sur le site : panier et paiement',
                summary: 'Payer le panier sur le site plutôt que dans le chat',
                steps: [
                    'Ouvrez l’onglet « Panier », ajustez les quantités, puis appuyez sur « Commander ».',
                    'Choisissez une « Adresse de livraison » (ou « Ajouter une adresse »).',
                    'Choisissez un « Moyen de paiement » : MTN Mobile Money, Orange Money, Moov Money, Carte bancaire ou Paiement à la livraison ; pour le mobile money, saisissez le numéro.',
                    'Appuyez sur « Payer {montant} » (ou « Passer la commande » pour le paiement à la livraison) et validez sur votre téléphone.',
                ],
                notes: [
                    'Un panier contient soit des articles physiques, soit un seul produit numérique ; les services se réservent, ils ne vont pas au panier.',
                    'Chaque vendeur peut exiger un minimum de commande. Le paiement à la livraison n’est pas proposé pour le numérique ni au-delà du plafond.',
                    'Une fois connecté, le panier est le même dans ce chat et sur le site.',
                ],
            },
        },
    }),
    T({
        key: 'closeaccount',
        app: 'shop',
        path: '/shop/account/close',
        signIn: true,
        copy: {
            en: {
                title: 'Closing the account',
                summary: 'Close the customer account for good',
                steps: [
                    'Open Account → the ⋮ menu at the top right → "Close account".',
                    'Type CLOSE MY ACCOUNT exactly (in English, whatever the language), then tap "Close my account".',
                ],
                notes: [
                    'It cannot be undone, and downloads stop being available. Past orders are kept anonymously.',
                    'Refused while orders are still in progress, or if the account also sells or delivers (then only support can close it).',
                ],
            },
            fr: {
                title: 'Fermer le compte',
                summary: 'Fermer définitivement le compte client',
                steps: [
                    'Ouvrez Compte → le menu ⋮ en haut à droite → « Fermer le compte ».',
                    'Tapez exactement CLOSE MY ACCOUNT (en anglais, quelle que soit la langue), puis « Fermer mon compte ».',
                ],
                notes: [
                    'C’est définitif, et les téléchargements ne sont plus disponibles. Les commandes passées sont conservées de façon anonyme.',
                    'Refusé tant que des commandes sont en cours, ou si le compte vend ou livre aussi (seule l’assistance peut alors le fermer).',
                ],
            },
        },
    }),
    T({
        key: 'browse',
        app: 'shop',
        path: '/shop',
        signIn: false,
        copy: {
            en: {
                title: 'Browsing and searching the shop',
                summary: 'Search the catalogue with filters, visit a store',
                steps: [
                    'Open the "Shop" tab and type in the search box, then submit.',
                    'Tap "Filters" to narrow by category, product type (Physical, Digital, Service), maximum price or "In stock only", and choose a sort order.',
                    'Tap a store name, or "View store", to see everything one seller offers.',
                ],
                notes: ['Search matches whole words. Product text is written by the seller and is not translated.'],
            },
            fr: {
                title: 'Parcourir et rechercher dans la boutique',
                summary: 'Chercher avec des filtres, visiter une boutique',
                steps: [
                    'Ouvrez l’onglet « Boutique », tapez dans la recherche, puis validez.',
                    'Appuyez sur « Filtres » pour trier par catégorie, type (Physique, Numérique, Service), prix maximum ou « En stock uniquement », et choisissez un ordre.',
                    'Appuyez sur le nom d’une boutique, ou « Voir la boutique », pour voir tout ce qu’un vendeur propose.',
                ],
                notes: ['La recherche porte sur des mots entiers. Les textes des produits sont écrits par le vendeur et ne sont pas traduits.'],
            },
        },
    }),
    T({
        key: 'account',
        app: 'shop',
        path: '/shop/account',
        signIn: true,
        copy: {
            en: {
                title: 'The customer Account page: what is where, language, dark mode, signing out',
                summary: 'Map of the Account page; change language or dark mode; sign out; what cannot be changed',
                steps: [
                    'Tap "Account" (bottom bar on a phone, icon at the top on a computer). The list: "My orders", "Addresses", "Payment methods", "My downloads", "My reviews", "Sign-in details", "My bookings", "Support", "Help & FAQ", "Language", "Dark mode".',
                    'Language: tap "Language" and pick one. Dark mode: the "Dark mode" switch.',
                    'Notifications are NOT in this list: they are behind the bell at the top (topic notifications).',
                    'Sign out or close the account: the ⋮ "Account options" menu at the top of the Account page → "Sign out" (or "Close account").',
                ],
                notes: [
                    'There is no way to edit the name or photo on the website, and no invoice or receipt download. For those, open a support request (types "Profile update" or "Invoice request").',
                    'The bottom bar on a phone is "Shop", "Saved", "Cart", "Account".',
                ],
            },
            fr: {
                title: 'La page Compte du client : où est quoi, langue, mode sombre, déconnexion',
                summary: 'Plan de la page Compte ; changer la langue ou le mode sombre ; se déconnecter ; ce qui ne se change pas',
                steps: [
                    'Touchez « Compte » (barre du bas sur téléphone, icône en haut sur ordinateur). La liste : « Mes commandes », « Adresses », « Moyens de paiement », « Mes téléchargements », « Mes avis », « Identifiants de connexion », « Mes réservations », « Assistance », « Aide & FAQ », « Langue », « Mode sombre ».',
                    'Langue : touchez « Langue » et choisissez. Mode sombre : l’interrupteur « Mode sombre ».',
                    'Les notifications ne sont PAS dans cette liste : elles sont derrière la cloche en haut (sujet notifications).',
                    'Se déconnecter ou fermer le compte : le menu ⋮ « Options du compte » en haut de la page Compte → « Se déconnecter » (ou « Fermer le compte »).',
                ],
                notes: [
                    'Impossible de modifier le nom ou la photo sur le site, et pas de facture ou de reçu à télécharger. Pour cela, ouvrez une demande d’assistance (types « Mise à jour du profil » ou « Demande de facture »).',
                    'La barre du bas sur téléphone : « Boutique », « Favoris », « Panier », « Compte ».',
                ],
            },
        },
    }),
    T({
        key: 'cart',
        app: 'shop',
        path: '/shop/cart',
        signIn: false,
        copy: {
            en: {
                title: 'The cart on the website',
                summary: 'Change quantities, remove items, why Checkout is blocked, digital items, agreed prices',
                steps: [
                    'Tap "Cart". Use the − / + stepper to change a quantity; the bin removes an item ("Remove").',
                    'The summary shows "Subtotal", delivery per seller, "Total". Tap "Checkout" (or "Sign in to check out") — topic checkout.',
                    'If a seller shows "Add {amount} more from {name} to order", add more from that seller or remove their items.',
                ],
                notes: [
                    'Items from different sellers become separate orders, paid once. A cart holds physical items OR one digital product; services are booked, not carted.',
                    'A price agreed in the chat shows as "your agreed price"; changing the quantity drops it back to the normal price.',
                    'The cart moves into the account when they sign in.',
                ],
            },
            fr: {
                title: 'Le panier sur le site',
                summary: 'Changer les quantités, retirer, pourquoi « Commander » est bloqué, numérique, prix convenus',
                steps: [
                    'Touchez « Panier ». Le − / + change une quantité ; la corbeille retire un article (« Retirer »).',
                    'Le récapitulatif montre le sous-total, la livraison par vendeur, le total. Touchez « Commander » (ou « Connectez-vous pour commander ») — sujet checkout.',
                    'Si un vendeur affiche qu’il faut ajouter un montant pour commander, ajoutez chez ce vendeur ou retirez ses articles.',
                ],
                notes: [
                    'Les articles de vendeurs différents deviennent des commandes séparées, payées en une fois. Un panier contient des produits physiques OU un produit numérique ; les services se réservent.',
                    'Un prix convenu dans le chat s’affiche « votre prix convenu » ; changer la quantité le ramène au prix normal.',
                    'Le panier passe dans le compte à la connexion.',
                ],
            },
        },
    }),
    T({
        key: 'product',
        app: 'shop',
        path: '/shop',
        signIn: false,
        copy: {
            en: {
                title: 'A product page: options, add to cart, buy now, bargain, share, contact the seller',
                summary: 'Choose size/colour, add to cart, "Bargain the price", save, share; a store page',
                steps: [
                    'Tap a product. Pick the options (unavailable ones are greyed), the quantity, then "Add to cart · {price}" (digital: "Buy now · {price}"; services: the booking panel, topic bookings).',
                    'Negotiable items have "Bargain the price": it continues in WhatsApp or Telegram with the assistant; the agreed price then appears in the cart.',
                    'The heart saves it; the share icon copies the link. Tabs: "Description", "Specifications", "Returns & cancellation", "Reviews".',
                    'Tap the store name for the store page: "Contact seller" opens WhatsApp with the seller (if they set a number).',
                ],
                notes: [
                    'The delivery fee is shown at checkout. A shop "on holiday" still takes orders and dispatches when it reopens.',
                    'Product text is written by the seller and is not translated.',
                ],
            },
            fr: {
                title: 'Une page produit : options, panier, achat direct, marchandage, partage, contacter le vendeur',
                summary: 'Choisir taille/couleur, ajouter au panier, « Négocier le prix », sauvegarder, partager ; page boutique',
                steps: [
                    'Touchez un produit. Choisissez les options (grisées si indisponibles), la quantité, puis « Ajouter au panier · {prix} » (numérique : « Acheter · {prix} » ; services : le panneau de réservation, sujet bookings).',
                    'Les articles négociables ont « Négocier le prix » : cela continue sur WhatsApp ou Telegram avec l’assistant ; le prix convenu apparaît ensuite dans le panier.',
                    'Le cœur le sauvegarde ; l’icône partage copie le lien. Onglets : « Description », « Specifications », « Retours et annulation », « Avis ».',
                    'Touchez le nom de la boutique pour sa page : « Contacter le vendeur » ouvre WhatsApp avec le vendeur (s’il a donné un numéro).',
                ],
                notes: [
                    'Les frais de livraison s’affichent au paiement. Une boutique en congé prend les commandes et expédie à son retour.',
                    'Les textes produits sont écrits par le vendeur et ne sont pas traduits.',
                ],
            },
        },
    }),
    T({
        key: 'feechange',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'The delivery company asks a different delivery fee (customer)',
                summary: 'Accept or decline a new delivery fee on an order; pay the difference',
                steps: [
                    'Open Account → "My orders" → the order. The panel "Delivery fee changes" shows the old and new fee and the reason.',
                    'Tap "Accept {amount}" or "Decline" (then confirm "Decline").',
                    'After accepting a higher fee, tap "Pay {amount}" to pay the difference; the parcel waits for it.',
                ],
                notes: [
                    'The parcel cannot be picked up until they answer. Only on orders where the customer pays delivery.',
                    'If they decline, either the shop pays the difference, or the delivery company keeps the old fee, asks once more, or turns the job down — the panel says which.',
                ],
            },
            fr: {
                title: 'La société de livraison demande d’autres frais (client)',
                summary: 'Accepter ou refuser de nouveaux frais de livraison ; payer la différence',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → la commande. Le panneau « Changements des frais de livraison » montre l’ancien et le nouveau prix et la raison.',
                    'Touchez « Accepter {montant} » ou « Refuser » (puis confirmez).',
                    'Après avoir accepté une hausse, touchez « Payer {montant} » pour la différence ; le colis l’attend.',
                ],
                notes: [
                    'Le colis ne peut pas être enlevé tant qu’ils n’ont pas répondu. Seulement quand le client paie la livraison.',
                    'S’ils refusent, soit la boutique paie la différence, soit la société garde l’ancien prix, redemande une fois ou refuse la course — le panneau le dit.',
                ],
            },
        },
    }),
    T({
        key: 'combined',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Asking one lower delivery price for several parcels (combined delivery)',
                summary: 'Ask the delivery company for a combined price on parcels travelling together',
                steps: [
                    'Open Account → "My orders" → the order (the whole checkout). Find "Combined delivery price".',
                    'Tap "Ask {company} for a combined price", optionally add a note, then "Send request".',
                    'The answer applies by itself ("New price applied — you save …"). "Cancel request" withdraws it.',
                ],
                notes: [
                    'Only when the customer pays delivery and parcels are still being prepared with the same company. It can only lower the fees.',
                ],
            },
            fr: {
                title: 'Demander un prix de livraison réduit pour plusieurs colis (livraison groupée)',
                summary: 'Demander à la société de livraison un prix groupé pour des colis qui voyagent ensemble',
                steps: [
                    'Ouvrez Compte → « Mes commandes » → la commande (tout l’achat). Trouvez « Prix de livraison groupé ».',
                    'Touchez « Demander un prix groupé à {société} », ajoutez une note si besoin, puis « Envoyer la demande ».',
                    'La réponse s’applique toute seule. « Annuler la demande » la retire.',
                ],
                notes: [
                    'Seulement quand le client paie la livraison et que des colis sont encore en préparation chez la même société. Cela ne peut que baisser les frais.',
                ],
            },
        },
    }),
    T({
        key: 'refunds',
        app: 'shop',
        path: '/shop/account/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Refunds: asking for one and following it',
                summary: 'How a customer asks for a refund and where to see its progress',
                steps: [
                    'There is no "request a refund" button. To ask: Account → "Support" → "New" → Type "Refund" (topic support). An unpaid order can simply be cancelled (topic orders).',
                    'When a refund exists, the order (or booking) shows a "Refund" line with its status, e.g. "Refund on its way to …" or "Refunded on …".',
                    'If declined: "Contact support". "How refunds work" opens the policy.',
                ],
                notes: [
                    'Mobile-money refunds go to the number that paid, minus a transfer fee shown on the line; card refunds go back to the card.',
                    'Wi-Mall can only refund while it still holds the seller’s payment: the problem must be reported within 3 days of delivery (the order page shows the exact date). After that the seller has been paid and it is between the customer and the seller. Never promise a refund.',
                ],
            },
            fr: {
                title: 'Remboursements : en demander un et le suivre',
                summary: 'Comment un client demande un remboursement et où voir l’avancement',
                steps: [
                    'Il n’y a pas de bouton de remboursement. Pour demander : Compte → « Assistance » → « Nouveau » → type « Remboursement » (sujet support). Une commande impayée peut simplement être annulée (sujet orders).',
                    'Quand un remboursement existe, la commande (ou la réservation) affiche une ligne « Remboursement » avec son statut.',
                    'S’il est refusé : « Contacter l’assistance ». « Comment fonctionnent les remboursements » ouvre la politique.',
                ],
                notes: [
                    'Un remboursement mobile money va au numéro qui a payé, moins des frais de transfert affichés ; une carte est remboursée sur la carte.',
                    'Wi-Mall ne peut rembourser que tant qu’il conserve le paiement du vendeur : le problème doit être signalé dans les 3 jours suivant la livraison (la page de la commande affiche la date exacte). Ensuite le vendeur a été payé et cela se règle entre le client et le vendeur. Ne promettez jamais un remboursement.',
                ],
            },
        },
    }),
    T({
        key: 'register',
        app: 'shop',
        path: '/register',
        signIn: false,
        copy: {
            en: {
                title: 'Creating a vendor, agency or agent account; adding a role',
                summary: 'Sign up as a seller, delivery agency or agent; add a role to an existing account',
                steps: [
                    'Open the link for the role: vendor https://wi-mall.com/register?role=vendor · agency …/register?role=agency · agent …/register?role=agent.',
                    'Fill "Your Name" (agent: "Full Name"), "Phone Number", optional email, "Business Name" (vendor) or "Agency Name" (agency), "Password", tick the agreement, then "Create account". The dashboard set-up opens next (vendors: topic vendoronboarding; agencies: agencyonboarding; agents install the app: agentinstall).',
                    'Already have a Wi-Mall account (phone or email "already linked")? Tap "Sign in to add the {role} role", sign in, then "Add {role} role".',
                ],
                notes: [
                    'Customers do not register on the website: their account is created in this chat.',
                    'One Wi-Mall account can hold several roles; "Switch Role" in the website menu moves between them.',
                ],
            },
            fr: {
                title: 'Créer un compte vendeur, agence ou livreur ; ajouter un rôle',
                summary: 'S’inscrire comme vendeur, agence de livraison ou livreur ; ajouter un rôle à un compte existant',
                steps: [
                    'Ouvrez le lien du rôle : vendeur https://wi-mall.com/fr/register?role=vendor · agence …/register?role=agency · livreur …/register?role=agent.',
                    'Remplissez « Votre nom » (livreur : « Nom complet »), « Numéro de téléphone », e-mail facultatif, « Nom de l’entreprise » (vendeur) ou « Nom de l’agence » (agence), « Mot de passe », cochez le contrat, puis « Créer un compte ». La configuration du tableau de bord suit (vendeurs : sujet vendoronboarding ; agences : agencyonboarding ; les livreurs installent l’app : agentinstall).',
                    'Déjà un compte Wi-Mall (téléphone ou e-mail « déjà lié ») ? Touchez « Se connecter pour ajouter le rôle {rôle} », connectez-vous, puis « Ajouter le rôle {rôle} ».',
                ],
                notes: [
                    'Les clients ne s’inscrivent pas sur le site : leur compte est créé dans ce chat.',
                    'Un compte Wi-Mall peut avoir plusieurs rôles ; « Changer de rôle » dans le menu du site passe de l’un à l’autre.',
                ],
            },
        },
    }),
    T({
        key: 'password',
        app: 'shop',
        path: '/forgot-password',
        signIn: false,
        copy: {
            en: {
                title: 'Forgotten password (vendors, agencies, agents)',
                summary: 'Reset a business password on the website, through the bot or by email',
                steps: [
                    'Open the "Forgot password?" page (also on the sign-in page after choosing a role). Type the phone number and tap "Continue".',
                    'Send /password to the Wi-Mall bot FROM THAT NUMBER (the "Open WhatsApp" button helps). The bot replies with a link: open it, type the new password twice, "Set new password".',
                    'By email instead: "Reset with your email instead?" → email → "Send reset link", then open the link.',
                ],
                notes: [
                    'Customers have no password to reset: they sign in with /login (topic signin).',
                    'The new password needs 8+ characters with upper case, lower case, a number and a symbol. Setting it signs out every other device.',
                ],
            },
            fr: {
                title: 'Mot de passe oublié (vendeurs, agences, livreurs)',
                summary: 'Réinitialiser un mot de passe professionnel sur le site, via le bot ou par e-mail',
                steps: [
                    'Ouvrez la page « Mot de passe oublié ? » (aussi sur la page de connexion après le choix du rôle). Saisissez le numéro et touchez « Continuer ».',
                    'Envoyez /password au bot Wi-Mall DEPUIS CE NUMÉRO (le bouton « Ouvrir WhatsApp » aide). Le bot répond avec un lien : ouvrez-le, saisissez deux fois le nouveau mot de passe, « Définir le mot de passe ».',
                    'Par e-mail : « Réinitialiser plutôt avec votre e-mail ? » → e-mail → « Envoyer le lien », puis ouvrez le lien.',
                ],
                notes: [
                    'Les clients n’ont pas de mot de passe : ils se connectent avec /login (sujet signin).',
                    'Le nouveau mot de passe demande 8+ caractères avec majuscule, minuscule, chiffre et symbole. Le définir déconnecte tous les autres appareils.',
                ],
            },
        },
    }),
    T({
        key: 'help',
        app: 'shop',
        path: '/faq',
        signIn: false,
        copy: {
            en: {
                title: 'Help, FAQ and contacting the team',
                summary: 'Frequently asked questions and the contact form',
                steps: [
                    'The FAQ answers common questions (Account → "Help & FAQ").',
                    'To write to the team: the contact page, or the email, phone and social pages in topic contact.',
                    'For a problem with an order, a support request (topic support) is faster.',
                ],
                notes: [],
            },
            fr: {
                title: 'Aide, FAQ et contacter l’équipe',
                summary: 'Questions fréquentes et formulaire de contact',
                steps: [
                    'La FAQ répond aux questions courantes (Compte → « Aide & FAQ »).',
                    'Pour écrire à l’équipe : la page contact, ou l’e-mail, le téléphone et les réseaux sociaux du sujet contact.',
                    'Pour un problème de commande, une demande d’assistance (sujet support) est plus rapide.',
                ],
                notes: [],
            },
        },
    }),
    /**
     * Wi-Mall's own contact details (owner, 2026-10-19: kept HERE rather than in the system
     * prompt). Same values as the landing site (`frontend/landing/src/lib/constants.ts`
     * `BRAND.email`, `SOCIAL_LINKS`) and the Legal Centre's support line — change all three
     * together. Nothing checks they agree.
     */
    T({
        key: 'contact',
        app: 'shop',
        path: '/contact',
        signIn: false,
        copy: {
            en: {
                title: 'Wi-Mall contact details: email, phone, Instagram, Facebook',
                summary: 'Wi-Mall support email, support phone/WhatsApp, Instagram and Facebook',
                steps: [
                    'Email: support@wi-mall.com',
                    'Support phone (also on WhatsApp): +237 621 236 023',
                    'Instagram: https://www.instagram.com/wimallshop/',
                    'Facebook: https://www.facebook.com/wimallshop',
                    'Or the contact form on the LINK above.',
                ],
                notes: [
                    'The support number is NOT this chat\'s number: this chat is the shopping assistant, that line reaches the Wi-Mall team.',
                    'For a problem with an order, a support request from this chat (topic support) reaches the team with the order attached, which is faster.',
                ],
            },
            fr: {
                title: 'Coordonnées Wi-Mall : e-mail, téléphone, Instagram, Facebook',
                summary: 'E-mail et téléphone/WhatsApp de l’assistance Wi-Mall, Instagram et Facebook',
                steps: [
                    'E-mail : support@wi-mall.com',
                    'Téléphone de l’assistance (aussi sur WhatsApp) : +237 621 236 023',
                    'Instagram : https://www.instagram.com/wimallshop/',
                    'Facebook : https://www.facebook.com/wimallshop',
                    'Ou le formulaire de contact au LIEN ci-dessus.',
                ],
                notes: [
                    'Le numéro de l’assistance n’est PAS celui de ce chat : ce chat est l’assistant d’achat, cette ligne joint l’équipe Wi-Mall.',
                    'Pour un problème de commande, une demande d’assistance depuis ce chat (sujet support) joint l’équipe avec la commande, c’est plus rapide.',
                ],
            },
        },
    }),
]);

/**
 * Every topic, every app. Keys are unique ACROSS apps — the tool passes a bare key, so a vendor
 * topic and a storefront topic can never share one. (`test:website-guide` pins it.)
 */
export const WEBSITE_GUIDE: readonly GuideTopic[] = Object.freeze([
    ...SHOP_GUIDE,
    ...VENDOR_GUIDE,
    ...AGENCY_GUIDE,
    ...AGENT_GUIDE,
]);

export const WEBSITE_GUIDE_KEYS: readonly string[] = Object.freeze(WEBSITE_GUIDE.map((t) => t.key));

/** The app keys. Asking for one answers that app's topic list. */
export const GUIDE_APPS: readonly GuideApp[] = Object.freeze(['shop', 'vendor', 'agency', 'agent'] as const);

function guideLanguage(language: string | null | undefined): GuideLanguage {
    return String(language ?? '').slice(0, 2).toLowerCase() === 'fr' ? 'fr' : 'en';
}

interface AppLabels {
    name: string;
    /** One line in the index: who uses it and what for. */
    blurb: string;
    signIn: string;
    noSignIn: string;
}

const APP_LABELS: Readonly<Record<GuideLanguage, Readonly<Record<GuideApp, AppLabels>>>> = Object.freeze({
    en: {
        shop: {
            name: 'WI-MALL WEBSITE (customers, wi-mall.com)',
            blurb: 'shopping, orders, deliveries, bookings, a customer\'s own account and notification settings',
            signIn: 'SIGN-IN: needed. If they are not signed in on the website, offer to send them a sign-in link (auth_send_login_link) first.',
            noSignIn: 'SIGN-IN: not needed.',
        },
        vendor: {
            name: 'VENDOR DASHBOARD (sellers: vendor.wi-mall.com, or the Wi-Mall Vendor app)',
            blurb: 'a seller running their store: products, stock, orders, delivery partners, money, plan, notification settings',
            signIn: 'SIGN-IN: needed, on the vendor dashboard with the seller\'s own account (topic vendorsignin). This chat cannot sign them in there and cannot see their dashboard.',
            noSignIn: 'SIGN-IN: not needed.',
        },
        agency: {
            name: 'AGENCY DASHBOARD (delivery agencies: agency.wi-mall.com, or the Wi-Mall Agency app)',
            blurb: 'a delivery agency: shipments, agents, partner vendors, cash on delivery, money, notification settings',
            signIn: 'SIGN-IN: needed, on the agency dashboard with the agency\'s own account (topic agencysignin). This chat cannot sign them in there and cannot see their dashboard.',
            noSignIn: 'SIGN-IN: not needed.',
        },
        agent: {
            name: 'WI-MALL AGENT APP (delivery agents, Android phone app)',
            blurb: 'a delivery agent: delivery offers, deliveries, cash collected, agencies, earnings, notification settings',
            signIn: 'SIGN-IN: needed, inside the Wi-Mall Agent app. This chat cannot see the app.',
            noSignIn: 'SIGN-IN: not needed.',
        },
    },
    fr: {
        shop: {
            name: 'SITE WI-MALL (clients, wi-mall.com)',
            blurb: 'achats, commandes, livraisons, réservations, le compte client et ses réglages de notifications',
            signIn: 'CONNEXION : nécessaire. S’ils ne sont pas connectés sur le site, proposez d’abord de leur envoyer un lien de connexion (auth_send_login_link).',
            noSignIn: 'CONNEXION : pas nécessaire.',
        },
        vendor: {
            name: 'TABLEAU DE BORD VENDEUR (vendeurs : vendor.wi-mall.com, ou l’app Wi-Mall Vendeur)',
            blurb: 'un vendeur qui gère sa boutique : produits, stock, commandes, partenaires de livraison, argent, forfait, notifications',
            signIn: 'CONNEXION : nécessaire, sur le tableau de bord vendeur avec le compte du vendeur (sujet vendorsignin). Ce chat ne peut pas l’y connecter ni voir son tableau de bord.',
            noSignIn: 'CONNEXION : pas nécessaire.',
        },
        agency: {
            name: 'TABLEAU DE BORD AGENCE (agences de livraison : agency.wi-mall.com, ou l’app Wi-Mall Agence)',
            blurb: 'une agence de livraison : expéditions, agents, vendeurs partenaires, paiement à la livraison, argent, notifications',
            signIn: 'CONNEXION : nécessaire, sur le tableau de bord agence avec le compte de l’agence (sujet agencysignin). Ce chat ne peut pas l’y connecter ni voir son tableau de bord.',
            noSignIn: 'CONNEXION : pas nécessaire.',
        },
        agent: {
            name: 'APP WI-MALL AGENT (livreurs, application Android)',
            blurb: 'un agent livreur : offres de livraison, livraisons, espèces encaissées, agences, gains, notifications',
            signIn: 'CONNEXION : nécessaire, dans l’app Wi-Mall Agent. Ce chat ne voit pas l’application.',
            noSignIn: 'CONNEXION : pas nécessaire.',
        },
    },
});

const LABELS: Readonly<Record<GuideLanguage, {
    link: string; steps: string; notes: string; topics: string; unknown: string;
    apps: string; appTopics: string; noLink: string; noBase: string;
}>> = Object.freeze({
    en: {
        link: 'LINK',
        steps: 'STEPS',
        notes: 'GOOD TO KNOW',
        topics: 'WEBSITE GUIDE — topics (call again with one of these keys):',
        unknown: 'No topic by that name.',
        apps: 'OTHER WI-MALL APPS — call again with the app key to list its topics:',
        appTopics: 'topics (call again with one of these keys):',
        noLink: 'none — this happens inside the Wi-Mall Agent phone app. If they do not have it yet: topic agentinstall.',
        noBase: '(the address is not configured — describe the steps only)',
    },
    fr: {
        link: 'LIEN',
        steps: 'ÉTAPES',
        notes: 'BON À SAVOIR',
        topics: 'GUIDE DU SITE — sujets (rappelez avec une de ces clés) :',
        unknown: 'Aucun sujet de ce nom.',
        apps: 'AUTRES APPLICATIONS WI-MALL — rappelez avec la clé de l’application pour lister ses sujets :',
        appTopics: 'sujets (rappelez avec une de ces clés) :',
        noLink: 'aucun — cela se fait dans l’application téléphone Wi-Mall Agent. S’ils ne l’ont pas encore : sujet agentinstall.',
        noBase: '(l’adresse n’est pas configurée — décrivez seulement les étapes)',
    },
});

/**
 * Where each app lives. Each defaults to the variable the notification buttons already use for
 * that app, so a link in a chat and a link in a notification can never point at two hosts.
 * A test passes its own.
 */
export interface GuideBases {
    shop?: string | null;
    vendor?: string | null;
    agency?: string | null;
}

function envBases(): Required<GuideBases> {
    return {
        shop: process.env.STOREFRONT_URL ?? null,
        vendor: process.env.VENDOR_APP_URL ?? null,
        agency: process.env.AGENCY_APP_URL ?? null,
    };
}

/**
 * The dashboards are single-page apps with NO locale in the URL — they keep the language as a
 * setting — so their link is the base and the path, joined once, with nothing in between.
 */
function dashboardUrl(path: string, base: string | null | undefined): string | null {
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}${path}`;
}

function topicLink(t: GuideTopic, language: string | null | undefined, lang: GuideLanguage, bases: Required<GuideBases>): string {
    const labels = LABELS[lang];
    if (t.app === 'agent' || t.path === null) return labels.noLink;
    const url = t.app === 'shop'
        // The customer's OWN language for the link, even where the text falls back to English.
        ? storefrontUrl(t.path, language ?? lang, bases.shop)
        : dashboardUrl(t.path, t.app === 'vendor' ? bases.vendor : bases.agency);
    return url ?? labels.noBase;
}

function topicList(app: GuideApp, lang: GuideLanguage): string[] {
    return WEBSITE_GUIDE.filter((t) => t.app === app).map((t) => `- ${t.key}: ${t.copy[lang].summary}`);
}

/**
 * One topic, as the text the tool returns — or a topic list, for an app key or a key it does
 * not know.
 *
 * ⚠ **An unknown key answers the LIST, never an error.** The caller is a model choosing from a
 * description; a refusal would leave it guessing again, while the list lets it pick correctly on
 * the next call. Same reasoning as a stale button answering with the current state.
 *
 * ⚠ **The default list is the STOREFRONT's, plus the three other app keys** — not every topic.
 * The tool truncates at 6000 characters, and a list cut off halfway is a list whose missing half
 * the model cannot know exists. `test:website-guide` holds every list under that cap.
 *
 * `baseUrl`: a string (or null) overrides the storefront alone, as it always has; an object
 * overrides any of the three hosts. Omitted, all three come from the environment.
 */
export function renderWebsiteGuide(
    key: string | null | undefined,
    language: string | null | undefined,
    baseUrl?: string | null | GuideBases,
): string {
    const lang = guideLanguage(language);
    const labels = LABELS[lang];
    const env = envBases();
    const bases: Required<GuideBases> = baseUrl === undefined
        ? env
        : typeof baseUrl === 'string' || baseUrl === null
            ? { ...env, shop: baseUrl }
            : { shop: baseUrl.shop ?? null, vendor: baseUrl.vendor ?? null, agency: baseUrl.agency ?? null };

    const wanted = String(key ?? '').toLowerCase();
    const app = (GUIDE_APPS as readonly string[]).includes(wanted) ? (wanted as GuideApp) : null;

    if (app) {
        return [`${APP_LABELS[lang][app].name} — ${labels.appTopics}`, ...topicList(app, lang)].join('\n');
    }

    const found = WEBSITE_GUIDE.find((t) => t.key === wanted);

    if (!found) {
        return [
            ...(key ? [labels.unknown, ''] : []),
            labels.topics,
            ...topicList('shop', lang),
            '',
            labels.apps,
            ...GUIDE_APPS.filter((a) => a !== 'shop')
                .map((a) => `- ${a}: ${APP_LABELS[lang][a].name} — ${APP_LABELS[lang][a].blurb}`),
        ].join('\n');
    }

    const copy = found.copy[lang];
    const appLabels = APP_LABELS[lang][found.app];

    return [
        copy.title.toUpperCase(),
        // A storefront topic reads exactly as it always has; the other apps say which app first,
        // because "open Settings" means a different screen in each.
        ...(found.app === 'shop' ? [] : [appLabels.name]),
        `${labels.link}: ${topicLink(found, language, lang, bases)}`,
        found.signIn ? appLabels.signIn : appLabels.noSignIn,
        '',
        `${labels.steps}:`,
        ...copy.steps.map((s, i) => `${i + 1}. ${s}`),
        ...(copy.notes.length ? ['', `${labels.notes}:`, ...copy.notes.map((n) => `- ${n}`)] : []),
    ].join('\n');
}
