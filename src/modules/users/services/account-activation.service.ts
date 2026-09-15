import { IUser } from '../user.model';
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { AgentRepository } from '../../agents/repositories/agent.repository';

/**
 * The roles that activate themselves. `customer` is deliberately absent — see below.
 */
export const SELF_ACTIVATING_ROLES = ['vendor', 'agency', 'agent'] as const;
export type SelfActivatingRole = (typeof SELF_ACTIVATING_ROLES)[number];

/**
 * Promotes role entities out of `pending_verification` once their fundamentals are proved.
 *
 * ── Why this is a service and not three lines inside the contact flow ────────
 *
 * There is more than one way to prove a phone number — the WhatsApp OTP
 * (`modules/phone-verification`), a confirmed contact change, and whatever the next one
 * turns out to be — and every one of them must reach the same rule. A copy of the promotion
 * inlined at each proof site is how two of them end up agreeing and the third, added later
 * by somebody who did not know the others existed, does not. The rule itself lives one level
 * further down again, in `core/accounts/activation.ts`, so the three repositories cannot
 * drift from each other either.
 *
 * ── Why `customer` is not here ───────────────────────────────────────────────
 *
 * The owner's rule covers vendor, agency and agent — the three roles whose `status` gates
 * something. A customer's `status` gates nothing today, and promoting it would be a
 * behaviour change nobody asked for, dressed up as consistency. ⚠ If a customer gate is ever
 * added, decide the rule deliberately rather than assuming this one applies: customers
 * arrive through the bot with a phone that was never *proved* so much as *observed*, which
 * is a different quality of evidence.
 *
 * ── Best-effort, per role, and never fatal ───────────────────────────────────
 *
 * Activation is bookkeeping that follows a proof; it is not the proof. A failure here must
 * not fail the verification the person just completed — they proved their number, and the
 * response must say so. A missed promotion is recovered by the next proof or by the
 * administrative `PATCH .../status`, whereas a 500 on a successful OTP confirm costs them
 * the code as well, since it is spent by then.
 */
export class AccountActivationService {
    constructor(
        private readonly vendorRepo: VendorRepository = new VendorRepository(),
        private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
        private readonly agentRepo: AgentRepository = new AgentRepository(),
    ) {}

    /**
     * Try to activate every self-activating role this user holds.
     *
     * @returns the roles that actually moved — empty on the overwhelmingly common call,
     *          where the account was already active or has not proved a phone.
     */
    async activateEligibleRoles(user: IUser): Promise<SelfActivatingRole[]> {
        const userId = user._id.toString();

        const promoters: Record<SelfActivatingRole, () => Promise<unknown | null>> = {
            vendor: () => this.vendorRepo.activateIfFundamentalsMet(userId),
            agency: () => this.agencyRepo.activateIfFundamentalsMet(userId),
            agent: () => this.agentRepo.activateIfFundamentalsMet(userId),
        };

        const activated: SelfActivatingRole[] = [];

        for (const role of user.roles ?? []) {
            if (!isSelfActivating(role)) continue;
            try {
                const promoted = await promoters[role]();
                if (promoted) {
                    activated.push(role);
                    console.log(`[AccountActivation] ${role} ${userId} activated on proved fundamentals`);
                }
            } catch (error) {
                console.error(`[AccountActivation] failed to evaluate ${role} ${userId}`, error);
            }
        }

        return activated;
    }
}

function isSelfActivating(role: string): role is SelfActivatingRole {
    return (SELF_ACTIVATING_ROLES as readonly string[]).includes(role);
}

export const accountActivationService = new AccountActivationService();
