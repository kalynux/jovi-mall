import { google, Auth } from 'googleapis';
import mongoose from 'mongoose';
import { ICalendarIntegrationProvider } from '../interfaces/calendar.integration.interface';
import { ConnectedCalendarAccount } from './connected-account.model';
import { GoogleTokenVault } from './google-token.vault';

export class GoogleCalendarProvider implements ICalendarIntegrationProvider {
  private vault: GoogleTokenVault;

  constructor() {
    this.vault = new GoogleTokenVault();
  }

  private getClientId(): string {
    const id = process.env.GOOGLE_CLIENT_ID;
    if (!id) throw new Error('GOOGLE_CLIENT_ID not configured');
    return id;
  }

  private getClientSecret(): string {
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!secret) throw new Error('GOOGLE_CLIENT_SECRET not configured');
    return secret;
  }

  private getRedirectUri(): string {
    const uri = process.env.GOOGLE_REDIRECT_URI;
    if (!uri) throw new Error('GOOGLE_REDIRECT_URI not configured');
    return uri;
  }

  private createAuthClient(): Auth.OAuth2Client {
    return new google.auth.OAuth2(
      this.getClientId(),
      this.getClientSecret(),
      this.getRedirectUri()
    );
  }

  getAuthUrl(state?: string): string {
    const client = this.createAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline', // Critical for receiving refresh token
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      prompt: 'consent', // Force consent to ensure refresh token is returned
      state: state, // OAuth CSRF protection
    });
  }

  async handleCallback(code: string, userId: string, vendorId?: string): Promise<void> {
    const client = this.createAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Fetch user profile to get stable ID
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: userInfo } = await oauth2.userinfo.get();

    if (!userInfo.id || !userInfo.email) {
      throw new Error('Failed to retrieve user profile from Google');
    }

    if (!tokens.access_token) {
      throw new Error('No access token received');
    }

    // Encrypt tokens
    const encryptedAccessToken = this.vault.encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token
      ? this.vault.encrypt(tokens.refresh_token)
      : undefined;

    // Check if account already exists
    const existingAccount = await ConnectedCalendarAccount.findOne({
      userId,
      provider: 'google',
    });

    if (existingAccount) {
      // Update existing
      existingAccount.googleAccountId = userInfo.id;
      existingAccount.email = userInfo.email;
      existingAccount.accessToken = encryptedAccessToken;
      existingAccount.expiresAt = new Date(tokens.expiry_date || Date.now() + 3600 * 1000);
      existingAccount.scope = tokens.scope || existingAccount.scope;

      // Update vendorId if provided
      if (vendorId) {
        existingAccount.vendorId = new mongoose.Types.ObjectId(vendorId);
      }

      // Rotate refresh token only if a new one is provided
      if (encryptedRefreshToken) {
        existingAccount.refreshToken = encryptedRefreshToken;
      }

      await existingAccount.save();
    } else {
      if (!encryptedRefreshToken) {
        // If this is a new connection, we MUST have a refresh token.
        // If not, we might need to prompt re-consent.
        // But throwing here is safer than storing a broken state.
        throw new Error('No refresh token received for new connection. Please try again.');
      }

      await ConnectedCalendarAccount.create({
        userId,
        vendorId: vendorId ? new mongoose.Types.ObjectId(vendorId) : undefined,
        provider: 'google',
        googleAccountId: userInfo.id,
        email: userInfo.email,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt: new Date(tokens.expiry_date || Date.now() + 3600 * 1000),
        scope: tokens.scope || '',
      });
    }
  }

  async disconnect(userId: string): Promise<void> {
    const account = await ConnectedCalendarAccount.findOne({ userId, provider: 'google' });
    if (!account) return;

    try {
      // Attempt to revoke token on Google side
      const client = this.createAuthClient();
      // We can revoke either access or refresh token.
      const accessToken = this.vault.decrypt(account.accessToken);
      await client.revokeToken(accessToken);
    } catch (error) {
      console.warn('Failed to revoke token on Google side, proceeding with DB deletion', error);
    }

    await ConnectedCalendarAccount.deleteOne({ _id: account._id });
  }

  async testConnection(userId: string): Promise<boolean> {
    const client = await this.getAuthenticatedClient(userId);
    const calendar = google.calendar({ version: 'v3', auth: client });

    // Perform a lightweight call
    await calendar.calendarList.list({ maxResults: 1 });
    return true;
  }

  /**
   * Helper to get an authenticated client for a user.
   * Handles token decryption and sets up automatic token refresh persistence.
   */
  private async getAuthenticatedClient(userId: string): Promise<Auth.OAuth2Client> {
    const account = await ConnectedCalendarAccount.findOne({ userId, provider: 'google' });
    if (!account) {
      throw new Error('Google Calendar is not connected');
    }

    const client = this.createAuthClient();

    const accessToken = this.vault.decrypt(account.accessToken);
    const refreshToken = this.vault.decrypt(account.refreshToken);

    client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
      expiry_date: account.expiresAt.getTime(),
      scope: account.scope,
      token_type: 'Bearer',
    });

    // Listen for token updates (refresh)
    client.on('tokens', async (tokens: Auth.Credentials) => {
      try {
        console.log('Google tokens refreshed automatically');
        const update: any = {};

        if (tokens.access_token) {
          update.accessToken = this.vault.encrypt(tokens.access_token);
        }

        if (tokens.refresh_token) {
          update.refreshToken = this.vault.encrypt(tokens.refresh_token);
        }

        if (tokens.expiry_date) {
          update.expiresAt = new Date(tokens.expiry_date);
        }

        if (Object.keys(update).length > 0) {
          await ConnectedCalendarAccount.updateOne(
            { _id: account._id },
            { $set: update }
          );
        }
      } catch (err) {
        console.error('Failed to persist refreshed tokens', err);
      }
    });

    return client;
  }
}
