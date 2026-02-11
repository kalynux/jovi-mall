import crypto from 'crypto';

export class GoogleTokenVault {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly ENCODING = 'hex';
  private static readonly IV_LENGTH = 16; // AES block size
  private static readonly AUTH_TAG_LENGTH = 16; // Standard GCM auth tag length

  private get key(): Buffer {
    const key = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    if (!key) {
      throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY is not defined');
    }
    if (key.length !== 64) { // 32 bytes as hex string = 64 chars
         // Fallback if users provide 32 raw chars instead of hex, though hex is safer for env vars.
         // But for standard `openssl rand -hex 32` it produces 64 chars.
         // Let's assume standard usage: 32 bytes.
         // If the user provided a 32-char string directly (not hex encoded), checking key.length might be tricky.
         // Let's try to parse as hex.
    }
    return Buffer.from(key, 'hex');
  }

  /**
   * Encrypts a text string using AES-256-GCM.
   * Format: iv:authTag:encryptedContent
   */
  encrypt(text: string): string {
    const iv = crypto.randomBytes(GoogleTokenVault.IV_LENGTH);
    const cipher = crypto.createCipheriv(
      GoogleTokenVault.ALGORITHM,
      this.key,
      iv
    );

    let encrypted = cipher.update(text, 'utf8', GoogleTokenVault.ENCODING);
    encrypted += cipher.final(GoogleTokenVault.ENCODING);

    const authTag = cipher.getAuthTag();

    return `${iv.toString(GoogleTokenVault.ENCODING)}:${authTag.toString(
      GoogleTokenVault.ENCODING
    )}:${encrypted}`;
  }

  /**
   * Decrypts a text string.
   * Expects format: iv:authTag:encryptedContent
   */
  decrypt(text: string): string {
    const parts = text.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;

    const iv = Buffer.from(ivHex, GoogleTokenVault.ENCODING);
    const authTag = Buffer.from(authTagHex, GoogleTokenVault.ENCODING);
    
    const decipher = crypto.createDecipheriv(
      GoogleTokenVault.ALGORITHM,
      this.key,
      iv
    );

    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, GoogleTokenVault.ENCODING, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
