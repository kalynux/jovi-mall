/**
 * Seed: the house byline.
 *
 * An article cannot be published without an author that exists (`collectPublishBlockers`),
 * so a fresh database has a chicken-and-egg problem the moment somebody opens the editor.
 * This creates the one byline the marketing site's articles are written under.
 *
 * **Only the author.** No articles are seeded, deliberately: the frontend's five fixture
 * articles are structural placeholders, not reviewed editorial, and importing unreviewed
 * prose is how a new domain teaches Google it is a content farm. Articles come in through
 * wi-admin's `POST /api/v1/content/articles` once a person has read them.
 *
 * ⚠ **This is a seed, and it is now the only thing in this repository that writes
 * `article_authors` at all.** The editor moved to wi-admin at Phase 5 Part A (ADR-004 D-4)
 * and jovi-mall's writers were deleted with it; a seed is not a runtime writer, so this one
 * stayed. Do not grow it into one — two services writing this collection, only one of which
 * applies the schema's defaults, is the state that port exists to prevent.
 *
 * `type: 'Organization'` and not `Person`, because "The WiMall team" is not a human — and
 * that field becomes the `@type` of the `author` node in the article's `BlogPosting`
 * structured data, where claiming otherwise is the kind of thing that earns a manual action.
 *
 * Idempotent upsert by `key`. Safe to re-run; edits made through wi-admin's editor are
 * reset, so prefer that API for ongoing changes.
 *
 * Run:
 *   npm run seed:blog
 */
import 'dotenv/config'; // load .env (MONGO_URI etc.) before anything reads it
import mongoose from 'mongoose';

import { ArticleAuthorModel } from '../../src/modules/blog/models/article-author.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

const EDITORIAL = {
  key: 'wimall-editorial',
  // Not translated — a byline's name is the same in five languages. Only the job title
  // and the bio change.
  name: 'The WiMall team',
  type: 'Organization' as const,
  avatar_url: null,
  translations: {
    en: {
      title: 'Editorial',
      bio: 'The team behind WiMall, writing about selling, getting paid and delivering in Cameroon.',
    },
    fr: {
      title: 'Rédaction',
      bio: "L'équipe WiMall écrit sur la vente, les paiements et la livraison au Cameroun.",
    },
    pt: {
      title: 'Redação',
      bio: 'A equipa da WiMall escreve sobre vender, receber e entregar nos Camarões.',
    },
    es: {
      title: 'Redacción',
      bio: 'El equipo de WiMall escribe sobre vender, cobrar y entregar en Camerún.',
    },
    ar: {
      title: 'هيئة التحرير',
      bio: 'فريق WiMall يكتب عن البيع والتحصيل والتوصيل في الكاميرون.',
    },
  },
};

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('[seed:blog] Connected to MongoDB');

  await ArticleAuthorModel.updateOne(
    { key: EDITORIAL.key, deletedAt: null },
    { $set: { ...EDITORIAL, deletedAt: null } },
    { upsert: true },
  );
  console.log(`[seed:blog] Upserted author ${EDITORIAL.key} (${EDITORIAL.name}, ${EDITORIAL.type})`);

  const articles = await mongoose.connection.collection('articles').countDocuments({ deletedAt: null });
  console.log(
    `[seed:blog] ${articles} article(s) in the database. ` +
      'None are seeded here — publish through wi-admin, POST /api/v1/content/articles.',
  );

  await mongoose.disconnect();
  console.log('[seed:blog] Done');
}

run().catch((err) => {
  console.error('[seed:blog] Failed:', err);
  process.exit(1);
});
