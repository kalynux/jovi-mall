import { IMailProvider, ProviderSendOptions } from '../mail.interface';

export class ConsoleMailProvider implements IMailProvider {
  async sendEmail(options: ProviderSendOptions): Promise<void> {
    console.log('--- [Mail] Sending Email ---');
    console.log(`To:      ${options.to}`);
    console.log(`From:    ${options.from}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`HTML:    ${options.html.substring(0, 50)}...`);
    console.log('----------------------------');
  }
}
