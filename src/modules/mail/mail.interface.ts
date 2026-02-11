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
}
