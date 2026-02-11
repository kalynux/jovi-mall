import { createClient, RedisClientType } from 'redis';

export const EMAIL_VERIFY_DB = 3; // keep token for email verification
export const WA_VERIFY_DB = 4; // keep token for whatsapp verification
export const WA_IDEMPOTENCY_DB = 5; // keep idempotency keys for whatsapp (24-72 hours)
export const WA_WINDOW_DB = 6; // keep window status for whatsapp (24 hours)
export const SLOT_LOCK_DB = 7; // keep slot locks for booking
export const DOWNLOAD_TOKEN_DB = 8; // keep download tokens for digital delivery
export const TELEGRAM_LINK_TOKEN_DB = 9; // keep tokens for Telegram account linking
export const TELEGRAM_WINDOW_DB = 10; // keep window status for telegram (24 hours)


const clients: Map<number, RedisClientType> = new Map();

export const getRedisClient = async (db: number = 0): Promise<RedisClientType> => {
  if (clients.has(db)) {
    const client = clients.get(db)!;
    if (!client.isOpen) {
      await client.connect();
    }
    return client;
  }

  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  const client = createClient({
    url,
    database: db,
  }) as RedisClientType;

  client.on('error', (err) => {
    console.error(`[Redis] Error in DB ${db}:`, err);
  });

  client.on('connect', () => {
    console.log(`[Redis] Connected to DB ${db}`);
  });

  // Lazy connect: We don't await connect here based on "Lazy connect" requirement?
  // Actually, node-redis v4 REQUIRES connect() before use.
  // The requirement says "Lazy connect", which usually means "connect when first requested".
  // Since this function is "getRedisClient" and returns a Promise, we can connect here.
  // If we returned the client immediately without connecting, the user would have to connect.
  // But our signature is `async`, so we can ensure connection.

  await client.connect();
  clients.set(db, client);

  return client;
};

// Graceful shutdown helper
export const closeRedisClients = async () => {
  for (const [db, client] of clients.entries()) {
    if (client.isOpen) {
      await client.quit();
      console.log(`[Redis] Closed DB ${db}`);
    }
  }
  clients.clear();
};
