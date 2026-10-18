# Agent app: the agency directory lists active agencies only

**2026-10-18 · not deployed yet · additive** (the list gets shorter, no field changed).

`GET /api/agent/agencies/browse` no longer returns agencies at `pending_verification` (an agency
that has not finished activating: phone not yet verified, or no display name). The directory has
always been described as "active, onboarding complete". Until now it also listed these agencies,
because it shares its query with the vendor's agency search, which changed the same day for the
same reason.

Contracts the agent already has with such an agency are not affected and still appear in the
agent's contract list. Nothing to change in the app.
