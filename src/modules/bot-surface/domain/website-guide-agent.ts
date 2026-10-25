import { GuideTopic, T } from './website-guide-types';

/**
 * The website guide — the WI-MALL AGENT APP (Android, for delivery agents; launcher label
 * "Wi-Agent").
 *
 * Read from `frontend/agent_app` itself on 2026-10-09: the go_router shell, every feature's pages
 * and the ARB bundles (`app_en.arb` / `app_fr.arb`). Labels are QUOTED, as in the storefront
 * topics — see the header of `website-guide.ts`.
 *
 * ⚠ **No topic here has a path.** The app has screens, not web addresses, so there is no link to
 * hand over and nothing for a route check to resolve: the steps ARE the directions. The bottom
 * bar is "Home" · "Shipments" · "COD" · "More" («Accueil» · «Livraisons» · «Espèces» · «Plus»),
 * and the bell at the top right of the main screens opens "Alerts" («Alertes»).
 */
export const AGENT_GUIDE: readonly GuideTopic[] = Object.freeze([
    T({
        key: 'agentinstall',
        app: 'agent',
        path: null,
        signIn: false,
        copy: {
            en: {
                title: 'Getting the Wi-Mall Agent app',
                summary: 'Where to download the delivery-agent app and how to install it',
                steps: [
                    'Open https://wi-mall.com/apps on the Android phone and tap the download for the Wi-Mall Agent app.',
                    'Open the downloaded file. If Android asks, allow the browser to "install unknown apps", then tap Install.',
                    'The app appears on the phone as "Wi-Agent". Open it and tap "Register" to create an agent account (topic agentsignin).',
                ],
                notes: [
                    'Android only. It is not on Google Play yet, and there is no iPhone version and no agent website.',
                    'Agents sign up in the app, not on the website.',
                ],
            },
            fr: {
                title: 'Obtenir l’app Wi-Mall Agent',
                summary: 'Où télécharger l’app des livreurs et comment l’installer',
                steps: [
                    'Ouvrez https://wi-mall.com/fr/apps sur le téléphone Android et touchez le téléchargement de l’app Wi-Mall Agent.',
                    'Ouvrez le fichier téléchargé. Si Android le demande, autorisez le navigateur à installer des applications inconnues, puis touchez Installer.',
                    'L’app apparaît sur le téléphone sous le nom « Wi-Agent ». Ouvrez-la et touchez « S’inscrire » pour créer un compte livreur (sujet agentsignin).',
                ],
                notes: [
                    'Android seulement. Elle n’est pas encore sur Google Play, et il n’y a ni version iPhone ni site pour les livreurs.',
                    'Les livreurs s’inscrivent dans l’app, pas sur le site.',
                ],
            },
        },
    }),
    T({
        key: 'agentsignin',
        app: 'agent',
        path: null,
        signIn: false,
        copy: {
            en: {
                title: 'Agent app: signing in and creating an agent account',
                summary: 'Sign in with phone or email and password; register as a new delivery agent',
                steps: [
                    'Sign in: choose "Phone" or "Email", type the number or email and the "Password", tap "Sign in".',
                    'New agent: tap "Register". Fill "Full name" (as on the ID), "Phone number" (used to sign in), optional "Email address", a "Password" and "Confirm password", tick the Terms box, then "Create account".',
                    'The password needs at least 8 characters, an uppercase letter, a lowercase letter, a number and a symbol — the "Still needed" list shows what is missing.',
                    'Then the set-up steps (topic agentonboarding).',
                ],
                notes: [
                    'The app has NO "Forgot password" link. Use the website: https://wi-mall.com/forgot-password → phone number → "Continue", then send /password to the Wi-Mall bot from that number; the bot replies with a link to choose a new password.',
                    'Agents can also create the account on the website first: https://wi-mall.com/register?role=agent, then sign in in the app.',
                    '"This number already has an account" means they should sign in instead.',
                    'No code is asked at sign-up: the phone is verified later from the Profile, and that is what activates the account.',
                ],
            },
            fr: {
                title: 'App agent : se connecter et créer un compte livreur',
                summary: 'Se connecter par téléphone ou e-mail et mot de passe ; s’inscrire comme livreur',
                steps: [
                    'Connexion : choisissez « Téléphone » ou « E-mail », saisissez le numéro ou l’e-mail et le « Mot de passe », touchez « Se connecter ».',
                    'Nouveau livreur : touchez « S’inscrire ». Remplissez « Nom complet » (comme sur la pièce d’identité), « Numéro de téléphone » (sert à se connecter), « Adresse e-mail (facultatif) », « Mot de passe » et « Confirmez le mot de passe », cochez les Conditions, puis « Créer le compte ».',
                    'Le mot de passe demande au moins 8 caractères, une majuscule, une minuscule, un chiffre et un symbole — la liste « Il manque encore » montre ce qui manque.',
                    'Ensuite les étapes de configuration (sujet agentonboarding).',
                ],
                notes: [
                    'L’app n’a PAS de lien « Mot de passe oublié ». Passez par le site : https://wi-mall.com/fr/forgot-password → numéro → « Continuer », puis envoyez /password au bot Wi-Mall depuis ce numéro ; le bot répond avec un lien pour choisir un nouveau mot de passe.',
                    'Les livreurs peuvent aussi créer le compte sur le site d’abord : https://wi-mall.com/fr/register?role=agent, puis se connecter dans l’app.',
                    '« Ce numéro a déjà un compte » : il faut se connecter plutôt.',
                    'Aucun code n’est demandé à l’inscription : le téléphone se vérifie ensuite depuis le Profil, et c’est ce qui active le compte.',
                ],
            },
        },
    }),
    T({
        key: 'agentonboarding',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: first set-up (vehicle, then the tour)',
                summary: 'The vehicle step, the optional timezone, and the first-run tour',
                steps: [
                    '"Tell us about your vehicle": pick the "Vehicle type" ("Bike", "Car", "Van", "Truck") and the "Color"; "Plate number" and a photo are optional. Tap "Continue". The app stays locked until this is done.',
                    'Optional "Timezone", then "Finish" or "Skip for now".',
                    'The tour then asks, one page each: switch on location, "Share my location", allow notifications, fingerprint sign-in, language. "Skip" skips a page (twice quickly skips the rest).',
                    'The last page, "Welcome aboard", has "Browse Delivery Agencies": apply to an agency there (topic agentagencies).',
                ],
                notes: [
                    'Deliveries only come through an agency: nothing is offered until an agency accepts the agent.',
                ],
            },
            fr: {
                title: 'App agent : première configuration (véhicule, puis la visite)',
                summary: 'L’étape véhicule, le fuseau horaire facultatif, et la visite de démarrage',
                steps: [
                    '« Parlez-nous de votre véhicule » : choisissez le « Type de véhicule » (« Moto », « Voiture », « Fourgonnette », « Camion ») et la « Couleur » ; la plaque et la photo sont facultatives. Touchez « Continuer ». L’app reste bloquée tant que ce n’est pas fait.',
                    '« Fuseau horaire (facultatif) », puis « Terminer » ou « Passer pour l’instant ».',
                    'La visite demande ensuite, une page chacune : activer la localisation, « Partager ma position », autoriser les notifications, connexion par empreinte, langue. « Passer » saute une page (deux fois vite saute le reste).',
                    'La dernière page, « Bienvenue à bord », propose « Parcourir les agences de livraison » : postulez à une agence (sujet agentagencies).',
                ],
                notes: [
                    'Les livraisons passent uniquement par une agence : rien n’est proposé tant qu’une agence n’a pas accepté le livreur.',
                ],
            },
        },
    }),
    T({
        key: 'agentmenu',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: the map — where every screen is',
                summary: 'Where things are: the 4 tabs, the bell, and the More menu',
                steps: [
                    'Bottom bar: "Home" (status, today\'s totals, new offers, active jobs), "Shipments" (deliveries), "COD" (cash held and deposits), "More".',
                    'The bell at the top right opens "Alerts"; its sliders icon opens the notification settings.',
                    '"More" → "Account": "Profile", "Identity verification", "Receiving orders", "Change password", "My agencies", "Support tickets", "Storage". Then "Location sharing" (the switch), "Money": "Earnings & payouts", "My earnings", "Plan", "Credits", "Transactions". Then "Appearance": "Theme", "Language", "Navigation", "Time zone".',
                    'Sign out is at the top right of the "Profile" screen, not in More.',
                ],
                notes: [
                    'Offers have no tab: they show on Home ("See all") and arrive as notifications.',
                ],
            },
            fr: {
                title: 'App agent : le plan — où se trouve chaque écran',
                summary: 'Où sont les choses : les 4 onglets, la cloche, et le menu Plus',
                steps: [
                    'Barre du bas : « Accueil » (statut, totaux du jour, nouvelles propositions, courses en cours), « Livraisons », « Espèces » (espèces détenues et dépôts), « Plus ».',
                    'La cloche en haut à droite ouvre « Alertes » ; son icône curseurs ouvre les réglages des notifications.',
                    '« Plus » → « Compte » : « Profil », « Vérification d’identité », « Réception des commandes », « Changer le mot de passe », « Mes agences », « Tickets d’assistance », « Stockage ». Puis « Partage de position » (l’interrupteur), « Argent » : « Revenus et virements », « Mes gains », « Forfait », « Crédits », « Transactions ». Puis « Apparence » : « Thème », « Langue », « Navigation », « Fuseau horaire ».',
                    'La déconnexion est en haut à droite de l’écran « Profil », pas dans Plus.',
                ],
                notes: [
                    'Les propositions n’ont pas d’onglet : elles s’affichent sur l’Accueil (« Tout voir ») et arrivent en notification.',
                ],
            },
        },
    }),
    T({
        key: 'agentstatus',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: going online, on break or offline',
                summary: 'Change duty status so offers can (or cannot) reach the agent',
                steps: [
                    'On "Home", tap the status chip under the greeting (or the availability banner).',
                    'Pick "Online" (offers can reach you), "On break" (no new offers, current jobs unaffected) or "Offline" (done for now).',
                ],
                notes: [
                    '"Your account isn\'t active yet, so you can\'t go online": verify the phone number on the Profile first.',
                ],
            },
            fr: {
                title: 'App agent : passer en ligne, en pause ou hors service',
                summary: 'Changer de statut pour que les propositions arrivent (ou non)',
                steps: [
                    'Sur « Accueil », touchez la puce de statut sous la salutation (ou la bannière de disponibilité).',
                    'Choisissez « En ligne » (les propositions arrivent), « En pause » (pas de nouvelle proposition, les courses en cours ne changent pas) ou « Hors service » (terminé pour l’instant).',
                ],
                notes: [
                    '« Votre compte n’est pas encore actif, vous ne pouvez donc pas passer en ligne » : vérifiez d’abord le numéro de téléphone sur le Profil.',
                ],
            },
        },
    }),
    T({
        key: 'agentnooffers',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: why no delivery offers arrive ("Receiving orders")',
                summary: 'Check what stops offers reaching the agent and fix each point',
                steps: [
                    'Open "More" → "Receiving orders" (or tap the red "You can\'t receive orders right now" notice on Home).',
                    'Each item under "To fix" has its own button: "Account not activated" → "Open my profile" (verify the phone); "No agency" → "Find an agency"; "Agency request pending" → "See my agencies"; "You\'re offline" or "You\'re on a break" → "Change my status"; "Location is off" → the location buttons; "Delivery limit reached" → "See plans".',
                    '"Account suspended", "Account not active" or "Tracking not allowed" → "Contact support": only Wi-Mall can fix those.',
                ],
                notes: [
                    'Cash-on-delivery orders also need identity verification ("Verify my identity"); prepaid orders arrive meanwhile.',
                    'Even when everything is in order, each offer depends on the delivery itself (place, value, the agency\'s terms).',
                ],
            },
            fr: {
                title: 'App agent : pourquoi aucune proposition n’arrive (« Réception des commandes »)',
                summary: 'Voir ce qui empêche les propositions d’arriver et régler chaque point',
                steps: [
                    'Ouvrez « Plus » → « Réception des commandes » (ou touchez l’avis rouge « Vous ne pouvez pas recevoir de commandes pour le moment » sur l’Accueil).',
                    'Chaque point sous « À régler » a son bouton : « Compte non activé » → « Ouvrir mon profil » (vérifier le téléphone) ; « Aucune agence » → « Trouver une agence » ; « Demande d’agence en attente » → « Voir mes agences » ; « Vous êtes hors ligne » ou « Vous êtes en pause » → « Changer mon statut » ; « Localisation désactivée » → les boutons de localisation ; « Limite de livraisons atteinte » → « Voir les forfaits ».',
                    '« Compte suspendu », « Compte inactif » ou « Suivi non autorisé » → « Contacter le support » : seul Wi-Mall peut les régler.',
                ],
                notes: [
                    'Les commandes payées à la livraison demandent aussi la vérification d’identité (« Vérifier mon identité ») ; les commandes prépayées arrivent en attendant.',
                    'Même tout en ordre, chaque proposition dépend de la livraison (lieu, valeur, conditions de l’agence).',
                ],
            },
        },
    }),
    T({
        key: 'agentoffers',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: accepting or declining a delivery offer',
                summary: 'See waiting offers and accept or decline them',
                steps: [
                    'On "Home", under "New offers", tap "See all" (or tap the offer notification).',
                    'Tap an offer to see the fee, payment ("Cash on delivery" or "Prepaid"), the cash to carry, the journey and the items.',
                    'Tap "Accept" or "Decline". After "Offer accepted." the delivery opens in "Shipments". The notification\'s own "Accept" / "Decline" buttons work too.',
                ],
                notes: [
                    'Several agents may hold the same offer: the first to accept gets it. When the countdown ends the button reads "Expired".',
                    'The full address and the customer\'s number appear only after accepting.',
                    'A cash-on-delivery offer can be refused for an unverified identity, too much cash held, the contract\'s regions or value ceiling, or being at capacity — the message says which.',
                ],
            },
            fr: {
                title: 'App agent : accepter ou refuser une proposition de livraison',
                summary: 'Voir les propositions en attente et les accepter ou refuser',
                steps: [
                    'Sur « Accueil », sous « Nouvelles propositions », touchez « Tout voir » (ou la notification de la proposition).',
                    'Touchez une proposition pour voir les frais, le paiement (« Paiement à la livraison » ou « Prépayé »), les espèces à encaisser, le trajet et les articles.',
                    'Touchez « Accepter » ou « Refuser ». Après « Proposition acceptée. », la livraison s’ouvre dans « Livraisons ». Les boutons « Accepter » / « Refuser » de la notification marchent aussi.',
                ],
                notes: [
                    'Plusieurs livreurs peuvent avoir la même proposition : le premier qui accepte l’obtient. À la fin du compte à rebours, le bouton affiche « Expirée ».',
                    'L’adresse complète et le numéro du client n’apparaissent qu’après acceptation.',
                    'Une proposition en espèces peut être refusée pour identité non vérifiée, trop d’espèces détenues, régions ou plafond du contrat, ou capacité atteinte — le message dit laquelle.',
                ],
            },
        },
    }),
    T({
        key: 'agentdeliveries',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: doing a delivery, step by step',
                summary: 'Open a delivery and move it on with the slider: picked up, on the way, at the customer',
                steps: [
                    'Tap "Shipments", tab "Active", and open the delivery. The top says what to do next; "Pick up from" and "Deliver to" open the contacts ("Call", WhatsApp, "Text message", "Navigate here").',
                    'At the bottom, DRAG the slider to the end: "Mark picked up" → "Start the delivery" → "I\'m at the customer".',
                    'Cash order: at the customer the slider becomes "Collect cash" (topic agentcollectcash). Prepaid order: it waits ("Waiting on the customer") — the customer confirms delivery.',
                    'Optional but useful: under "Delivery proof", "Add photo" of the parcel where it was left.',
                ],
                notes: [
                    'There is no "Delivered" step on the slider: a cash order is delivered by the customer\'s code, a prepaid one by the customer\'s confirmation.',
                    'Other actions (failed attempt, return, give up) are behind a DOUBLE-TAP on the slider handle (topic agentproblem).',
                    'Without signal the step is saved on the phone and sent later (More → "Pending updates").',
                ],
            },
            fr: {
                title: 'App agent : faire une livraison, étape par étape',
                summary: 'Ouvrir une livraison et la faire avancer au curseur : récupérée, en route, chez le client',
                steps: [
                    'Touchez « Livraisons », onglet « En cours », et ouvrez la livraison. Le haut dit quoi faire ; « Enlèvement chez » et « Livrer à » ouvrent les contacts (« Appeler », WhatsApp, « SMS », « M’y rendre »).',
                    'En bas, FAITES GLISSER le curseur jusqu’au bout : « Marquer comme récupérée » → « Démarrer la livraison » → « Je suis chez le client ».',
                    'Commande en espèces : chez le client, le curseur devient « Encaisser » (sujet agentcollectcash). Commande prépayée : il attend (« En attente du client ») — le client confirme la livraison.',
                    'Utile : sous « Preuve de livraison », « Ajouter une photo » du colis là où il a été laissé.',
                ],
                notes: [
                    'Il n’y a pas d’étape « Livrée » sur le curseur : une commande en espèces est livrée par le code du client, une prépayée par sa confirmation.',
                    'Les autres actions (tentative échouée, retour, abandon) sont derrière un DOUBLE APPUI sur la poignée du curseur (sujet agentproblem).',
                    'Sans réseau, l’étape est gardée sur le téléphone et envoyée plus tard (Plus → « Mises à jour en attente »).',
                ],
            },
        },
    }),
    T({
        key: 'agentproblem',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: failed attempt, returning the parcel, giving up a delivery',
                summary: 'Customer unreachable, refused, address not found; return the parcel; hand the job back',
                steps: [
                    'Open the delivery and DOUBLE-TAP (or long-press) the slider handle at the bottom.',
                    '"Report a failed attempt": pick what happened (e.g. "Customer unreachable", "Nobody there", "Customer refused the parcel", "Address not found"), optional note, "Report". The parcel and the job stay yours — try again later with "Start the delivery".',
                    '"Return the parcel": the parcel goes back and the job closes — "Return it".',
                    '"Give up this delivery": pick a reason (e.g. "Vehicle broke down", "Personal emergency") → "Give up". It is offered to another agent at once.',
                ],
                notes: [
                    '"Something else" needs a note. Giving up is not possible once at the customer\'s door.',
                    'A failed parcel left unreturned holds a capacity slot and, on a cash order, cash-on-delivery room.',
                ],
            },
            fr: {
                title: 'App agent : tentative échouée, retour du colis, abandon d’une livraison',
                summary: 'Client injoignable, refus, adresse introuvable ; retourner le colis ; rendre la course',
                steps: [
                    'Ouvrez la livraison et faites un DOUBLE APPUI (ou appui long) sur la poignée du curseur en bas.',
                    '« Signaler une tentative échouée » : choisissez ce qui s’est passé (ex. « Client injoignable », « Personne sur place », « Le client a refusé le colis », « Adresse introuvable »), note facultative, « Signaler ». Le colis et la course restent à vous — réessayez avec « Démarrer la livraison ».',
                    '« Retourner le colis » : le colis repart et la course se ferme — « Retourner ».',
                    '« Abandonner cette livraison » : choisissez un motif (ex. « Panne de véhicule », « Urgence personnelle ») → « Abandonner ». Elle est proposée tout de suite à un autre livreur.',
                ],
                notes: [
                    '« Autre chose » demande une note. Impossible d’abandonner une fois sur place chez le client.',
                    'Un colis échoué non retourné garde une place de capacité et, en espèces, de la marge de paiement à la livraison.',
                ],
            },
        },
    }),
    T({
        key: 'agentcollectcash',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: collecting cash and the customer\'s delivery code',
                summary: 'Take the cash, type the customer\'s 6-digit code; resend the code; customer will not pay',
                steps: [
                    'On a cash-on-delivery delivery, slide "Collect cash" (it opens by itself after "I\'m at the customer").',
                    'Take the cash first, then ask the customer to read their 6-digit "Delivery code" and type it — it confirms on the 6th digit ("Confirm payment").',
                    '"Cash collected": the delivery is done and the cash is now on the agent\'s balance. Tap "Done".',
                    'Customer lost the code: "Send the customer a new code".',
                ],
                notes: [
                    'Too many wrong codes lock it: send the customer a new one.',
                    'Customer will not pay or is not there: tell the agency, or report a failed attempt (topic agentproblem). Left unresolved, it counts as cash taken after 3 days.',
                    'Hand the cash to the agency within 2 days to protect the trust score (topic agentcash).',
                ],
            },
            fr: {
                title: 'App agent : encaisser et le code de livraison du client',
                summary: 'Prendre l’argent, saisir le code à 6 chiffres du client ; renvoyer le code ; client qui ne paie pas',
                steps: [
                    'Sur une livraison payée à la livraison, faites glisser « Encaisser » (il s’ouvre seul après « Je suis chez le client »).',
                    'Prenez d’abord l’argent, puis demandez au client de lire son « Code de livraison » à 6 chiffres et saisissez-le — il se valide au 6e chiffre (« Confirmer le paiement »).',
                    '« Espèces encaissées » : la livraison est terminée et l’argent est sur le solde du livreur. Touchez « Terminé ».',
                    'Le client a perdu le code : « Envoyer un nouveau code au client ».',
                ],
                notes: [
                    'Trop de codes faux le bloquent : envoyez-en un nouveau au client.',
                    'Le client ne paie pas ou est absent : prévenez l’agence, ou signalez une tentative échouée (sujet agentproblem). Laissé tel quel, cela compte comme argent encaissé après 3 jours.',
                    'Remettez l’argent à l’agence sous 2 jours pour garder le score de confiance (sujet agentcash).',
                ],
            },
        },
    }),
    T({
        key: 'agentcash',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: cash I hold, handing it over, cash limit, cash problems',
                summary: 'See cash held, declare a hand-over to the agency, lower my cash limit, report a problem',
                steps: [
                    'Tap the "COD" tab. "Cash you are holding" shows the balance, the trust level and the room left ("COD exposure").',
                    'After giving cash to the agency: "Declare a hand-over" → choose the agency, "Amount handed over", "Who received it?" ("My agency" or "The platform directly"), a REQUIRED proof photo → "Declare hand-over".',
                    'The balance drops when the receiver confirms. Tab "Hand-overs" shows each one; "Dispute this hand-over" if it was recorded wrong.',
                    'Agency recorded less than handed over: the flag icon at the top ("Report a cash problem") → agency, amount, what happened → "Report".',
                    'To carry less cash: "Your COD limit" → "Carry less"; "Use my full limit" restores it.',
                ],
                notes: [
                    'Hand cash over within 2 days to keep the trust score. An open declaration pauses that clock.',
                    'Cash-on-delivery jobs need a verified identity. The limit can only be LOWERED by the agent; a higher one needs verification or a bigger plan.',
                ],
            },
            fr: {
                title: 'App agent : espèces détenues, remise, limite d’espèces, problèmes',
                summary: 'Voir les espèces détenues, déclarer une remise à l’agence, baisser ma limite, signaler un problème',
                steps: [
                    'Touchez l’onglet « Espèces ». « Espèces que vous détenez » montre le solde, le niveau de confiance et la marge restante (« Exposition espèces »).',
                    'Après avoir remis l’argent : « Déclarer une remise » → l’agence, « Montant remis », « Qui l’a reçu ? » (« Mon agence » ou « La plateforme directement »), une photo de preuve OBLIGATOIRE → « Déclarer la remise ».',
                    'Le solde baisse quand le destinataire confirme. L’onglet « Remises » les liste ; « Contester cette remise » si elle est mal enregistrée.',
                    'L’agence a enregistré moins que remis : l’icône drapeau en haut (« Signaler un problème d’espèces ») → agence, montant, ce qui s’est passé → « Signaler ».',
                    'Pour transporter moins : « Votre limite en espèces » → « Transporter moins » ; « Utiliser toute ma limite » la rétablit.',
                ],
                notes: [
                    'Remettez l’argent sous 2 jours pour garder le score de confiance. Une déclaration ouverte met ce délai en pause.',
                    'Les courses en espèces demandent une identité vérifiée. Le livreur peut seulement BAISSER sa limite ; plus haut demande la vérification ou un forfait supérieur.',
                ],
            },
        },
    }),
    T({
        key: 'agentagencies',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: joining a delivery agency',
                summary: 'Find an agency, apply with or without terms, answer an agency\'s request, withdraw',
                steps: [
                    'Open "More" → "My agencies" → the search icon ("Find an agency"). Search by "Name, city or region".',
                    'Tap "Apply". Choose how to be paid ("A share of the fee", "A flat amount", "A monthly salary") or "Let them propose"; optional regions and note. Tap "Apply with these terms" or "Apply, let them propose".',
                    'The agency accepts, declines or counters. Their answer appears in "My agencies"; open it to "Accept", "Decline" or "Counter their offer".',
                    'An agency that asked YOU shows under "Requests" with "Accept" / "Decline". Your own pending application has "Withdraw application".',
                ],
                notes: [
                    'No delivery offers arrive until at least one agency contract is active. You can apply to several.',
                    'A monthly salary is paid by the agency outside Wi-Mall; Wi-Mall then pays nothing per delivery for that agency.',
                ],
            },
            fr: {
                title: 'App agent : rejoindre une agence de livraison',
                summary: 'Trouver une agence, postuler avec ou sans conditions, répondre à une agence, retirer',
                steps: [
                    'Ouvrez « Plus » → « Mes agences » → l’icône recherche (« Trouver une agence »). Cherchez par « Nom, ville ou région ».',
                    'Touchez « Postuler ». Choisissez la rémunération (« Une part des frais », « Un montant fixe », « Un salaire mensuel ») ou « Qu’ils proposent » ; régions et note facultatives. Touchez « Postuler avec ces conditions » ou « Postuler, qu’ils proposent ».',
                    'L’agence accepte, refuse ou fait une contre-offre. Sa réponse apparaît dans « Mes agences » ; ouvrez-la pour « Accepter », « Refuser » ou « Répondre à leur offre ».',
                    'Une agence qui VOUS a sollicité apparaît sous « Demandes » avec « Accepter » / « Refuser ». Votre candidature en attente a « Retirer la candidature ».',
                ],
                notes: [
                    'Aucune proposition n’arrive tant qu’aucun contrat d’agence n’est actif. On peut postuler à plusieurs.',
                    'Un salaire mensuel est payé par l’agence hors de Wi-Mall ; Wi-Mall ne paie alors rien par livraison pour cette agence.',
                ],
            },
        },
    }),
    T({
        key: 'agentcontract',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: my contract — break, coming back, leaving, changing terms',
                summary: 'Pause, resume or end a contract with an agency; ask for new terms; primary agency',
                steps: [
                    'Open "More" → "My agencies" → tap the agency.',
                    '"Take a break" (pause), "Come back" (resume) or "Leave this agency" — each sends a request ("Send request" / "Ask to leave").',
                    '"Ask to change my terms" → new figures → "Send proposal". "Make this my primary agency" sets the main one.',
                    'Requests from the agency appear under "Waiting for your answer" in "My agencies": "Agree" or "Decline". "Cancel this request" calls off your own.',
                ],
                notes: [
                    'Every change is a two-party request: nothing changes until the agency agrees. Current terms stay in force meanwhile.',
                    'Leaving needs both balances at zero: the agency\'s cash deposited and anything they owe paid.',
                    '"Contract history" (the history icon) lists every change.',
                ],
            },
            fr: {
                title: 'App agent : mon contrat — pause, retour, départ, nouvelles conditions',
                summary: 'Mettre en pause, reprendre ou finir un contrat ; demander de nouvelles conditions ; agence principale',
                steps: [
                    'Ouvrez « Plus » → « Mes agences » → touchez l’agence.',
                    '« Faire une pause », « Revenir » ou « Quitter cette agence » — chacun envoie une demande (« Envoyer la demande » / « Demander à partir »).',
                    '« Demander à modifier mes conditions » → nouveaux chiffres → « Envoyer la proposition ». « En faire mon agence principale » choisit l’agence principale.',
                    'Les demandes de l’agence apparaissent sous « En attente de votre réponse » dans « Mes agences » : « Accepter » ou « Refuser ». « Annuler cette demande » retire la vôtre.',
                ],
                notes: [
                    'Chaque changement est une demande à deux : rien ne change sans l’accord de l’agence. Les conditions actuelles restent valables en attendant.',
                    'Partir demande deux soldes à zéro : les espèces de l’agence remises et ce qu’elle doit payé.',
                    '« Historique du contrat » (icône historique) liste chaque changement.',
                ],
            },
        },
    }),
    T({
        key: 'agentfee',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: proposing a different delivery fee',
                summary: 'Ask for a higher (or different) delivery fee before picking up a parcel',
                steps: [
                    'Open the delivery BEFORE pickup. In the "Delivery fee" card tap "Propose a different fee".',
                    'Type the "New delivery fee" and a "Reason" (at least 3 characters), then "Send to the vendor".',
                    'While it waits, "Edit" or "Withdraw" it. The answer shows as "Approved" or "Rejected".',
                ],
                notes: [
                    'Only possible if the agency turned fee proposals on ("Your agency hasn\'t enabled fee proposals." otherwise).',
                    'Pickup is blocked until the vendor (or the customer, if they pay delivery) answers.',
                ],
            },
            fr: {
                title: 'App agent : proposer d’autres frais de livraison',
                summary: 'Demander des frais de livraison différents avant d’enlever un colis',
                steps: [
                    'Ouvrez la livraison AVANT l’enlèvement. Dans la carte « Frais de livraison », touchez « Proposer d’autres frais ».',
                    'Saisissez les nouveaux frais et un « Motif » (au moins 3 caractères), puis « Envoyer au vendeur ».',
                    'En attendant, « Modifier » ou « Retirer ». La réponse s’affiche « Approuvé » ou « Refusé ».',
                ],
                notes: [
                    'Possible seulement si l’agence a activé les propositions de frais.',
                    'L’enlèvement est bloqué jusqu’à la réponse du vendeur (ou du client, s’il paie la livraison).',
                ],
            },
        },
    }),
    T({
        key: 'agentearnings',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: earnings, requesting a payout, payout number',
                summary: 'See earnings, withdraw them, and set the mobile-money number payouts go to',
                steps: [
                    'Open "More" → "Earnings & payouts". "Available now" can be withdrawn; "Still held" is released up to 3 days after your parcel is delivered, depending on your agency\'s terms — sometimes the very next night after the delivery is confirmed.',
                    'First set where money goes: "Payout destinations" → "Add a destination" → "Mobile money", "Network", "Phone number", "Name on the account" → "Save".',
                    'Tap "Request payout", then "Request". Follow it under "Support tickets" ("Open its ticket").',
                    '"My earnings" shows what was earned over a period.',
                ],
                notes: [
                    'A payout takes the WHOLE available balance; only one can be open at a time, and there is a minimum.',
                    'Earnings are separate from cash-on-delivery money; the two never cancel each other out.',
                    'Bank account and card payouts are "Not available at the moment".',
                ],
            },
            fr: {
                title: 'App agent : gains, demander un virement, numéro de virement',
                summary: 'Voir les gains, les retirer, et choisir le numéro mobile money qui reçoit les virements',
                steps: [
                    'Ouvrez « Plus » → « Revenus et virements ». « Disponible maintenant » peut être retiré ; « Encore bloqué » est libéré jusqu’à 3 jours après la livraison de votre colis, selon les conditions de votre agence — parfois dès la nuit qui suit la confirmation de la livraison.',
                    'D’abord la destination : « Destinations de virement » → « Ajouter une destination » → « Mobile money », « Opérateur », « Numéro de téléphone », « Nom du titulaire du compte » → « Enregistrer ».',
                    'Touchez « Demander un virement », puis « Demander ». Suivez-le dans « Tickets d’assistance » (« Ouvrir son ticket »).',
                    '« Mes gains » montre ce qui a été gagné sur une période.',
                ],
                notes: [
                    'Un virement prend TOUT le solde disponible ; un seul à la fois, avec un minimum.',
                    'Les gains sont séparés de l’argent des paiements à la livraison ; les deux ne se compensent jamais.',
                    'Compte bancaire et carte : « Indisponible pour le moment ».',
                ],
            },
        },
    }),
    T({
        key: 'agentplan',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: plan, delivery limit and credits',
                summary: 'See the plan, buy a bigger one to hold more deliveries, expiry warning, credits',
                steps: [
                    'Open "More" → "Plan". The current plan shows how many deliveries can be held at once.',
                    'Under "Other plans" tap "Choose", pick how to pay (mobile money or card), then "Pay" and approve.',
                    '"Expiry warning" sets how many days before expiry to be warned.',
                    '"More" → "Credits" → "Top up" → "Buy" for credits.',
                ],
                notes: [
                    'When a plan lapses, the delivery limit drops back to the free tier. A new plan bought early waits until the current one ends.',
                    'Nothing spends credits yet.',
                ],
            },
            fr: {
                title: 'App agent : forfait, limite de livraisons et crédits',
                summary: 'Voir le forfait, en prendre un plus grand pour plus de livraisons, alerte d’expiration, crédits',
                steps: [
                    'Ouvrez « Plus » → « Forfait ». Le forfait actuel indique combien de livraisons on peut détenir à la fois.',
                    'Sous « Autres forfaits », touchez « Choisir », choisissez le paiement (mobile money ou carte), puis « Payer » et validez.',
                    '« Alerte d’expiration » règle combien de jours avant l’expiration être prévenu.',
                    '« Plus » → « Crédits » → « Recharger » → « Acheter » pour des crédits.',
                ],
                notes: [
                    'Quand un forfait expire, la limite revient au niveau gratuit. Un forfait acheté en avance attend la fin de l’actuel.',
                    'Rien ne consomme encore de crédits.',
                ],
            },
        },
    }),
    T({
        key: 'agentprofile',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: profile, activating the account, vehicle, emergency contact, signing out',
                summary: 'Edit name, photo, vehicle, licence/ID, emergency contact; verify the phone; sign out',
                steps: [
                    'Open "More" → "Profile".',
                    'Account not active: under "Phone" tap "Verify this number" → "Send the code" → type the "Six-digit code" from WhatsApp → "Verify". It activates at once — nobody has to approve it.',
                    'Pencil next to "Name" changes it; tap the photo to change it; "Vehicle" → "Edit"; "Licence & ID" → "Edit"; "Emergency contact" to add someone to call.',
                    '"Accept offers automatically" takes offers the moment they arrive. "Change plan" opens the plans.',
                    'Sign out: the icon at the top right of Profile → "Sign out".',
                ],
                notes: [
                    'Phone and email cannot be changed in the app: "Raise a ticket" asks support.',
                    'Language, time zone and password are in the More menu, not on Profile.',
                ],
            },
            fr: {
                title: 'App agent : profil, activer le compte, véhicule, contact d’urgence, déconnexion',
                summary: 'Modifier nom, photo, véhicule, permis/pièce, contact d’urgence ; vérifier le téléphone ; se déconnecter',
                steps: [
                    'Ouvrez « Plus » → « Profil ».',
                    'Compte pas encore actif : sous « Téléphone », touchez « Vérifier ce numéro » → « Envoyer le code » → saisissez le « Code à six chiffres » reçu sur WhatsApp → « Vérifier ». Il s’active tout de suite — personne n’a à l’approuver.',
                    'Le crayon près de « Nom » le change ; touchez la photo pour la changer ; « Véhicule » → « Modifier » ; « Permis et pièce d’identité » → « Modifier » ; « Contact d’urgence » pour ajouter quelqu’un à appeler.',
                    '« Accepter les propositions automatiquement » prend les propositions dès leur arrivée. « Changer de forfait » ouvre les forfaits.',
                    'Déconnexion : l’icône en haut à droite du Profil → « Se déconnecter ».',
                ],
                notes: [
                    'Téléphone et e-mail ne se changent pas dans l’app : « Ouvrir un ticket » le demande au support.',
                    'Langue, fuseau horaire et mot de passe sont dans le menu Plus, pas sur le Profil.',
                ],
            },
        },
    }),
    T({
        key: 'agentsettings',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: password, fingerprint sign-in, language, map app, time zone, theme',
                summary: 'Change the password or language, turn fingerprint sign-in on/off, choose the navigation app',
                steps: [
                    'Password: "More" → "Change password" → "Current password", "New password", "Repeat new password". Fingerprint sign-in is the switch at the bottom of the same screen.',
                    'Language: "More" → "Language" → English or Français (also the language of alerts).',
                    'Map app for directions: "More" → "Navigation" → Google Maps, Waze, Apple Maps or "Don\'t open a map app".',
                    '"More" → "Time zone" and "Theme" ("System default", "Light", "Dark").',
                ],
                notes: [
                    'Changing the password signs out every other device. Each change here applies at once.',
                ],
            },
            fr: {
                title: 'App agent : mot de passe, empreinte, langue, application de carte, fuseau, thème',
                summary: 'Changer le mot de passe ou la langue, activer/couper l’empreinte, choisir l’application de navigation',
                steps: [
                    'Mot de passe : « Plus » → « Changer le mot de passe » → « Mot de passe actuel », « Nouveau mot de passe », « Répétez le nouveau mot de passe ». La connexion par empreinte est l’interrupteur en bas du même écran.',
                    'Langue : « Plus » → « Langue » → English ou Français (aussi la langue des alertes).',
                    'Application d’itinéraire : « Plus » → « Navigation » → Google Maps, Waze, Apple Maps ou « N’ouvrir aucune application de carte ».',
                    '« Plus » → « Fuseau horaire » et « Thème » (« Réglage du système », « Clair », « Sombre »).',
                ],
                notes: [
                    'Changer le mot de passe déconnecte tous les autres appareils. Chaque changement ici s’applique tout de suite.',
                ],
            },
        },
    }),
    T({
        key: 'agentverification',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: identity verification (needed to carry cash on delivery)',
                summary: 'Send ID documents for review so cash-on-delivery jobs can be offered',
                steps: [
                    'Open "More" → "Identity verification".',
                    'Under "Your details": "ID card number" and "Home address" (search and pick it).',
                    'Under "Documents", "Add" each: "ID card — front", "ID card — back", "Selfie holding your ID", "You beside your vehicle", "Sketch of where you live".',
                    'Tap "Send for review" and confirm. After a refusal, read "What the reviewer said", fix it and "Send again".',
                ],
                notes: [
                    'It gates cash-on-delivery only: unverified agents still join agencies and get prepaid deliveries.',
                    'Documents are locked while under review, and for good once verified (change via a support ticket). Only the reviewer sees them.',
                ],
            },
            fr: {
                title: 'App agent : vérification d’identité (nécessaire pour transporter des espèces)',
                summary: 'Envoyer les pièces d’identité en examen pour recevoir des courses en espèces',
                steps: [
                    'Ouvrez « Plus » → « Vérification d’identité ».',
                    'Sous « Vos informations » : « Numéro de la pièce d’identité » et « Adresse du domicile » (cherchez et choisissez).',
                    'Sous « Documents », « Ajouter » chacun : « Pièce d’identité — recto », « Pièce d’identité — verso », « Selfie avec votre pièce d’identité », « Vous à côté de votre véhicule », « Croquis du chemin vers chez vous ».',
                    'Touchez « Envoyer pour examen » et confirmez. Après un refus, lisez « Ce qu’a dit l’examinateur », corrigez et « Renvoyer ».',
                ],
                notes: [
                    'Elle ne conditionne que le paiement à la livraison : un livreur non vérifié rejoint des agences et reçoit les livraisons prépayées.',
                    'Les documents sont verrouillés pendant l’examen, et définitivement une fois vérifiés (changement par ticket). Seul l’examinateur les voit.',
                ],
            },
        },
    }),
    T({
        key: 'agenttickets',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: contacting Wi-Mall support',
                summary: 'Raise a support ticket from the agent app, reply, close it',
                steps: [
                    'Open "More" → "Support tickets" → "New ticket".',
                    'Choose "What is it about?" (a delivery, an order, an item, or nothing in particular), the "Kind of problem", "How urgent is it?", then "What is wrong?" and "Details"; up to 5 photos.',
                    'Tap "Raise ticket". Support replies in the ticket: type in "Reply to support" → "Send". The ⋯ menu has "Mark as resolved" and "Close ticket".',
                ],
                notes: [
                    'Payout requests are followed as tickets too. A photo attached to a ticket can only be removed by support.',
                ],
            },
            fr: {
                title: 'App agent : contacter le support Wi-Mall',
                summary: 'Ouvrir un ticket depuis l’app, répondre, le fermer',
                steps: [
                    'Ouvrez « Plus » → « Tickets d’assistance » → « Nouveau ticket ».',
                    'Choisissez « De quoi s’agit-il ? » (une livraison, une commande, un article, ou rien en particulier), le « Type de problème », « Quel degré d’urgence ? », puis « Quel est le problème ? » et « Détails » ; jusqu’à 5 photos.',
                    'Touchez « Ouvrir le ticket ». Le support répond dans le ticket : écrivez votre réponse → envoyer. Le menu ⋯ permet de marquer résolu ou de fermer le ticket.',
                ],
                notes: [
                    'Les demandes de virement sont aussi suivies en tickets. Une photo jointe ne peut être retirée que par le support.',
                ],
            },
        },
    }),
    T({
        key: 'agentclosure',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: answering a request to close the agent account',
                summary: 'What to do when Wi-Mall asks to close the agent account; it cannot be deleted alone',
                steps: [
                    'The banner "An administrator asked to close your agent account" on Home or More → tap it.',
                    'Clear everything under "Settle these first" (deliveries, offers, cash held, hand-overs, payouts, balance).',
                    'Tick "I understand…" then "Slide to close my account". Or "Keep my account" → optional note → confirm.',
                ],
                notes: [
                    'There is no self-service delete; nothing changes unless the agent confirms, and the request expires if ignored.',
                    'Closing is permanent: contracts end, location sharing turns off, plan time and credits are lost. Other Wi-Mall roles keep working.',
                ],
            },
            fr: {
                title: 'App agent : répondre à une demande de fermeture du compte livreur',
                summary: 'Que faire quand Wi-Mall demande la fermeture ; on ne peut pas supprimer seul',
                steps: [
                    'La bannière de demande de fermeture sur Accueil ou Plus → touchez-la.',
                    'Réglez tout ce qui est sous « À régler d’abord » (livraisons, propositions, espèces, remises, virements, solde).',
                    'Cochez la case de confirmation puis « Glisser pour fermer mon compte ». Ou « Garder mon compte » → note facultative → confirmer.',
                ],
                notes: [
                    'Pas de suppression en libre-service ; rien ne change sans confirmation, et la demande expire si elle est ignorée.',
                    'La fermeture est définitive : contrats terminés, partage de position coupé, forfait et crédits perdus. Les autres rôles Wi-Mall continuent.',
                ],
            },
        },
    }),
    T({
        key: 'agentnotifications',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: notification settings',
                summary: 'Choose which alerts also go to Telegram, WhatsApp or email; fix push on the phone',
                steps: [
                    'Tap the bell at the top right (on Home, Shipments, COD or More). On the "Alerts" screen tap the sliders icon at the top right ("Notification settings"). It is NOT in the More menu.',
                    '"On this phone": "In the app" is always on. "Push" shows whether the phone allows notifications — if not, tap "Turn on notifications" or "Open notification settings".',
                    '"Where copies go": pick ONE of "No copies", Telegram, "Email", WhatsApp. A channel that says "Not connected yet" must be connected first with its "Connect" button (topic agentchannels).',
                    '"What gets copied": switch on or off "Cash deposit updates", "Delivery offers", "Agency contracts", "Plan and subscription", "Storage alerts", "Cash-on-delivery limit", "Delivery-fee changes".',
                ],
                notes: [
                    'Every change saves immediately — there is no Save button.',
                    'The switches only control the COPY (Telegram, WhatsApp or email). Every alert still appears in the app and as a push; those cannot be switched off per event.',
                    'Turning off "Cash deposit updates" asks first: that copy is how an agent learns an agency recorded less cash than they handed over.',
                    'An unanswered delivery offer goes to someone else — keep push allowed. On the phone, Android Settings → Apps → Wi-Agent → Notifications has "Delivery offers" and "Notifications".',
                ],
            },
            fr: {
                title: 'App agent : réglages des notifications',
                summary: 'Choisir quelles alertes vont aussi sur Telegram, WhatsApp ou e-mail ; réparer le push',
                steps: [
                    'Touchez la cloche en haut à droite (sur Accueil, Livraisons, Espèces ou Plus). Sur l’écran « Alertes », touchez l’icône curseurs en haut à droite (« Paramètres des notifications »). Ce n’est PAS dans le menu Plus.',
                    '« Sur ce téléphone » : « Dans l’application » est toujours actif. « Notification push » montre si le téléphone autorise les notifications — sinon, touchez « Activer les notifications » ou « Ouvrir les paramètres de notification ».',
                    '« Où vont les copies » : choisissez UN de « Aucune copie », Telegram, « E-mail », WhatsApp. Un canal marqué « Pas encore connecté » se connecte d’abord avec son bouton « Connecter » (sujet agentchannels).',
                    '« Ce qui est copié » : activez ou coupez « Remises d’espèces », « Propositions de livraison », « Contrats d’agence », « Forfait et abonnement », « Alertes de stockage », « Limite de paiement à la livraison », « Changements de frais de livraison ».',
                ],
                notes: [
                    'Chaque changement est enregistré tout de suite — il n’y a pas de bouton Enregistrer.',
                    'Les interrupteurs ne règlent que la COPIE (Telegram, WhatsApp ou e-mail). Chaque alerte apparaît toujours dans l’app et en push ; ceux-là ne se coupent pas par événement.',
                    'Couper « Remises d’espèces » demande confirmation : cette copie est ce qui prévient l’agent qu’une agence a enregistré moins d’espèces que remis.',
                    'Une proposition sans réponse part à un autre — gardez le push autorisé. Sur le téléphone, Réglages Android → Applications → Wi-Agent → Notifications contient « Propositions de livraison » et « Notifications ».',
                ],
            },
        },
    }),
    T({
        key: 'agentchannels',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: connecting Telegram, WhatsApp or email for alert copies',
                summary: 'Connect or disconnect Telegram, WhatsApp or email in the agent app',
                steps: [
                    'Open the notification settings: bell → sliders icon (topic agentnotifications). Under "Where copies go", tap "Connect" on the channel.',
                    'Telegram or WhatsApp: send /connect to the Wi-Mall bot on that app ("Open Telegram" / "Open WhatsApp" opens it). The bot replies with a six-character code: type it in "Code from the bot" and tap "Connect".',
                    'Email: tap "Send verification email", then open the link in the mailbox. The email is the one on the Profile.',
                    'Connecting does not select the channel: tap its circle under "Where copies go" afterwards.',
                    'To stop: tap "Disconnect" on Telegram or WhatsApp, then confirm "Disconnect".',
                ],
                notes: [
                    'The code lasts ten minutes and works once. "Too many tries": wait ten minutes, then ask for a new code.',
                    '"Already connected to another account": disconnect it there first, or open a support ticket.',
                ],
            },
            fr: {
                title: 'App agent : connecter Telegram, WhatsApp ou l’e-mail pour les copies d’alertes',
                summary: 'Connecter ou déconnecter Telegram, WhatsApp ou l’e-mail dans l’app agent',
                steps: [
                    'Ouvrez les réglages des notifications : cloche → icône curseurs (sujet agentnotifications). Sous « Où vont les copies », touchez « Connecter » sur le canal.',
                    'Telegram ou WhatsApp : envoyez /connect au bot Wi-Mall sur cette application (« Ouvrir Telegram » / « Ouvrir WhatsApp » l’ouvre). Le bot répond avec un code de six caractères : saisissez-le dans « Code du bot » et touchez « Connecter ».',
                    'E-mail : touchez « Envoyer l’e-mail de vérification », puis ouvrez le lien reçu. L’adresse est celle du Profil.',
                    'Connecter ne sélectionne pas le canal : touchez ensuite son rond sous « Où vont les copies ».',
                    'Pour arrêter : touchez « Déconnecter » sur Telegram ou WhatsApp, puis confirmez « Déconnecter ».',
                ],
                notes: [
                    'Le code dure dix minutes et ne sert qu’une fois. « Trop de tentatives » : attendez dix minutes, puis demandez un nouveau code.',
                    '« Déjà connecté à un autre compte » : déconnectez-le là-bas d’abord, ou ouvrez un ticket d’assistance.',
                ],
            },
        },
    }),
    T({
        key: 'agentalerts',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: the Alerts inbox',
                summary: 'Read alerts, mark them read, open the offer or delivery they are about',
                steps: [
                    'Tap the bell at the top right of a main screen (a red number = unread). The "Alerts" screen opens.',
                    'Tap an alert: it is marked read and opens what it is about (an offer, a delivery, an agency contract, the COD tab, the plan…).',
                    'The double-tick icon at the top ("Mark all read") marks everything read. Pull down to refresh.',
                ],
                notes: [
                    'There is no Alerts tab and no Alerts row in More — only the bell.',
                ],
            },
            fr: {
                title: 'App agent : la boîte « Alertes »',
                summary: 'Lire les alertes, les marquer lues, ouvrir la proposition ou la livraison concernée',
                steps: [
                    'Touchez la cloche en haut à droite d’un écran principal (un chiffre rouge = non lues). L’écran « Alertes » s’ouvre.',
                    'Touchez une alerte : elle est marquée lue et ouvre ce qu’elle concerne (une proposition, une livraison, un contrat d’agence, l’onglet Espèces, le forfait…).',
                    'L’icône double coche en haut (« Tout marquer comme lu ») marque tout comme lu. Tirez vers le bas pour actualiser.',
                ],
                notes: [
                    'Il n’y a ni onglet Alertes ni ligne Alertes dans Plus — seulement la cloche.',
                ],
            },
        },
    }),
    T({
        key: 'agentlocation',
        app: 'agent',
        path: null,
        signIn: true,
        copy: {
            en: {
                title: 'Agent app: sharing my location (and why it cannot be turned off now)',
                summary: 'Turn location sharing on or off; fix a phone that blocks location',
                steps: [
                    'Tap "More" in the bottom bar. Under "Location sharing", use the switch "Share my location". (Home also shows "Turn on" when it is off.)',
                    'Turning it on asks the phone for location permission: allow it.',
                    'If a red note says location is off or blocked, tap the button under it: "Open location settings", "Allow location" or "Open app settings".',
                    'To keep tracking when the app is closed: Shipments → open a delivery in progress → round "Live tracking" icon → gear icon → "Keep tracking when the app is closed", then "Allow notifications", "Exempt this app" and "Allow all the time".',
                ],
                notes: [
                    'It cannot be switched off while a delivery is in flight (assigned, handing over, picked up, in transit): it stays on until the delivery is delivered, returned or failed.',
                    'With sharing off, delivery offers go to other agents ("Jobs are offered to whoever is nearest").',
                    '"Tracking not allowed" under "Receiving orders" means Wi-Mall turned tracking off for the account: only support can turn it back on.',
                ],
            },
            fr: {
                title: 'App agent : partager ma position (et pourquoi on ne peut pas couper maintenant)',
                summary: 'Activer ou couper le partage de position ; réparer un téléphone qui bloque la position',
                steps: [
                    'Touchez « Plus » dans la barre du bas. Sous « Partage de position », utilisez l’interrupteur « Partager ma position ». (L’Accueil propose aussi « Activer » quand il est coupé.)',
                    'L’activer demande l’autorisation de localisation au téléphone : acceptez.',
                    'Si une note rouge dit que la localisation est coupée ou bloquée, touchez le bouton dessous : « Ouvrir les réglages de localisation », « Autoriser la localisation » ou « Ouvrir les réglages de l’application ».',
                    'Pour suivre même app fermée : Livraisons → ouvrez une livraison en cours → icône ronde « Suivi en direct » → engrenage → « Continuer le suivi quand l’application est fermée », puis « Autoriser les notifications », « Exempter cette application » et « Toujours autoriser ».',
                ],
                notes: [
                    'Impossible de le couper pendant une livraison en cours (assignée, en passation, enlevée, en transit) : il reste actif jusqu’à ce qu’elle soit livrée, retournée ou échouée.',
                    'Partage coupé, les propositions vont aux autres livreurs (« Les courses sont proposées au livreur le plus proche »).',
                    '« Suivi non autorisé » sous « Réception des commandes » : Wi-Mall a coupé le suivi du compte, seul le support peut le réactiver.',
                ],
            },
        },
    }),
]);
