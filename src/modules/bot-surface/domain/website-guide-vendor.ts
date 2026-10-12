import { GuideTopic, T } from './website-guide-types';

/**
 * The website guide — the VENDOR DASHBOARD (vendor.wi-mall.com, and the same app on Android).
 *
 * Read from `frontend/vendor-dash` itself on 2026-10-09: `App.tsx`,
 * `components/layout/DashboardShell.tsx`, the sidebar and mobile bar, every page and
 * `i18n/locales/{en,fr}`. Labels are QUOTED, as in the storefront topics — see the header of
 * `website-guide.ts`. Paths are checked against that repository by `verify:dashboard-routes`.
 *
 * ⚠ The dashboard has TWO layouts and a user on a phone does not see a sidebar: desktop is a
 * left sidebar, a phone (or the Android app) is a bottom bar whose last tab is "More" («Plus»).
 * A step that only says "Sidebar → X" strands a phone user, so the steps name both where the
 * two differ.
 */
export const VENDOR_GUIDE: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'vendormenu',
        app: 'vendor',
        path: '/dashboard',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: the map — where every page is',
                summary: 'Where things are: sidebar, phone bar, "+" menu, search, avatar menu',
                steps: [
                    'COMPUTER — left sidebar, top to bottom: "Overview", "Orders", "Products", "Inventory" (opens: alerts, reservations, history, requests, invoices), "Bookings" ("Services", "Appointments", "Calendar"), "Media", "Customers", "Transactions", "Analytics", "Notifications", "Tickets", "Agency" ("Connection", "Browse", "Delivery ratings").',
                    'At the bottom of the sidebar: "Account" ("Profile", "Store", "Addresses", "Verification", "Security", "Billing", "Payout Setup") and "Settings" ("Policies", "Notifications", "Preferences").',
                    'Header: "Search…" (Ctrl K) finds orders by number, products and customers; the "+" button ("Create") has "Add Product", "Create Order", "Add Service", "New Ticket", "Add Customer", "Upload Media"; the bell; the store logo menu with "Profile", "My Store" (opens the public shop) and "Logout".',
                    'PHONE or APP — bottom bar: "Overview", "Orders", a round "+" (the same Create menu), "Products", "More". "More" holds everything else, including Account and Settings.',
                ],
                notes: [
                    'Nothing in the menu is hidden by plan or status. The dashboard language is in Account → "Profile", not in the header.',
                    'Signing out on a phone: More → Account → "Profile" → the log-out icon at the top.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : le plan — où se trouve chaque page',
                summary: 'Où sont les choses : barre latérale, barre du téléphone, menu « + », recherche, menu du logo',
                steps: [
                    'ORDINATEUR — barre latérale gauche, de haut en bas : « Vue d’ensemble », « Commandes », « Produits », « Stock » (s’ouvre : alertes, réservations, historique, demandes, factures), « Réservations » (« Services », « Rendez-vous », « Agenda »), « Médias », « Clients », « Transactions », « Statistiques », « Notifications », « Tickets », « Agence » (« Connexion », « Parcourir », « Évaluations »).',
                    'En bas de la barre latérale : « Compte » (« Profil », « Boutique », « Adresses », « Vérification », « Sécurité », « Facturation », « Versements ») et « Paramètres » (« Politiques », « Notifications », « Préférences »).',
                    'En-tête : « Rechercher… » (Ctrl K) trouve les commandes par numéro, les produits et les clients ; le bouton « + » (« Créer ») contient « Ajouter un produit », « Créer une commande », « Ajouter un service », « Nouveau ticket », « Ajouter un client », « Envoyer un média » ; la cloche ; le menu du logo avec « Profil », « Ma boutique » (ouvre la boutique publique) et « Déconnexion ».',
                    'TÉLÉPHONE ou APP — barre du bas : « Vue d’ensemble », « Commandes », un « + » rond (le même menu Créer), « Produits », « Plus ». « Plus » contient tout le reste, dont Compte et Paramètres.',
                ],
                notes: [
                    'Rien n’est masqué selon le forfait ou le statut. La langue du tableau de bord est dans Compte → « Profil », pas dans l’en-tête.',
                    'Se déconnecter sur téléphone : Plus → Compte → « Profil » → l’icône de déconnexion en haut.',
                ],
            },
        },
    }),
    T({
        key: 'vendorsignin',
        app: 'vendor',
        path: '/login',
        signIn: false,
        copy: {
            en: {
                title: 'Vendor dashboard: signing in, creating a vendor account, forgotten password',
                summary: 'How a seller signs in or signs up, on the website and in the Android app',
                steps: [
                    'On the WEBSITE the dashboard has no form of its own: it shows "Go to login", which opens the Wi-Mall sign-in page. There tap the "Vendor" card, choose "Phone" or "Email", type the "Password" and tap "Sign in": the vendor dashboard opens. A new seller signs up at https://wi-mall.com/register?role=vendor ("Your Name", "Phone Number", optional email, "Business Name", "Password", tick the agreement, "Create account").',
                    'Forgotten password on the website: "Forgot password?" → type the phone number → "Continue", then send /password to the Wi-Mall bot FROM THAT NUMBER ("Open WhatsApp"); the bot replies with a link to choose a new one. Or "Reset with your email instead?" → "Send reset link".',
                    'In the ANDROID APP: choose "Phone" or "Email", type the number or email they signed up with and the "Password", then tap "Sign in". New sellers tap "Create a vendor account".',
                    'Creating the account in the app: "Your name", "Business name", "Phone number", optional "Email", "Password" (at least 8 characters) twice, tick the Terms box, then "Create account". The set-up steps follow (topic vendoronboarding).',
                    'Forgotten password (app): "Forgot your password?" → "Phone or email" → "Send reset link". The link lasts one hour; it opens "Choose a new password" → "Save new password".',
                ],
                notes: [
                    'Adding an email when signing up is optional, but it is how a forgotten password is recovered.',
                    'If the app offers "Next time, sign in with …", fingerprint or face sign-in can be turned on.',
                    'This chat cannot sign anyone in to the dashboard.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : se connecter, créer un compte vendeur, mot de passe oublié',
                summary: 'Comment un vendeur se connecte ou s’inscrit, sur le site et dans l’app Android',
                steps: [
                    'Sur le SITE, le tableau de bord n’a pas de formulaire : il affiche « Aller à la connexion », qui ouvre la page de connexion Wi-Mall. Là, touchez la carte « Vendeur », choisissez « Téléphone » ou « E-mail », saisissez le « Mot de passe » et « Se connecter » : le tableau de bord vendeur s’ouvre. Un nouveau vendeur s’inscrit sur https://wi-mall.com/fr/register?role=vendor (« Votre nom », « Numéro de téléphone », e-mail facultatif, « Nom de l’entreprise », « Mot de passe », cochez le contrat, « Créer un compte »).',
                    'Mot de passe oublié sur le site : « Mot de passe oublié ? » → saisissez le numéro → « Continuer », puis envoyez /password au bot Wi-Mall DEPUIS CE NUMÉRO (« Ouvrir WhatsApp ») ; le bot répond avec un lien pour en choisir un nouveau. Ou « Réinitialiser plutôt avec votre e-mail ? » → « Envoyer le lien ».',
                    'Dans l’APP ANDROID : choisissez « Téléphone » ou « E-mail », saisissez le numéro ou l’e-mail de l’inscription et le « Mot de passe », puis « Se connecter ». Un nouveau vendeur touche « Créer un compte vendeur ».',
                    'Créer le compte dans l’app : « Votre nom », « Nom de l’entreprise », « Numéro de téléphone », « E-mail » facultatif, « Mot de passe » (au moins 8 caractères) deux fois, cochez les Conditions, puis « Créer le compte ». Les étapes de configuration suivent (sujet vendoronboarding).',
                    'Mot de passe oublié (app) : « Mot de passe oublié ? » → « Téléphone ou e-mail » → « Envoyer le lien ». Le lien dure une heure ; il ouvre « Choisissez un nouveau mot de passe » → « Enregistrer le mot de passe ».',
                ],
                notes: [
                    'L’e-mail est facultatif à l’inscription, mais c’est lui qui permet de récupérer un mot de passe oublié.',
                    'Si l’app propose « La prochaine fois, se connecter avec … », la connexion par empreinte ou visage peut être activée.',
                    'Ce chat ne peut connecter personne au tableau de bord.',
                ],
            },
        },
    }),
    T({
        key: 'vendoronboarding',
        app: 'vendor',
        path: '/onboarding',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: the 4 set-up steps of a new store',
                summary: 'The set-up a new seller must finish before the dashboard opens',
                steps: [
                    '"Basic Setup": choose the "Country" (it can NEVER be changed later), the "Timezone", and add 1 to 3 "Payout Methods" with "Add payout method". Tap "Continue".',
                    '"Delivery": "Yes, I sell physical products" (optionally request a delivery agency right there) or "No, I only offer services". Tap "Continue" — an agency is not required to go on.',
                    '"Branding" (optional): logo, banner, business name, description and the business address. "Save & continue" or "Skip for now".',
                    '"Policies" (optional): return, cancellation and support policies. "Save & Finish" or "Skip for now" opens the dashboard.',
                ],
                notes: [
                    'The dashboard stays closed until all 4 steps are saved or skipped. Progress is kept between visits.',
                    'Everything except the country can be changed later in Account and Settings.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : les 4 étapes de configuration d’une nouvelle boutique',
                summary: 'La configuration qu’un nouveau vendeur doit finir avant que le tableau de bord s’ouvre',
                steps: [
                    '« Informations de base » : choisissez le « Pays » (il ne pourra JAMAIS être changé), le « Fuseau horaire », et ajoutez 1 à 3 « Moyens de versement ». Touchez « Continuer ».',
                    '« Livraison » : « Oui, je vends des produits physiques » (on peut demander une agence tout de suite) ou « Non, je propose uniquement des services ». Touchez « Continuer » — une agence n’est pas obligatoire pour continuer.',
                    '« Identité » (facultatif) : logo, bannière, nom, description et adresse de l’entreprise. « Enregistrer et continuer » ou « Passer pour l’instant ».',
                    '« Politiques » (facultatif) : retours, annulations et assistance. « Enregistrer et terminer » ou « Passer pour l’instant » ouvre le tableau de bord.',
                ],
                notes: [
                    'Le tableau de bord reste fermé tant que les 4 étapes ne sont pas enregistrées ou passées. La progression est gardée.',
                    'Tout sauf le pays se modifie ensuite dans Compte et Paramètres.',
                ],
            },
        },
    }),
    T({
        key: 'vendorpolicies',
        app: 'vendor',
        path: '/dashboard/settings/policies',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: return, cancellation and support policies',
                summary: 'Set the return, cancellation and support policies customers see',
                steps: [
                    'Open Settings → "Policies" (phone: More → Settings → Policies). The first card is "Policies".',
                    '"Return Policy": "Accept returns", "Return window" (0–180 days from delivery), "Refund" ("Full", "Partial" with a percentage, or "None"), "Return shipping paid by", "Refunded within" (1–30 business days), "Return condition notes".',
                    '"Cancellation Policy": "Allow cancellations", "Cancellation deadline", "Cancellation fee", "Late cancellation refund".',
                    '"Support Policy": up to 4 "Support channels" ("Add channel": Email, Phone, WhatsApp, Telegram), what the customer must provide, "Availability", "Languages". Up to 2 PDF "Policy Documents".',
                    'Tap "Save changes" in the bar at the bottom.',
                ],
                notes: [
                    'Switching a whole policy off deletes it: the shop then shows no policy, which customers read as "not offered".',
                    'Saving policies asks the connected delivery agencies to approve the store again.',
                    'A refund takes the store\'s share back (and delivery money in some cases); if already withdrawn, the next earnings pay it off.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : politiques de retour, d’annulation et d’assistance',
                summary: 'Régler les politiques de retour, d’annulation et d’assistance vues par les clients',
                steps: [
                    'Ouvrez Paramètres → « Politiques » (téléphone : Plus → Paramètres → Politiques). La première carte est « Conditions ».',
                    '« Politique de retour » : « Accepter les retours », « Délai de retour » (0–180 jours après livraison), « Remboursement » (« Intégral », « Partiel » avec un pourcentage, ou « Aucun »), « Frais de retour payés par », « Remboursé sous » (1–30 jours ouvrés), « Conditions de retour ».',
                    '« Politique d’annulation » : « Autoriser les annulations », « Date limite d’annulation », « Frais d’annulation », « Remboursement en cas d’annulation tardive ».',
                    '« Politique d’assistance » : jusqu’à 4 « Canaux d’assistance » (« Ajouter un canal » : E-mail, Téléphone, WhatsApp, Telegram), ce que le client doit fournir, « Disponibilité », « Langues ». Jusqu’à 2 PDF « Documents de politique ».',
                    'Touchez « Enregistrer les modifications » dans la barre du bas.',
                ],
                notes: [
                    'Désactiver une politique entière la supprime : la boutique n’affiche alors aucune politique, ce que les clients lisent comme « non proposé ».',
                    'Enregistrer les politiques demande aux agences connectées d’approuver de nouveau la boutique.',
                    'Un remboursement reprend la part de la boutique (et parfois la livraison) ; si l’argent a déjà été retiré, les gains suivants le compensent.',
                ],
            },
        },
    }),
    T({
        key: 'vendordelivery',
        app: 'vendor',
        path: '/dashboard/settings/policies',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: who pays delivery, and cash on delivery',
                summary: 'Free delivery, customer-paid delivery, free above an amount; accept cash on delivery or not',
                steps: [
                    'Open Settings → "Policies" and scroll to the "Delivery terms" card.',
                    'Pick "Always free for customers", "Customers pay delivery", or "Free above an amount" (then type "Free delivery from"). Save.',
                    'Next card, "Cash on delivery": switch "Accept cash on delivery" on or off, and optionally set "Most cash one agency may hold for me" (empty = no limit of yours). Save.',
                ],
                notes: [
                    'When delivery is free for the customer, the agency\'s fee comes out of the store\'s earnings.',
                    'Even with free delivery, a very small order whose delivery would cost more than 30% of it is charged to the customer.',
                    'These two cards do NOT ask agencies to re-approve the store, and orders already placed keep their old terms. Turning cash on delivery off applies at checkout at once.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : qui paie la livraison, et le paiement à la livraison',
                summary: 'Livraison offerte, payée par le client, offerte au-delà d’un montant ; accepter ou non le paiement à la livraison',
                steps: [
                    'Ouvrez Paramètres → « Politiques » et descendez jusqu’à la carte « Conditions de livraison ».',
                    'Choisissez « Toujours offerte aux clients », « Les clients paient la livraison » ou « Offerte à partir d’un montant » (puis saisissez « Livraison offerte à partir de »). Enregistrez.',
                    'Carte suivante, « Paiement à la livraison » : activez ou coupez « Accepter le paiement à la livraison », et réglez si besoin « Espèces maximum qu’une agence peut détenir pour moi » (vide = pas de limite de votre part). Enregistrez.',
                ],
                notes: [
                    'Quand la livraison est offerte au client, les frais de l’agence sont pris sur les gains de la boutique.',
                    'Même avec livraison offerte, une très petite commande dont la livraison coûterait plus de 30 % est facturée au client.',
                    'Ces deux cartes ne demandent PAS de nouvelle approbation aux agences, et les commandes déjà passées gardent leurs conditions. Couper le paiement à la livraison s’applique tout de suite au paiement.',
                ],
            },
        },
    }),
    T({
        key: 'vendorpreferences',
        app: 'vendor',
        path: '/dashboard/settings/preferences',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: theme, auto-dispatch and cancelling unpaid orders',
                summary: 'Light/dark theme; send paid orders to the agency automatically; cancel unpaid orders after N days',
                steps: [
                    'Open Settings → "Preferences" (phone: More → Settings → Preferences).',
                    '"Theme": "Light", "Dark" or "System" — applies at once, on this browser only.',
                    '"Auto-dispatch paid orders": when on, a paid physical order goes straight to the delivery agency. Optional "Maximum order total": bigger orders wait for a manual check.',
                    '"Cancel unpaid orders after" [1–90] "days". Then "Save changes".',
                ],
                notes: [
                    'Auto-dispatch is off by default. The dashboard language is not here: it is in Account → "Profile".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : thème, transmission automatique et annulation des impayés',
                summary: 'Thème clair/sombre ; envoyer les commandes payées à l’agence automatiquement ; annuler les impayés après N jours',
                steps: [
                    'Ouvrez Paramètres → « Préférences » (téléphone : Plus → Paramètres → Préférences).',
                    '« Thème » : « Clair », « Sombre » ou « Système » — s’applique tout de suite, sur ce navigateur seulement.',
                    '« Transmission automatique des commandes payées » : activée, une commande physique payée part directement à l’agence. « Montant maximum de la commande » facultatif : les commandes plus grosses attendent une vérification.',
                    '« Annuler les commandes impayées après » [1–90] « jours ». Puis « Enregistrer les modifications ».',
                ],
                notes: [
                    'La transmission automatique est coupée par défaut. La langue n’est pas ici : elle est dans Compte → « Profil ».',
                ],
            },
        },
    }),
    T({
        key: 'vendorprofile',
        app: 'vendor',
        path: '/dashboard/account/profile',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: my profile and the dashboard language',
                summary: 'Change name, photo, phone, WhatsApp, timezone, and the language (also used for notifications)',
                steps: [
                    'Open Account → "Profile" (or the store-logo menu → "Profile"; phone: More → gear on the profile card).',
                    'Tap the photo to change it; edit "Full Name", "Phone", "WhatsApp Number".',
                    'Under "Localization", choose the "Timezone" and the "Language" ("English" or "Français").',
                    'Tap "Save changes" at the bottom. The dashboard switches language at once.',
                ],
                notes: [
                    'The language here is ALSO the language of every notification (email, WhatsApp, Telegram, in-app).',
                    'The country is locked after set-up (support can change it). The sign-in email is changed in Account → "Security".',
                    'The public shop name is in Account → "Store", not here.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : mon profil et la langue du tableau de bord',
                summary: 'Changer nom, photo, téléphone, WhatsApp, fuseau horaire et langue (aussi celle des notifications)',
                steps: [
                    'Ouvrez Compte → « Profil » (ou le menu du logo → « Profil » ; téléphone : Plus → engrenage de la carte profil).',
                    'Touchez la photo pour la changer ; modifiez « Nom complet », « Téléphone », « Numéro WhatsApp ».',
                    'Sous « Localisation », choisissez le « Fuseau horaire » et la « Langue » (« English » ou « Français »).',
                    'Touchez « Enregistrer les modifications » en bas. Le tableau de bord change de langue aussitôt.',
                ],
                notes: [
                    'Cette langue est AUSSI celle de toutes les notifications (e-mail, WhatsApp, Telegram, application).',
                    'Le pays est verrouillé après la configuration (le support peut le changer). L’e-mail de connexion se change dans Compte → « Sécurité ».',
                    'Le nom public de la boutique est dans Compte → « Boutique », pas ici.',
                ],
            },
        },
    }),
    T({
        key: 'vendorstore',
        app: 'vendor',
        path: '/dashboard/account/store',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: store name, logo, banner, contacts, vacation mode',
                summary: 'Change the public store identity, support contacts, or close the store for a holiday',
                steps: [
                    'Open Account → "Store".',
                    'Logo and banner: "Add logo" / "Change logo", "Add banner" / "Change banner" (picked from the media library).',
                    '"Store identity": "Store name" (2–100 characters) and "Description". "Support & contact": "Support email", "Support phone", "WhatsApp" (leave empty to hide).',
                    'Tap "Save changes". "Preview as customer" and "View store" show the result.',
                    'Holiday: under "Store status" switch off "Store open for business" — it applies at once.',
                ],
                notes: [
                    'On vacation, products stay listed but cannot be ordered; existing orders are not affected.',
                    'Changing the name does not change the store web address; the address ("Slug") is locked — support can change it.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : nom, logo, bannière, contacts, mode congés',
                summary: 'Changer l’identité publique, les contacts d’assistance, ou fermer la boutique pour des congés',
                steps: [
                    'Ouvrez Compte → « Boutique ».',
                    'Logo et bannière : « Ajouter un logo » / « Changer le logo », bannière de même (choisis dans la médiathèque).',
                    '« Identité de la boutique » : « Nom de la boutique » (2–100 caractères) et « Description ». « Assistance et contact » : « E-mail d’assistance », « Téléphone d’assistance », « WhatsApp » (vide = masqué).',
                    'Touchez « Enregistrer les modifications ». « Aperçu client » et « Voir la boutique » montrent le résultat.',
                    'Congés : sous « Statut de la boutique », coupez « Boutique ouverte » — immédiat.',
                ],
                notes: [
                    'En congés, les produits restent visibles mais ne peuvent pas être commandés ; les commandes en cours ne changent pas.',
                    'Changer le nom ne change pas l’adresse web ; l’« Identifiant d’URL » est verrouillé — le support peut le changer.',
                ],
            },
        },
    }),
    T({
        key: 'vendoraddresses',
        app: 'vendor',
        path: '/dashboard/account/addresses',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: business / pickup addresses',
                summary: 'Add, change or remove the places orders are picked up from',
                steps: [
                    'Open Account → "Addresses" and tap "Add address".',
                    'Type in "Search a street, area, or city…" and PICK a result (until then it says "Not pinned yet."). Fill "Label" and "Address / landmark".',
                    'To remove one: the trash icon → "Remove". Then tap "Save changes".',
                ],
                notes: [
                    'Customers see no pickup point on products until there is at least one address. It must be inside the store\'s country.',
                    'An address still used as a product\'s pickup point blocks the save until that product is changed.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : adresses professionnelles / de retrait',
                summary: 'Ajouter, modifier ou retirer les lieux où les commandes sont enlevées',
                steps: [
                    'Ouvrez Compte → « Adresses » et touchez « Ajouter une adresse ».',
                    'Tapez dans « Recherchez une rue, un quartier ou une ville… » et CHOISISSEZ un résultat. Remplissez « Libellé » et « Adresse / point de repère ».',
                    'Pour en retirer une : la corbeille → « Supprimer ». Puis « Enregistrer les modifications ».',
                ],
                notes: [
                    'Aucun point de retrait n’apparaît sur les produits tant qu’il n’y a pas d’adresse. Elle doit être dans le pays de la boutique.',
                    'Une adresse encore utilisée comme point de retrait d’un produit bloque l’enregistrement tant que ce produit n’est pas modifié.',
                ],
            },
        },
    }),
    T({
        key: 'vendorverification',
        app: 'vendor',
        path: '/dashboard/account/verification',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: identity verification (verified shop badge)',
                summary: 'Upload ID documents and send them for review to get the shop verified',
                steps: [
                    'Open Account → "Verification" (a red "1" means a submission was refused).',
                    'Type the "ID number", then "Add" each document: "Front of your ID card", "Back of your ID card", "Photo of you holding your ID", and a map screenshot of the shop (or of home, when there is no business address).',
                    'Tap "Send for review", then "Send". After a refusal, fix what the "Reason" says and tap "Send again".',
                ],
                notes: [
                    'Files: JPG, PNG, WebP or PDF, up to 10 MB. Documents are private and saved as soon as they are added.',
                    'A person reviews them; nothing can be changed while "Being reviewed".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : vérification d’identité (badge boutique vérifiée)',
                summary: 'Envoyer les pièces d’identité en examen pour faire vérifier la boutique',
                steps: [
                    'Ouvrez Compte → « Vérification » (un « 1 » rouge signale un envoi refusé).',
                    'Saisissez le « Numéro de pièce d’identité », puis « Ajouter » chaque document : recto et verso de la carte, une photo de vous tenant la carte, et une capture de carte de la boutique (ou du domicile sans adresse professionnelle).',
                    'Touchez « Envoyer pour examen », puis « Envoyer ». Après un refus, corrigez selon le « Motif » et touchez « Renvoyer ».',
                ],
                notes: [
                    'Fichiers : JPG, PNG, WebP ou PDF, 10 Mo max. Les documents sont privés et enregistrés dès l’ajout.',
                    'Une personne les examine ; rien ne peut être modifié pendant « En cours d’examen ».',
                ],
            },
        },
    }),
    T({
        key: 'vendorsecurity',
        app: 'vendor',
        path: '/dashboard/account/security',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: password, sign-in email and phone',
                summary: 'Change the password, the sign-in email or phone, verify the phone',
                steps: [
                    'Open Account → "Security".',
                    'Email: "Change" (or "Add") → "New email address" → "Send confirmation link", then open the link within one hour.',
                    'Phone: "Change" → "New phone number" → "Continue", then type the six-digit code sent on WhatsApp and tap "Verify number". An unverified phone shows "Verify".',
                    'Password: "Current Password", "New Password" (8+ characters with upper case, lower case, number and symbol), "Confirm New Password" → "Update Password".',
                ],
                notes: [
                    'The old email or phone keeps working until the new one is confirmed. Changing the password signs out every other device.',
                    'Two-factor authentication is "Coming soon".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : mot de passe, e-mail et téléphone de connexion',
                summary: 'Changer le mot de passe, l’e-mail ou le téléphone de connexion, vérifier le téléphone',
                steps: [
                    'Ouvrez Compte → « Sécurité ».',
                    'E-mail : « Modifier » (ou « Ajouter ») → nouvelle adresse → « Envoyer le lien de confirmation », puis ouvrez le lien dans l’heure.',
                    'Téléphone : « Modifier » → nouveau numéro → « Continuer », puis saisissez le « Code à six chiffres » reçu sur WhatsApp et « Vérifier le numéro ». Un téléphone non vérifié affiche « Vérifier ».',
                    'Mot de passe : actuel, nouveau (8+ caractères avec majuscule, minuscule, chiffre et symbole), confirmation → « Mettre à jour le mot de passe ».',
                ],
                notes: [
                    'L’ancien e-mail ou téléphone reste valable jusqu’à la confirmation. Changer le mot de passe déconnecte tous les autres appareils.',
                    'La double authentification est « Bientôt disponible ».',
                ],
            },
        },
    }),
    T({
        key: 'vendorplan',
        app: 'vendor',
        path: '/dashboard/account/billing',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: plan, upgrade, credits and media storage',
                summary: 'See the current plan, buy a bigger plan or credits, check storage',
                steps: [
                    'Open Account → "Billing". The top card shows the plan, its expiry, "Commission", "Credit allowance" and "Active products".',
                    'Upgrade: under "Plans" tap "Choose plan", then pay with "Mobile Money" (choose the "Provider" and number → "Pay …", approve on the phone) or "Card payment".',
                    'Credits: under "Credit wallet" → "Top up", tap "Buy" on a pack and pay the same way.',
                    '"Media storage" shows space used; "Free up space" opens Media.',
                ],
                notes: [
                    'Buying plans or credits is NOT possible in the Android app — use the dashboard in a web browser.',
                    'A new paid plan is queued and starts when the current one ends. Hitting the product cap removes nothing; it only stops publishing more.',
                    'Credits pay for AI product indexing and WhatsApp messages to customers; they never expire.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : forfait, changement de formule, crédits et stockage',
                summary: 'Voir la formule actuelle, en acheter une plus grande ou des crédits, voir le stockage',
                steps: [
                    'Ouvrez Compte → « Facturation ». La carte du haut montre la formule, son expiration, la « Commission », l’« Allocation de crédits » et les « Produits actifs ».',
                    'Changer : sous « Formules », touchez « Choisir cette formule », puis payez par « Mobile Money » (opérateur et numéro → « Payer … », validez sur le téléphone) ou par carte.',
                    'Crédits : sous « Portefeuille de crédits » → « Recharger », touchez « Acheter » sur un pack et payez de même.',
                    '« Stockage des médias » montre l’espace utilisé ; « Libérer de l’espace » ouvre Médias.',
                ],
                notes: [
                    'Acheter une formule ou des crédits est IMPOSSIBLE dans l’app Android — utilisez le tableau de bord dans un navigateur.',
                    'Une nouvelle formule payante est mise en file et commence à la fin de l’actuelle. Atteindre le plafond de produits ne supprime rien ; cela empêche seulement d’en publier plus.',
                    'Les crédits paient l’indexation IA des produits et les messages WhatsApp aux clients ; ils n’expirent jamais.',
                ],
            },
        },
    }),
    T({
        key: 'vendorpayout',
        app: 'vendor',
        path: '/dashboard/account/payout',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: earnings, withdrawing money, payout numbers',
                summary: 'See available and pending earnings, request a withdrawal, set where money is sent',
                steps: [
                    'Open Account → "Payout Setup".',
                    '"Earnings" shows "Available" (can be withdrawn), "Pending" (ready 3 days after delivery) and "Requested". Tap "Request Withdrawal".',
                    'Where money goes: "Add payout method" → "Mobile Money", "Provider", "Phone Number", "Account Name" → "Save method", then "Save changes". Up to 3; the first ("Preferred") is used by default.',
                    '"View ticket" on the latest request shows its progress.',
                ],
                notes: [
                    'A withdrawal is reviewed and paid by Wi-Mall, not instant. Only one request at a time, and there is a minimum amount.',
                    'The account name must match the mobile-money account, or the transfer is refused. Bank and card payouts are "Soon".',
                    '"Owed from refunds" is paid off by the next earnings.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : gains, retirer de l’argent, numéros de versement',
                summary: 'Voir les gains disponibles et en attente, demander un retrait, choisir où l’argent est envoyé',
                steps: [
                    'Ouvrez Compte → « Versements ».',
                    '« Revenus » montre « Disponible » (retirable), « En attente » (disponible 3 jours après la livraison) et « Demandé ». Touchez « Demander un retrait ».',
                    'Destination : « Ajouter un moyen de versement » → « Mobile Money », « Opérateur », « Numéro de téléphone », « Nom du titulaire » → « Enregistrer le moyen », puis « Enregistrer les modifications ». Jusqu’à 3 ; le premier (« Préféré ») est utilisé par défaut.',
                    '« Voir le ticket » sur la dernière demande montre son avancement.',
                ],
                notes: [
                    'Un retrait est examiné et payé par Wi-Mall, pas instantané. Une seule demande à la fois, avec un montant minimum.',
                    'Le nom du titulaire doit correspondre au compte mobile money, sinon le virement est refusé. Banque et carte : « Bientôt ».',
                    '« Dû sur remboursements » est compensé par les gains suivants.',
                ],
            },
        },
    }),
    T({
        key: 'vendororders',
        app: 'vendor',
        path: '/dashboard/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: handling orders (processing, dispatch, cancel)',
                summary: 'Find an order, mark it processing, send it to the delivery agency, or cancel it',
                steps: [
                    'Open "Orders". Search by order number; "Filter orders" by status, payment, method, type or date. Click an order to open it.',
                    'Pending order: "Update Status" → "Mark as Processing".',
                    'To send it for delivery: "Dispatch to Agency" (in the order, or the row\'s ⋯ menu). Several at once: tick them, then "Dispatch to Agency".',
                    'To cancel: "Update Status" → "Cancel Order", type the word cancel in the box, then "Yes, Cancel Order".',
                    '"Print" gives a printable invoice; "Export" downloads the list as a file.',
                ],
                notes: [
                    'There is no "shipped" or "delivered" button: those come from the delivery agency. A store needs an active agency to dispatch (topic vendoragency).',
                    'If the agency is at its cash-on-delivery limit, choose "Dispatch anyway", "Choose another agency" or "Change my COD terms".',
                    'Cancelling a paid order does not refund automatically: Wi-Mall arranges it. An order under a payment dispute is frozen.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : gérer les commandes (préparation, transmission, annulation)',
                summary: 'Trouver une commande, la mettre en préparation, la transmettre à l’agence, ou l’annuler',
                steps: [
                    'Ouvrez « Commandes ». Cherchez par numéro ; filtrez par statut, paiement, moyen, type ou date. Cliquez une commande pour l’ouvrir.',
                    'Commande en attente : « Mettre à jour le statut » → « Marquer en préparation ».',
                    'Pour la livraison : « Transmettre à l’agence » (dans la commande, ou le menu ⋯ de la ligne). Plusieurs : cochez-les, puis « Transmettre à l’agence ».',
                    'Pour annuler : « Mettre à jour le statut » → « Annuler la commande », tapez le mot annuler, puis « Oui, annuler la commande ».',
                    '« Imprimer » donne une facture imprimable ; « Exporter » télécharge la liste.',
                ],
                notes: [
                    'Pas de bouton « expédiée » ou « livrée » : cela vient de l’agence. Il faut une agence active pour transmettre (sujet vendoragency).',
                    'Si l’agence a atteint sa limite de paiement à la livraison : « Expédier quand même », « Choisir une autre agence » ou « Modifier mes conditions ».',
                    'Annuler une commande payée ne rembourse pas automatiquement : Wi-Mall s’en charge. Une commande en litige de paiement est gelée.',
                ],
            },
        },
    }),
    T({
        key: 'vendorrefund',
        app: 'vendor',
        path: '/dashboard/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: refunding a customer',
                summary: 'Send money back to a customer for an order, fully or partly',
                steps: [
                    'Open "Orders" → the order → "Refund" (also on the customer\'s page under "Customers").',
                    'Check "Amount" (lower it for a partial refund), tick "The item was defective" if so (the customer also gets the delivery back, paid by the store), optional "Reason".',
                    'Tap "Refund {amount}". A chip on the order then shows the refund\'s progress.',
                ],
                notes: [
                    'Card payments go back in full; mobile money is sent to the paying number minus a 2% transfer fee; cash on delivery waits until the agency has handed the cash to Wi-Mall.',
                    'The store\'s share is taken back from its earnings. Some refunds need approval by Wi-Mall.',
                    '"Refund" is missing when refunds are disabled in the return policy, the order is unpaid, the return window ended, or a refund is already in progress.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : rembourser un client',
                summary: 'Rendre l’argent d’une commande à un client, en tout ou en partie',
                steps: [
                    'Ouvrez « Commandes » → la commande → « Rembourser » (aussi sur la fiche du client dans « Clients »).',
                    'Vérifiez le montant (baissez-le pour un remboursement partiel), cochez « L’article était défectueux » si c’est le cas (le client récupère aussi la livraison, payée par la boutique), motif facultatif.',
                    'Touchez « Rembourser {montant} ». Une puce sur la commande montre ensuite l’avancement.',
                ],
                notes: [
                    'Carte : remboursée en entier ; mobile money : envoyé au numéro payeur moins 2 % de frais ; paiement à la livraison : attend que l’agence ait remis les espèces à Wi-Mall.',
                    'La part de la boutique est reprise sur ses gains. Certains remboursements demandent l’accord de Wi-Mall.',
                    '« Rembourser » manque si la politique de retour l’interdit, si la commande est impayée, si le délai de retour est passé, ou si un remboursement est déjà en cours.',
                ],
            },
        },
    }),
    T({
        key: 'vendorfeechange',
        app: 'vendor',
        path: '/dashboard/orders',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: an agency asks to change a delivery fee',
                summary: 'Approve or reject a delivery-fee change on an order',
                steps: [
                    'On "Orders", the banner "N fee changes waiting for you" → "Open" (or open the order with the "Fee change" badge).',
                    'In "Delivery fee changes", read the new fee and "Your earnings on this order: … → …".',
                    'Tap "Approve" and confirm, or "Reject" (optional note) to keep the original fee.',
                ],
                notes: [
                    'The parcel cannot be picked up until the store answers. After a reject, the agency may propose once more or decline the delivery.',
                    'After moving a parcel to a dearer agency, "Cover the difference" pays the gap if the customer declines it.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : une agence demande à changer les frais de livraison',
                summary: 'Accepter ou refuser un changement de frais de livraison sur une commande',
                steps: [
                    'Sur « Commandes », la bannière « N changements de frais vous attendent » → « Ouvrir » (ou ouvrez la commande marquée « Frais modifiés »).',
                    'Dans « Changements de frais de livraison », lisez les nouveaux frais et l’effet sur vos gains.',
                    'Touchez « Accepter » et confirmez, ou « Refuser » (note facultative) pour garder les frais d’origine.',
                ],
                notes: [
                    'Le colis ne peut pas être enlevé tant que la boutique n’a pas répondu. Après un refus, l’agence peut proposer une fois de plus ou refuser la livraison.',
                    'Après avoir confié un colis à une agence plus chère, « Payer la différence » couvre l’écart si le client le refuse.',
                ],
            },
        },
    }),
    T({
        key: 'vendoragency',
        app: 'vendor',
        path: '/dashboard/agency/browse',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: finding and connecting to a delivery agency',
                summary: 'Request a delivery agency, approve a request, set the default, end a connection',
                steps: [
                    'Open "Agency" → "Browse". Search, or "Filter agencies" by region, city, capabilities, returns or claim window. "Terms" shows an agency\'s prices and rules.',
                    'Tap "Request connection". It shows "Pending" until the agency approves ("Withdraw" cancels it).',
                    'Open "Agency" → "Connection" to see them all. On an active one: "Set as default" or "Terminate". A request from an agency: "Approve" or "Reject". A paused one: "Reapprove". An ended one: "Request again".',
                    'Moving one item to another agency: in the order, tab "Items" → "Reassign".',
                ],
                notes: [
                    'A store selling physical products needs at least one ACTIVE agency to dispatch orders. The first approved one becomes the default.',
                    'Saving the store\'s policies can put connections back into "Reapproval needed".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : trouver une agence de livraison et s’y connecter',
                summary: 'Demander une agence, approuver une demande, choisir celle par défaut, mettre fin',
                steps: [
                    'Ouvrez « Agence » → « Parcourir ». Cherchez, ou filtrez par région, ville, capacités, retours ou délai de réclamation. le bouton des conditions montre les tarifs et règles d’une agence.',
                    'Touchez « Demander une connexion ». Elle reste « En attente » jusqu’à l’accord de l’agence (« Retirer » l’annule).',
                    'Ouvrez « Agence » → « Connexion » pour toutes les voir. Sur une active : « Définir par défaut » ou « Résilier ». Une demande d’agence : « Approuver » ou « Refuser ». Une en pause : « Réapprouver ». Une terminée : « Redemander ».',
                    'Confier un article à une autre agence : dans la commande, onglet « Articles » → « Réattribuer ».',
                ],
                notes: [
                    'Une boutique de produits physiques doit avoir au moins une agence ACTIVE pour transmettre ses commandes. La première approuvée devient celle par défaut.',
                    'Enregistrer les politiques de la boutique peut remettre les connexions en « Réapprobation requise ».',
                ],
            },
        },
    }),
    T({
        key: 'vendorrating',
        app: 'vendor',
        path: '/dashboard/agency/reviews',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: rating a delivery',
                summary: 'Give stars and a comment to a delivered shipment; see my ratings',
                steps: [
                    'Open "Orders" → the order → a shipment marked Delivered → "Rate delivery".',
                    'Choose 1–5 stars, optionally "Add a comment", then "Submit rating".',
                    'All ratings given are listed in "Agency" → "Delivery ratings".',
                ],
                notes: [
                    'Ratings cannot be changed or removed. A rating alone goes live at once; a comment is checked first.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : noter une livraison',
                summary: 'Donner des étoiles et un commentaire à une livraison terminée ; voir mes notes',
                steps: [
                    'Ouvrez « Commandes » → la commande → une expédition livrée → « Noter la livraison ».',
                    'Choisissez 1 à 5 étoiles, ajoutez un commentaire si besoin, puis « Envoyer la note ».',
                    'Toutes les notes données sont dans « Agence » → « Évaluations ».',
                ],
                notes: [
                    'Une note ne peut être ni modifiée ni supprimée. Une note seule est publiée tout de suite ; un commentaire est vérifié d’abord.',
                ],
            },
        },
    }),
    T({
        key: 'vendorcustomers',
        app: 'vendor',
        path: '/dashboard/customers',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: customers and customer flags',
                summary: 'See who bought from the store, their orders, and tag them with flags',
                steps: [
                    'Open "Customers". Search by name or email; "Filter customers" by flag or sort by spend or orders.',
                    'Click a customer for their orders (with "Refund" where possible), contact details and flags; "Assign" adds a flag; "Edit display name" sets a private name.',
                    '"Manage flags" → "New flag" (name, colour, description) → "Create flag".',
                ],
                notes: [
                    'Customers appear on their own after their first order — there is no add-customer form.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : clients et étiquettes',
                summary: 'Voir qui a acheté, leurs commandes, et les marquer avec des étiquettes',
                steps: [
                    'Ouvrez « Clients ». Cherchez par nom ou e-mail ; filtrez par étiquette ou triez par dépense ou commandes.',
                    'Cliquez un client pour ses commandes (avec « Rembourser » si possible), contacts et étiquettes ; « Attribuer » ajoute une étiquette ; le nom affiché peut être changé pour vous seul.',
                    '« Gérer les étiquettes » → nouvelle étiquette (nom, couleur, description) → créer.',
                ],
                notes: [
                    'Les clients apparaissent seuls après leur première commande — il n’y a pas de formulaire d’ajout.',
                ],
            },
        },
    }),
    T({
        key: 'vendorreports',
        app: 'vendor',
        path: '/dashboard/analytics',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: sales figures, analytics and transactions',
                summary: 'Sales, net revenue, top products, export a report; the list of all money movements',
                steps: [
                    '"Overview": sales, orders, net revenue and average order for a chosen period, recent orders and low stock.',
                    '"Analytics": tabs "Overview", "Sales", "Products", "Customers"; pick the period; "Export" downloads a report. The "Earnings" card explains net revenue (gross sales minus bargain fee, commission, delivery and cash-on-delivery fees).',
                    '"Transactions": every payment, refund and payout; "Filter transactions" by "Plan", "Credit", "Earning" or "Payout".',
                ],
                notes: [
                    'The "Quick Actions" tiles on Overview do nothing — use the "+" menu or the sidebar.',
                    'Withdrawals are requested in Account → "Payout Setup", not in Transactions.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : chiffres de vente, statistiques et transactions',
                summary: 'Ventes, revenu net, meilleurs produits, export ; la liste de tous les mouvements d’argent',
                steps: [
                    '« Vue d’ensemble » : ventes, commandes, revenu net et panier moyen sur une période, commandes récentes et stock faible.',
                    '« Statistiques » : onglets « Vue d’ensemble », « Ventes », « Produits », « Clients » ; choisissez la période ; « Exporter » télécharge un rapport. La carte des gains explique le revenu net (ventes brutes moins frais de marchandage, commission, livraison et paiement à la livraison).',
                    '« Transactions » : chaque paiement, remboursement et versement ; filtrez par « Formule », « Crédit », « Gain » ou « Versement ».',
                ],
                notes: [
                    'Les tuiles d’actions rapides de la Vue d’ensemble ne font rien — utilisez le menu « + » ou la barre latérale.',
                    'Les retraits se demandent dans Compte → « Versements », pas dans Transactions.',
                ],
            },
        },
    }),
    T({
        key: 'vendorclosure',
        app: 'vendor',
        path: '/dashboard/account/closure',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: answering a request to close the shop',
                summary: 'What to do when Wi-Mall asks to close the shop; a vendor cannot close it alone',
                steps: [
                    'A banner says "An administrator asked to close your shop" → "Review request".',
                    'Read "Why they asked", "If you agree" and "What you will lose". Everything under "Settle these first" must be cleared (open orders, bookings, cash parcels, payouts, earnings balance…).',
                    'Tap "Close my shop", tick the box, confirm — or "Keep my shop" (optional message) to refuse.',
                ],
                notes: [
                    'There is no "close my shop" button otherwise: closure only starts from an administrator\'s request, and nothing happens unless the vendor agrees. Doing nothing lets it expire.',
                    'A closed shop cannot be reopened; remaining plan time and credits are lost. Orders and money records are kept.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : répondre à une demande de fermeture de la boutique',
                summary: 'Que faire quand Wi-Mall demande la fermeture ; un vendeur ne peut pas fermer seul',
                steps: [
                    'Une bannière dit « Un administrateur a demandé la fermeture de votre boutique » → « Examiner la demande ».',
                    'Lisez « Pourquoi cette demande », « Si vous acceptez » et « Ce que vous perdrez ». Tout ce qui est sous « À régler d’abord » doit être réglé (commandes, réservations, colis en espèces, versements, solde…).',
                    'Touchez « Fermer ma boutique », cochez la case, confirmez — ou « Garder ma boutique » (message facultatif) pour refuser.',
                ],
                notes: [
                    'Il n’y a pas d’autre bouton de fermeture : elle part seulement d’une demande d’un administrateur, et rien ne se passe sans l’accord du vendeur. Sans réponse, la demande expire.',
                    'Une boutique fermée ne peut pas rouvrir ; le temps de forfait restant et les crédits sont perdus. Les commandes et écritures sont gardées.',
                ],
            },
        },
    }),
    T({
        key: 'vendoraddproduct',
        app: 'vendor',
        path: '/dashboard/product-upload/simple',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: adding a product (Quick add)',
                summary: 'Create a simple product: photos, name, description, categories, price, stock, publish',
                steps: [
                    '"Products" → "Add product" (or the "+" button → "Add Product"), then choose "Quick add" (one price, one stock count). For sizes/colours choose "Physical with variants"; for files "Digital product" (topic vendorvariants).',
                    'Add up to 7 "Photos" (the first is the thumbnail). Fill "Product name" and "Description" — "Generate" can write it with AI (topic vendoraicopy).',
                    '"Categories": 1 to 5, the first is the main one; type to search or add a new one. Optional "Tags".',
                    '"Price & stock": "Price", optional "Compare-at price", optional "Asking price" (bargaining, topic vendorbargain), "SKU" (blank = automatic), "Stock" or "Unlimited stock".',
                    'Tap "Save & publish", or "Save draft".',
                ],
                notes: [
                    'The kind of product cannot be changed later (a Quick add product can be converted to advanced, one way only).',
                    'Publishing needs a description, a delivery agency and a pickup location (set in the product\'s "Delivery" section when editing). If a category looks like an existing one, "Did you mean…?" asks which to keep.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : ajouter un produit (Ajout rapide)',
                summary: 'Créer un produit simple : photos, nom, description, catégories, prix, stock, publication',
                steps: [
                    '« Produits » → « Ajouter un produit » (ou le bouton « + » → « Ajouter un produit »), puis « Ajout rapide » (un prix, un stock). Pour tailles/couleurs : « Produit physique avec variantes » ; pour des fichiers : « Produit numérique » (sujet vendorvariants).',
                    'Ajoutez jusqu’à 7 « Photos » (la première est la vignette). Remplissez « Nom du produit » et « Description » — « Générer » peut l’écrire avec l’IA (sujet vendoraicopy).',
                    '« Catégories » : 1 à 5, la première est la principale ; tapez pour chercher ou en ajouter une. « Étiquettes » facultatives.',
                    '« Prix et stock » : prix, « Prix barré » facultatif, « Prix affiché » facultatif (marchandage, sujet vendorbargain), SKU (vide = automatique), stock ou « Stock illimité ».',
                    'Touchez « Enregistrer et publier », ou « Enregistrer le brouillon ».',
                ],
                notes: [
                    'Le type de produit ne change pas ensuite (un Ajout rapide peut être converti en avancé, sans retour).',
                    'Publier demande une description, une agence de livraison et un point de retrait (section « Livraison » en modification). Si une catégorie ressemble à une existante, une fenêtre demande laquelle garder.',
                ],
            },
        },
    }),
    T({
        key: 'vendorvariants',
        app: 'vendor',
        path: '/dashboard/product-upload',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: products with variants, and digital products',
                summary: 'Sizes and colours with per-variant price and stock; digital files with formats',
                steps: [
                    '"Products" → "Add product" → "Physical with variants" (or "Digital product").',
                    'Steps: "Type" → "Basic info" (title, description, categories) → "Media" (up to 7 images) → "Variants" (or "Formats") → "Review". Each step: "Save & continue".',
                    '"Variants": "Add option" (e.g. Color, Size) and its values, then "Apply & generate variants"; set each variant\'s price, SKU, stock and images.',
                    'Digital "Formats": up to 5 (e.g. PDF, ZIP), each with its file, price and download rules.',
                    '"Review": check "Delivery" and "Publishing requirements", then "Publish" or "Keep as draft".',
                ],
                notes: [
                    'At most 3 options and 1000 variants. Editing is locked while the product is being indexed for AI search.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : produits à variantes et produits numériques',
                summary: 'Tailles et couleurs avec prix et stock par variante ; fichiers numériques par format',
                steps: [
                    '« Produits » → « Ajouter un produit » → « Produit physique avec variantes » (ou « Produit numérique »).',
                    'Étapes : « Type » → « Informations » (titre, description, catégories) → « Médias » (jusqu’à 7 images) → « Variantes » (ou « Formats ») → « Vérification ». À chaque étape : « Enregistrer et continuer ».',
                    '« Variantes » : ajoutez une option (ex. Couleur, Taille) et ses valeurs, puis générez les variantes ; réglez prix, SKU, stock et images de chacune.',
                    '« Formats » numériques : jusqu’à 5 (ex. PDF, ZIP), chacun avec son fichier, son prix et ses règles de téléchargement.',
                    '« Vérification » : contrôlez la livraison et les conditions de publication, puis « Publier » ou « Garder en brouillon ».',
                ],
                notes: [
                    '3 options et 1000 variantes au maximum. La modification est bloquée pendant l’indexation pour la recherche IA.',
                ],
            },
        },
    }),
    T({
        key: 'vendorproducts',
        app: 'vendor',
        path: '/dashboard/products',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: managing products (publish, draft, archive, AI search, share)',
                summary: 'Publish or unpublish a product, archive or restore it, turn AI search on, share it',
                steps: [
                    'Open "Products". Each product\'s ⋯ menu ("Product actions") has "Edit", "Preview", "Share", "Publish Product", "Demote to Draft", "Archive Product", "Restore to Draft" and the AI search options.',
                    'Several at once: tick them, then "Publish selected", "Unpublish selected" or "Archive selected".',
                    'The "AI search" switch on a row lets shoppers (and the chat bot) find the product; it uses credits.',
                    '"Share" → "Share on WhatsApp", "Share on Telegram" or "Copy message".',
                ],
                notes: [
                    'There is no delete: archiving hides a product and it can be restored.',
                    '"Cannot publish yet" lists what is missing (description, price, agency, pickup location, plan limit…).',
                    'While AI indexing runs, editing is locked.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : gérer les produits (publier, brouillon, archiver, recherche IA, partager)',
                summary: 'Publier ou dépublier, archiver ou restaurer, activer la recherche IA, partager un produit',
                steps: [
                    'Ouvrez « Produits ». Le menu ⋯ de chaque produit (« Actions du produit ») contient « Modifier », « Aperçu », « Partager », « Publier le produit », « Repasser en brouillon », « Archiver le produit », « Restaurer en brouillon » et les options de recherche IA.',
                    'Plusieurs : cochez-les, puis « Publier la sélection », « Dépublier la sélection » ou « Archiver la sélection ».',
                    'L’interrupteur « Recherche IA » d’une ligne permet aux acheteurs (et au bot) de trouver le produit ; il consomme des crédits.',
                    '« Partager » → partager sur WhatsApp, Telegram, ou copier le message.',
                ],
                notes: [
                    'Pas de suppression : archiver masque un produit, qui peut être restauré.',
                    'La fenêtre de blocage liste ce qui manque pour publier (description, prix, agence, point de retrait, limite du forfait…).',
                    'Pendant l’indexation IA, la modification est bloquée.',
                ],
            },
        },
    }),
    T({
        key: 'vendoraicopy',
        app: 'vendor',
        path: '/dashboard/product-upload/simple',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: writing a product description with AI ("Generate")',
                summary: 'Let AI write the description, tags and SEO text from a photo and a few details',
                steps: [
                    'In a product (or service), tap "Generate" next to "Description".',
                    'Add at least one photo, the "Name", optionally the category and "Details to mention", and pick the language and what to write.',
                    'Tap "Generate", tick what to keep, then "Use selected". Read it over before saving.',
                ],
                notes: [
                    'It costs credits (shown before generating); a failed attempt is not charged. "Not enough credits" → "Top up".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : écrire une description avec l’IA (« Générer »)',
                summary: 'Laisser l’IA écrire description, étiquettes et textes SEO depuis une photo et quelques détails',
                steps: [
                    'Dans un produit (ou un service), touchez « Générer » à côté de « Description ».',
                    'Ajoutez au moins une photo, le « Nom », si besoin la catégorie et les détails à mentionner, puis la langue et ce qu’il faut écrire.',
                    'Touchez « Générer », cochez ce qu’il faut garder, puis « Utiliser la sélection ». Relisez avant d’enregistrer.',
                ],
                notes: [
                    'Cela coûte des crédits (affichés avant) ; un échec n’est pas facturé. Pas assez de crédits → recharger.',
                ],
            },
        },
    }),
    T({
        key: 'vendorbargain',
        app: 'vendor',
        path: '/dashboard/products',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: letting customers bargain (asking price)',
                summary: 'Turn price negotiation on for a product with an asking price; the price becomes the floor',
                steps: [
                    'Open the product. Quick add: "Price & stock" → "Asking price". Variants: "Review" → "Asking price & negotiation" → "Set".',
                    'Type an asking price at least 20% above the price. Shoppers see the asking price and can offer down; the normal price becomes the private floor.',
                    'Save. Leaving it blank switches bargaining off.',
                ],
                notes: [
                    'Bargaining only works once AI search is on for the product. There is no shop-wide negotiation setting.',
                    'A bargain fee is taken on bargained sales (see Analytics → "Earnings").',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : laisser les clients marchander (prix affiché)',
                summary: 'Activer la négociation avec un prix affiché ; le prix devient le plancher',
                steps: [
                    'Ouvrez le produit. Ajout rapide : « Prix et stock » → « Prix affiché ». Variantes : « Vérification » → la carte prix affiché et négociation → définir.',
                    'Saisissez un prix affiché au moins 20 % au-dessus du prix. Les acheteurs voient le prix affiché et proposent moins ; le prix normal devient le plancher privé.',
                    'Enregistrez. Laisser vide coupe le marchandage.',
                ],
                notes: [
                    'Le marchandage ne marche qu’avec la recherche IA activée sur le produit. Pas de réglage de négociation pour toute la boutique.',
                    'Des frais de marchandage sont pris sur les ventes marchandées (voir Statistiques → gains).',
                ],
            },
        },
    }),
    T({
        key: 'vendorinventory',
        app: 'vendor',
        path: '/dashboard/inventory/alerts',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: stock — low-stock alerts, adjusting, import, agency stock requests',
                summary: 'Fix low stock, set a quantity, import stock from a file, answer warehouse stock requests',
                steps: [
                    '"Inventory" → "Alerts": products at or below their threshold. "Adjust" → "New stock level (absolute)" → save.',
                    'Many at once: "Import CSV" → a file with columns variantId and quantity → "Upload" → "Apply update".',
                    'Stock kept at an agency\'s warehouse: changes go through "Stock requests" — "Propose a change" → product, variant, "New quantity (absolute)" → "Send request". An agency\'s request: "Approve" or "Reject".',
                    '"Reservations" (units held by open orders), "History" (every movement) and "Storage invoices" (the agency\'s monthly rent) are read-only.',
                ],
                notes: [
                    'Quantities are TOTALS, not amounts to add.',
                    'Storage invoices are settled directly with the agency; nothing comes out of earnings. The low-stock threshold is set on each product ("Low-stock alert at").',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : stock — alertes, ajustement, import, demandes de l’agence',
                summary: 'Corriger un stock faible, fixer une quantité, importer, répondre aux demandes d’entrepôt',
                steps: [
                    '« Stock » → « Alertes » : produits au seuil ou en dessous. « Ajuster » → nouveau niveau (absolu) → enregistrer.',
                    'En masse : « Importer un CSV » → fichier aux colonnes variantId et quantity → envoyer → appliquer.',
                    'Stock gardé dans l’entrepôt d’une agence : les changements passent par « Demandes de stock » — « Proposer une modification » → produit, variante, nouvelle quantité (absolue) → envoyer. Une demande de l’agence : « Approuver » ou « Refuser ».',
                    '« Réservations » (unités bloquées par des commandes), « Historique » (chaque mouvement) et « Factures de stockage » (loyer mensuel de l’agence) sont en lecture seule.',
                ],
                notes: [
                    'Les quantités sont des TOTAUX, pas des ajouts.',
                    'Les factures de stockage se règlent directement avec l’agence ; rien n’est pris sur les gains. Le seuil d’alerte se règle sur chaque produit.',
                ],
            },
        },
    }),
    T({
        key: 'vendorservices',
        app: 'vendor',
        path: '/dashboard/services',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: creating a bookable service',
                summary: 'Create a service customers can book: duration, price, booking mode, weekly hours',
                steps: [
                    'First connect Google Calendar: "Bookings" → "Calendar" → "Connect Google Calendar" (topic vendorcalendar).',
                    '"Bookings" → "Services" → "New service". Steps: "Details" (name, description — "Generate" helps) → "Images" → "Booking" ("Session duration", "Booking price", "Booking mode": "Calendar", "Manual" or "Capacity", buffers, optional peak-hours surcharge) → "Availability" (open days and hours) → "Review".',
                    'Tap "Publish" (or "Keep as draft").',
                ],
                notes: [
                    'Customers can only book once Google Calendar is connected.',
                    'Archive or unpublish a service from its ⋯ menu on "Services".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : créer un service réservable',
                summary: 'Créer un service à réserver : durée, prix, mode de réservation, horaires',
                steps: [
                    'Connectez d’abord Google Agenda : « Réservations » → « Agenda » → connexion Google Calendar (sujet vendorcalendar).',
                    '« Réservations » → « Services » → « Nouveau service ». Étapes : « Détails » (nom, description — « Générer » aide) → « Images » → « Réservation » (durée, prix, mode : agenda, manuel ou capacité, marges, supplément heures de pointe facultatif) → « Disponibilités » (jours et heures) → « Vérification ».',
                    'Touchez « Publier » (ou « Garder en brouillon »).',
                ],
                notes: [
                    'Les clients ne peuvent réserver qu’une fois Google Agenda connecté.',
                    'Archiver ou dépublier un service : son menu ⋯ dans « Services ».',
                ],
            },
        },
    }),
    T({
        key: 'vendorappointments',
        app: 'vendor',
        path: '/dashboard/services/appointments',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: handling bookings (confirm, reschedule, complete, cancel)',
                summary: 'Confirm a booking request, move it, mark it completed or no-show, cancel it, record cash',
                steps: [
                    '"Bookings" → "Appointments" (list or calendar view). Click a booking.',
                    'A pending one: "Confirm booking", "Reschedule" or "Cancel booking".',
                    'A confirmed one: "Complete & settle" (choose how to settle, then "Complete booking"), "Mark no-show", "Reschedule" or "Cancel booking".',
                    'Paid in cash: "Mark cash payment received".',
                ],
                notes: [
                    'The customer can only pay after the booking is confirmed. Booking earnings become available once it is completed.',
                    'Cancelling a paid booking refunds the customer and takes the earnings back.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : gérer les réservations (confirmer, reporter, terminer, annuler)',
                summary: 'Confirmer une demande, la déplacer, la terminer ou marquer l’absence, l’annuler, noter l’espèce',
                steps: [
                    '« Réservations » → « Rendez-vous » (liste ou calendrier). Cliquez une réservation.',
                    'En attente : « Confirmer la réservation », « Reporter » ou l’annuler.',
                    'Confirmée : « Terminer et régler » (choisissez comment régler, puis valider), « Marquer comme absence », « Reporter » ou l’annuler.',
                    'Payée en espèces : marquer le paiement en espèces reçu.',
                ],
                notes: [
                    'Le client ne peut payer qu’après confirmation. Les gains d’une réservation sont disponibles une fois terminée.',
                    'Annuler une réservation payée rembourse le client et reprend les gains.',
                ],
            },
        },
    }),
    T({
        key: 'vendorcalendar',
        app: 'vendor',
        path: '/dashboard/services/calendar',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: connecting Google Calendar for bookings',
                summary: 'Connect, reconnect or disconnect Google Calendar so customers can book',
                steps: [
                    '"Bookings" → "Calendar" → "Connect Google Calendar", sign in with Google and allow access.',
                    'If it says "Reconnection required", tap "Reconnect". "Disconnect" removes it.',
                ],
                notes: [
                    'Without a connected calendar customers cannot book. Bookings become events on it, and busy times are blocked from offered slots. Disconnecting does not delete existing bookings.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : connecter Google Agenda pour les réservations',
                summary: 'Connecter, reconnecter ou déconnecter Google Agenda pour permettre les réservations',
                steps: [
                    '« Réservations » → « Agenda » → connexion Google Calendar, connectez-vous avec Google et autorisez l’accès.',
                    'S’il faut se reconnecter, touchez le bouton de reconnexion. La déconnexion le retire.',
                ],
                notes: [
                    'Sans agenda connecté, les clients ne peuvent pas réserver. Les réservations deviennent des événements, et les heures occupées sont bloquées. Déconnecter ne supprime pas les réservations existantes.',
                ],
            },
        },
    }),
    T({
        key: 'vendormedia',
        app: 'vendor',
        path: '/dashboard/media',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: media library and freeing storage',
                summary: 'Upload photos and files, see where each is used, delete unused ones to free space',
                steps: [
                    'Open "Media" (or "+" → "Upload Media"). "Upload files" adds up to 10 files or 3 videos at once.',
                    'Filter "Unused only" to find files nothing uses. Click a file → "Delete file".',
                ],
                notes: [
                    'A file still used by a product, logo or banner must be detached first. Over the storage limit, files show "Locked" until space is freed or the plan upgraded.',
                    'Limits: images 10 MB, PDF 25 MB, video 70 MB.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : médiathèque et libérer du stockage',
                summary: 'Envoyer photos et fichiers, voir où chacun sert, supprimer les inutiles',
                steps: [
                    'Ouvrez « Médias » (ou « + » → « Envoyer un média »). « Envoyer des fichiers » ajoute jusqu’à 10 fichiers ou 3 vidéos.',
                    'Filtrez les fichiers inutilisés. Cliquez un fichier → « Supprimer le fichier ».',
                ],
                notes: [
                    'Un fichier utilisé par un produit, logo ou bannière doit d’abord être détaché. Au-delà de la limite, des fichiers sont verrouillés jusqu’à libérer de l’espace ou changer de formule.',
                    'Limites : images 10 Mo, PDF 25 Mo, vidéo 70 Mo.',
                ],
            },
        },
    }),
    T({
        key: 'vendortickets',
        app: 'vendor',
        path: '/dashboard/tickets',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: contacting Wi-Mall support (tickets)',
                summary: 'Open a support ticket about an order, product, booking or the shop; reply; close',
                steps: [
                    '"Tickets" → "New ticket" (or "+" → "New Ticket").',
                    'Choose the "Type", "Importance", "Related to" (an order, product, booking or "My shop"), write the "Subject" and "Description", add attachments, then "Create ticket".',
                    'In the ticket: write a note → "Send". "Close ticket" when solved.',
                ],
                notes: [
                    'Payout requests are followed as tickets too ("View ticket" on Payout Setup).',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : contacter le support Wi-Mall (tickets)',
                summary: 'Ouvrir un ticket sur une commande, un produit, une réservation ou la boutique ; répondre ; fermer',
                steps: [
                    '« Tickets » → « Nouveau ticket » (ou « + » → « Nouveau ticket »).',
                    'Choisissez le type, l’importance, l’élément concerné (commande, produit, réservation ou la boutique), écrivez l’objet et la description, ajoutez des pièces jointes, puis « Créer le ticket ».',
                    'Dans le ticket : écrivez une note → envoyer. « Fermer le ticket » une fois réglé.',
                ],
                notes: [
                    'Les demandes de versement sont aussi suivies en tickets (« Voir le ticket » dans Versements).',
                ],
            },
        },
    }),
    T({
        key: 'vendornotifications',
        app: 'vendor',
        path: '/dashboard/settings/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: notification settings (which events, which channel)',
                summary: 'Turn each store notification on or off, choose the extra channel, save',
                steps: [
                    'Computer: in the left sidebar, at the bottom, open "Settings", then the "Notifications" tab. Phone or app: tap "More" in the bottom bar, then "Settings", then "Notifications". (Also: the gear icon on the Notifications page.)',
                    'Under "Events" there is one switch per event: "New order", "Order cancelled", "New booking", "Booking cancelled", "Partial payment", "Full payment", "Media storage", "Warehoused products", "Agency connections", "Payout updates", "Shipment rejected", "Cash-on-delivery limits", "Delivery fee changes", "Plan updates". Switch off the ones they do not want.',
                    'Under "Delivery channel", tap "Use" on ONE extra channel (Telegram, Email or WhatsApp) — it turns "Active". Tapping "Active" again turns the extra channel off. A channel shows "Connect" instead until it is connected (topic vendorchannels).',
                    'Nothing is saved yet: tap "Save changes" in the bar that appears at the bottom ("Save" on a phone). "Discard" throws the changes away. They see "Notification settings saved".',
                ],
                notes: [
                    'Turning an event off silences it EVERYWHERE, including the bell inside the dashboard.',
                    '"In-app" (the bell) is always on and cannot be turned off. Only ONE extra channel can be active at a time.',
                    '"Plan updates" is greyed out: plan expiry warnings cannot be switched off.',
                    'There is no per-channel choice per event, no quiet hours and no digest. The notification language is the dashboard language, set in Account → "Profile".',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : réglages des notifications (quels événements, quel canal)',
                summary: 'Activer ou couper chaque notification de la boutique, choisir le canal en plus, enregistrer',
                steps: [
                    'Ordinateur : dans la barre latérale gauche, en bas, ouvrez « Paramètres », puis l’onglet « Notifications ». Téléphone ou app : touchez « Plus » dans la barre du bas, puis « Paramètres », puis « Notifications ». (Aussi : l’icône engrenage de la page Notifications.)',
                    'Sous « Événements », un interrupteur par événement : « Nouvelle commande », « Commande annulée », « Nouvelle réservation », « Réservation annulée », « Paiement partiel », « Paiement intégral », « Stockage des médias », « Produits entreposés », « Connexions d’agence », « Mises à jour de versement », « Expédition refusée », « Limites de paiement à la livraison », « Changements de frais de livraison », « Mises à jour de formule ». Coupez ceux dont ils ne veulent pas.',
                    'Sous « Canal de réception », touchez « Utiliser » sur UN canal en plus (Telegram, E-mail ou WhatsApp) — il passe à « Actif ». Toucher « Actif » à nouveau coupe le canal en plus. Tant qu’un canal n’est pas connecté, il affiche « Connecter » (sujet vendorchannels).',
                    'Rien n’est encore enregistré : touchez « Enregistrer les modifications » dans la barre qui apparaît en bas (« Enregistrer » sur téléphone). « Abandonner » annule. Ils voient « Réglages de notification enregistrés ».',
                ],
                notes: [
                    'Couper un événement le rend silencieux PARTOUT, y compris dans la cloche du tableau de bord.',
                    '« Dans l’application » (la cloche) est toujours actif et ne peut pas être coupé. Un seul canal en plus peut être actif à la fois.',
                    '« Mises à jour de formule » est grisé : les alertes d’expiration du forfait ne peuvent pas être coupées.',
                    'Pas de choix de canal par événement, pas d’heures calmes, pas de résumé. La langue des notifications est celle du tableau de bord, réglée dans Compte → « Profil ».',
                ],
            },
        },
    }),
    T({
        key: 'vendorchannels',
        app: 'vendor',
        path: '/dashboard/settings/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: connecting Telegram, WhatsApp or email for notifications',
                summary: 'Connect (or disconnect) Telegram, WhatsApp or email so notifications can go there',
                steps: [
                    'Open Settings → "Notifications" (topic vendornotifications) and find the channel under "Delivery channel".',
                    'Telegram or WhatsApp: tap "Connect". Send /connect to the Wi-Mall bot on that app (the "Open Telegram" / "Open WhatsApp" button opens it with the command ready). The bot replies with a 6-character code: type it in "Code from the bot" and tap "Connect".',
                    'Email: tap "Connect". A verification link is sent to the store email at once; open it, then tap "I\'ve done this — check". "Resend email" sends another.',
                    'When it says "… connected", tap "Done", then tap "Use" on that channel and "Save changes".',
                    'To stop using Telegram or WhatsApp: tap "Disconnect" on its row (immediate, no confirmation). Notifications then fall back to the in-app bell.',
                ],
                notes: [
                    'The code lasts 10 minutes and works once. After a failed try, send /connect again for a new code.',
                    '"That account is already linked to another Wi-Mall account" means this Telegram/WhatsApp is used by another account.',
                    'Email has no "Disconnect"; the email used is the one on Account → "Profile".',
                    'Connecting one app works for every role on the same Wi-Mall account.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : connecter Telegram, WhatsApp ou l’e-mail aux notifications',
                summary: 'Connecter (ou déconnecter) Telegram, WhatsApp ou l’e-mail pour y recevoir les notifications',
                steps: [
                    'Ouvrez Paramètres → « Notifications » (sujet vendornotifications) et trouvez le canal sous « Canal de réception ».',
                    'Telegram ou WhatsApp : touchez « Connecter ». Envoyez /connect au bot Wi-Mall sur cette application (le bouton « Ouvrir Telegram » / « Ouvrir WhatsApp » l’ouvre avec la commande prête). Le bot répond avec un code de 6 caractères : saisissez-le dans « Code envoyé par le bot » et touchez « Connecter ».',
                    'E-mail : touchez « Connecter ». Un lien de vérification part tout de suite vers l’e-mail de la boutique ; ouvrez-le, puis touchez « C’est fait — vérifier ». « Renvoyer l’e-mail » en envoie un autre.',
                    'Quand « … connecté » s’affiche, touchez « Terminé », puis « Utiliser » sur ce canal et « Enregistrer les modifications ».',
                    'Pour arrêter Telegram ou WhatsApp : touchez « Déconnecter » sur sa ligne (immédiat, sans confirmation). Les notifications reviennent alors à la cloche.',
                ],
                notes: [
                    'Le code dure 10 minutes et ne sert qu’une fois. Après un échec, renvoyez /connect pour un nouveau code.',
                    '« Ce compte est déjà lié à un autre compte Wi-Mall » : ce Telegram/WhatsApp est utilisé par un autre compte.',
                    'L’e-mail n’a pas de « Déconnecter » ; c’est l’adresse de Compte → « Profil ».',
                    'Connecter une application vaut pour tous les rôles du même compte Wi-Mall.',
                ],
            },
        },
    }),
    T({
        key: 'vendorpush',
        app: 'vendor',
        path: '/dashboard/settings/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: push notifications on a phone or browser',
                summary: 'Get pop-up alerts on this phone or computer, or fix blocked notifications',
                steps: [
                    'Open Settings → "Notifications" (or the Notifications page). At the top, tap the banner "Turn on push notifications".',
                    'Allow notifications when the browser or phone asks. They see "Push notifications enabled on this device".',
                    'If it says "Notifications are blocked", allow notifications for vendor.wi-mall.com in the browser settings (or for the app in the phone settings), then tap the banner again.',
                ],
                notes: [
                    'Push is per device: each phone or browser must be turned on separately. There is no push switch in the channel list.',
                    'On Android the alerts appear under "Store activity".',
                    'The banner only shows while push is not yet on; ✕ hides it.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : notifications push sur un téléphone ou un navigateur',
                summary: 'Recevoir des alertes sur ce téléphone ou cet ordinateur, ou débloquer les notifications',
                steps: [
                    'Ouvrez Paramètres → « Notifications » (ou la page Notifications). En haut, touchez la bannière « Activer les notifications push ».',
                    'Autorisez les notifications quand le navigateur ou le téléphone le demande. Ils voient « Notifications push activées sur cet appareil ».',
                    'Si c’est écrit « Les notifications sont bloquées », autorisez-les pour vendor.wi-mall.com dans les réglages du navigateur (ou pour l’app dans les réglages du téléphone), puis touchez de nouveau la bannière.',
                ],
                notes: [
                    'Le push se règle par appareil : chaque téléphone ou navigateur s’active séparément. Il n’y a pas d’interrupteur push dans la liste des canaux.',
                    'Sur Android, les alertes apparaissent sous « Activité de la boutique ».',
                    'La bannière n’apparaît que tant que le push n’est pas actif ; ✕ la masque.',
                ],
            },
        },
    }),
    T({
        key: 'vendorinbox',
        app: 'vendor',
        path: '/dashboard/notifications',
        signIn: true,
        copy: {
            en: {
                title: 'Vendor dashboard: reading notifications (the bell and the Notifications page)',
                summary: 'See, search, filter and mark notifications read; open what they are about',
                steps: [
                    'Computer: click the bell at the top right for the 5 latest unread, or "View all notifications". Phone: tap "More" (it shows the unread count), then "Notifications". The sidebar also has "Notifications".',
                    'On the page: "Mark all as read", or the ✓ "Mark as read" on one row. Search with "Search notifications…"; filter by "Read status" ("All", "Unread", "Read").',
                    'Tap a notification (or its link, e.g. "View order", "Answer request", "Manage plan") to open the order, booking, request or page it is about.',
                ],
                notes: [
                    'The page shows the latest 50. Notifications cannot be deleted.',
                ],
            },
            fr: {
                title: 'Tableau de bord vendeur : lire les notifications (la cloche et la page Notifications)',
                summary: 'Voir, chercher, filtrer, marquer comme lues ; ouvrir ce qu’elles concernent',
                steps: [
                    'Ordinateur : cliquez sur la cloche en haut à droite pour les 5 dernières non lues, ou « Voir toutes les notifications ». Téléphone : touchez « Plus » (il affiche le nombre de non lues), puis « Notifications ». La barre latérale a aussi « Notifications ».',
                    'Sur la page : « Tout marquer comme lu », ou le ✓ « Marquer comme lu » sur une ligne. Cherchez avec « Rechercher des notifications… » ; filtrez par « Statut de lecture » (« Toutes », « Non lues », « Lues »).',
                    'Touchez une notification (ou son lien, ex. « Voir la commande », « Répondre à la demande », « Gérer l’abonnement ») pour ouvrir la commande, la réservation, la demande ou la page concernée.',
                ],
                notes: [
                    'La page montre les 50 dernières. Les notifications ne peuvent pas être supprimées.',
                ],
            },
        },
    }),
]);
