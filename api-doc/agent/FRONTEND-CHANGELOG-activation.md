# Agent app: setting your name can activate the account

**2026-10-18 · not deployed yet · additive.**

An agent becomes `active` when it has **a verified phone and a non-blank `name`**. Before this
change only the phone proof evaluated that, so an agent who verified the phone first and set the
name afterwards stayed `pending_verification` until an administrator moved them.

`PATCH /api/agent/profile` now evaluates activation after every save. If the save completes the
pair, the agent is promoted in the same request and the response's `status` is already
`"active"`.

- Refresh the stored agent status from the PATCH response. No extra call is needed.
- An agent that already has both and is stuck heals on its next profile save, whatever field
  it changes.
- Activation never fails the save. An `inactive` or `suspended` agent is never promoted.
- Being `active` is not the same as being dispatchable: contracts, Tracking Allow and the other
  eligibility rules still apply ([auth/README.md](../auth/README.md) § account activation).

Contracts: [profile.md](./profile.md) · [auth/README.md](../auth/README.md).
