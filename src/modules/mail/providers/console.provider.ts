import { IMailProvider, ProviderSendOptions } from '../mail.interface';

export class ConsoleMailProvider implements IMailProvider {
  /**
   * Always reachable — there is no backend to fail.
   *
   * Reporting "ok" here is honest rather than flattering: the console provider genuinely can
   * deliver everything it promises to deliver. Whether that is what the deployment WANTS is a
   * different column, and `/system/integrations` answers it separately via `configured`.
   */
  async verify(): Promise<void> {
    // Nothing to check.
  }

  async sendEmail(options: ProviderSendOptions): Promise<void> {
    console.log('--- [Mail] Sending Email ---');
    console.log(`To:      ${options.to}`);
    console.log(`From:    ${options.from}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`HTML:    ${options.html.substring(0, 50)}...`);
    console.log('----------------------------');
  }
}
