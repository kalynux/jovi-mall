export interface ICalendarIntegrationProvider {
  /**
   * Generates the URL to redirect the user to for authentication.
   */
  getAuthUrl(): string;

  /**
   * Handles the OAuth callback.
   * Exchanges the code for tokens, retrieves user profile, and stores the connection.
   * @param code The authorization code from the provider
   * @param userId The ID of the authenticated user in our system
   */
  handleCallback(code: string, userId: string): Promise<void>;

  /**
   * Disconnects the user's calendar account.
   * Revokes tokens (if applicable) and removes the record from the database.
   * @param userId The ID of the authenticated user in our system
   */
  disconnect(userId: string): Promise<void>;

  /**
   * Tests the connection by performing a lightweight API call (e.g. listing calendars).
   * @param userId The ID of the authenticated user in our system
   * @returns true if the connection is valid, throws error otherwise
   */
  testConnection(userId: string): Promise<boolean>;
}
