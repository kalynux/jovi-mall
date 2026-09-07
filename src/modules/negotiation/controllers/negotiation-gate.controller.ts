import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { negotiationService } from '../services/negotiation.service';
import {
    NegotiationContextSchema,
    NegotiationRecordSchema,
} from '../validators/negotiation.validator';

/**
 * The bargaining sub-agent's two write-side tools.
 *
 * Thin by design: parse, delegate, serialise. Every rule lives in
 * `NegotiationService` and `negotiation-gate.rule.ts`, so there is no second
 * opinion about a price anywhere on this path.
 */
export class NegotiationGateController {
    /**
     * `POST /api/internal/negotiation/context`
     *
     * Opens or resumes the session for this line and returns everything the model
     * needs to take a turn — **including the vendor's real floor** (plan D-2).
     */
    static context = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
        const input = NegotiationContextSchema.parse(req.body);
        const context = await negotiationService.context(input);
        res.json({ success: true, data: context });
    });

    /**
     * `POST /api/internal/negotiation/record` — the gate.
     *
     * ⚠ **A refusal is a 200 with `verdict: 'revise'`, not a 4xx.** The model
     * proposing a price outside the window is a normal outcome of an agent that is
     * working correctly; a 4xx there would put an exception on the happy path and
     * tempt the automation layer into retrying the same body instead of re-drafting.
     * The 4xx codes are reserved for the caller getting the CALL wrong — an unknown
     * session, an unresolvable identity, a variant that is not negotiable.
     */
    static record = asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
        const input = NegotiationRecordSchema.parse(req.body);
        const result = await negotiationService.record(input);
        res.json({ success: true, data: result });
    });
}

export const negotiationGateController = NegotiationGateController;
