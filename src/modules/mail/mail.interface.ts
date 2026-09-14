import { MailProviderName } from './mail.config';

export type EmailType = 'AUTH' | 'ORDER' | 'SYSTEM' | 'OTHER';

// Public API for Service
export interface SendEmailOptions {
  to: string;
  type: EmailType;
  subject: string;
  template: string;
  variables: Record<string, any>;
  from?: string; // Optional override
}

// Internal API for Providers
export interface ProviderSendOptions {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
}

export interface IMailProvider {
  /**
   * Which provider this instance is.
   *
   * Every log line, metric label and `/system/integrations` row reports it, and
   * {@link ChainedMailProvider} keys its latch on it — so this is the one thing a provider may
   * not get wrong. It is `readonly` and a literal on each adapter rather than a constructor
   * argument for that reason: a chain whose two members can be handed the same name latches one
   * provider out on the other's refusal, silently.
   */
  readonly name: MailProviderName;

  /**
   * Send one message, or throw.
   *
   * ⚠ **The throw is a CLASSIFICATION, not just a failure.** Every adapter must map its
   * provider's vendor-specific refusal onto one of the `MAIL_PROVIDER_*` / `MAIL_SEND_REJECTED`
   * codes via `createAppError`, because that code is the entire input to
   * {@link ChainedMailProvider}'s decision about whether to fail over and whether to latch. An
   * adapter that throws a bare error is not merely less informative — it is unclassifiable, and
   * the chain has to treat it as the most conservative case.
   */
  sendEmail(options: ProviderSendOptions): Promise<void>;

  /**
   * Confirm the provider can reach and authenticate with its backend, WITHOUT sending anything.
   *
   * Required, not optional, and that is the fix rather than an embellishment. Phase 14 shipped
   * `?probe=smtp` against a duck-typed `verify?: () => Promise<void>` that no provider defined,
   * so the probe reported `error` on every call while `api-doc/admin/system.md` advertised it
   * as the one genuinely safe probe. A duck-type on an `unknown` cast is exactly how a method
   * that does not exist compiles: making this part of the interface means a provider added
   * later fails to compile instead of silently failing the probe.
   *
   * Implementations must not send a message, cost money, or consume a quota a real request
   * needs — the diagnostics rule from ADR-014 D-2 applies here too.
   */
  verify(): Promise<void>;
}
