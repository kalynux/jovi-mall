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
