import { setNegotiatedPriceResolver } from '../catalog/domain/ports/negotiated-price.port';
import { NEGOTIATION_CONFIG } from './config/negotiation.config';
import { negotiatedPriceResolver } from './services/negotiated-price.resolver';

/**
 * initializeNegotiationDomain — registers the negotiated-price resolver at startup.
 *
 * This is the composition point plan D-11 specifies, and the reason the seam is a
 * port at all: `negotiation` needs `catalog` to read the vendor's window at gate
 * time, so a direct import from `PriceResolverService` back into `negotiation`
 * would close a require cycle. `catalog` declares the interface, `negotiation`
 * implements it, and this file joins them — the same shape as
 * `agent.bootstrap.ts`, which exists for the same reason.
 *
 * ⚠ **Skipping this call does not disable negotiated pricing — it BREAKS it.**
 * The port's default resolver refuses any presented lock with a 500 rather than
 * quietly charging the list price, because falling through would charge a
 * customer more than they agreed and neither side would report it as a bug. So a
 * missing registration is a loud failure on every haggled add-to-cart, not a
 * silent one. That is the intended behaviour, and it is why this must be called
 * from `lifecycle.ts` before the listener opens.
 *
 * Called from `lifecycle.ts` alongside the other startup registrations.
 */
export function initializeNegotiationDomain(): void {
    setNegotiatedPriceResolver(negotiatedPriceResolver);

    console.log(
        `[NegotiationDomain] Initialized (negotiated-price resolver: ${negotiatedPriceResolver.name}, `
        + `lock TTL: ${NEGOTIATION_CONFIG.LOCK_TTL_MINUTES}m, session TTL: ${NEGOTIATION_CONFIG.SESSION_TTL_MINUTES}m)`
    );

    /**
     * D-10's first obligation, checked rather than merely written down.
     *
     * The lock TTL is exactly how long a vendor's price edit has to strand a
     * promise the bot already made: a lock is re-validated against the live
     * window when it is consumed, and refused if the window has moved under it.
     * The decision to accept that failure was taken on the explicit condition
     * that the window stays small. An hour is already generous for a chat
     * negotiation; anything past it is someone treating this as a shopping-cart
     * TTL, which is the misreading the config comment warns about.
     */
    if (NEGOTIATION_CONFIG.LOCK_TTL_MINUTES > 60) {
        console.warn(
            `[NegotiationDomain] NEGOTIATION_LOCK_TTL_MINUTES=${NEGOTIATION_CONFIG.LOCK_TTL_MINUTES} — a lock is `
            + 'RE-VALIDATED against the live window at checkout and refused if the vendor has moved it since '
            + '(plan D-10). This TTL is the entire window in which an ordinary vendor price edit can break a '
            + 'price the bot promised a customer. Keep it in minutes.'
        );
    }
}
