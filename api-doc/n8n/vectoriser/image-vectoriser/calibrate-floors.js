// ═══════════════════════════════════════════════════════════════════════════
// calibrate-floors.js — how the image arm's two relevance floors were measured
// (README § 15.6). Kept so the numbers can be REPRODUCED, not so they can be
// trusted forever: re-measure on the live index once the backlog is embedded,
// and always after a model change.
//
//   cd jovi-mall && node api-doc/n8n/vectoriser/image-vectoriser/calibrate-floors.js [out.json] [maxSide=512]
//
// Reads VOYAGE_EMBEDDINGS_API_KEY from jovi-mall/.env and photos from the DEV
// storage tree as it stood on 2026-09-21 (paths below). Paced for the free tier:
// at most 5 images a request (the limiter refuses by IMAGE COUNT -- 11 images of
// 256px were refused, 6 of 512px accepted) and 25 s between requests.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve('node_modules/sharp'));

const env = fs.readFileSync('.env', 'utf8');
const KEY = (env.match(/^VOYAGE_EMBEDDINGS_API_KEY=(.*)$/m) || [])[1]?.trim();
if (!KEY) throw new Error('VOYAGE_EMBEDDINGS_API_KEY not found in .env');
const OUT = process.argv[2];
const MAX_SIDE = Number(process.argv[3] || 512);
const MAX_SIDE_OVERRIDE = { v: null };

const P = 'storage/products/2026/';
const docs = {
  clock:     P + '05/3a0a670b-d405-4883-862a-ffc22382fee5_lucas-d-Z3XXD6Lc0bQ-unsplash.jpg',
  bench:     P + '05/457e23ce-a05e-4dd4-9389-cd1d0c2dca3c_aaron-burden-b9drVB7xIOI-unsplash.jpg',
  bulbnote:  P + '05/5e4a04ad-2058-49f0-9319-e798e09cbd7e_absolutvision-82TpEld0_e4-unsplash.jpg',
  silhouette:P + '05/a6e4df5b-7b71-4ede-a57a-e27e6dee9896_aaker-gFmBquOaFDE-unsplash.jpg',
  dress:     P + '06/0428913d-5733-453e-887b-9356b9ae9df1_alessio-lin-HPTjNm_EMGc-unsplash.jpg',
  vintagecars: P + '06/1dcd51b4-616a-4e0a-af2a-556c6db7a85e_alex-suprun-A53o1drQS2k-unsplash.jpg',
  hskbook:   P + '07/2fa52769-bb10-417e-950a-5a9db2ce66e3_WhatsApp_Image_2026-07-21_at_04.27.02__1_.jpeg',
  sunset:    P + '06/29c9eca5-edfc-4b18-aad2-9be9cc7c4864_alessandro-erbetta-mpWPcRT9D1E-unsplash.jpg',
  leaf:      P + '06/501fc865-980c-4744-a47e-c24068e8f93c_adi-purba-nEQZ3HvdEcQ-unsplash.jpg',
  porsche:   P + '06/674599f5-7fe1-4fb8-88b6-5867c844b197_campbell-3ZUsNJhi_Ik-unsplash.jpg',
  cat:       P + '06/c41870b4-94bd-4dd5-a844-d3c84137ea47_amber-kipp-75715CVEJhI-unsplash.jpg',
};

// Customer-style photos: a crop, downscaled, recompressed like a chat app would.
// `expect` is the catalogue photo a good search returns first; null = nothing should match.
const photoQueries = [
  { id: 'clock-crop',   expect: 'clock',   src: docs.clock,   crop: { left: 650, top: 650, width: 700, height: 650 } },
  { id: 'porsche-crop', expect: 'porsche', src: docs.porsche, crop: { left: 300, top: 400, width: 1450, height: 700 } },
  { id: 'cat-crop',     expect: 'cat',     src: docs.cat,     crop: { left: 150, top: 350, width: 1100, height: 1100 } },
  { id: 'dress-crop',   expect: 'dress',   src: docs.dress,   crop: { left: 600, top: 600, width: 650, height: 1300 } },
  { id: 'hsk-other-page', expect: 'hskbook', src: P + '07/ae69034f-3b92-4ca4-8249-44834c7c4a0f_WhatsApp_Image_2026-07-21_at_04.27.02.jpeg' },
  { id: 'microscope',   expect: null, src: P + '06/0f0576f5-d1ff-4412-8460-084a3dcce713_analysis-2030265_1920.jpg' },
  { id: 'robot',        expect: null, src: P + '06/65959bec-5c31-4101-8b1d-12540e525948_alex-knight-2EJCSULRwC8-unsplash.jpg' },
  { id: 'empty-road',   expect: null, src: P + '06/67738fea-fd36-489b-866b-b1f64b7bda0f_agnieszka-kowalczyk-pfL2RHZWWMw-unsplash.jpg' },
  { id: 'umbrella-wall',expect: null, src: P + '06/d596f79a-4d90-45ff-acd5-dc8477f08f84_edu-lauton-TyQ-0lPp6e4-unsplash.jpg' },
];

const textQueries = [
  ['horloge murale', 'clock'], ['wall clock with roman numerals', 'clock'],
  ['banc de jardin en bois', 'bench'], ['robe en jean bleu', 'dress'],
  ['sac à dos en toile', 'dress'], ['voiture de sport noire', 'porsche'],
  ['black luxury car', 'porsche'], ['voitures anciennes de collection', 'vintagecars'],
  ['chat roux', 'cat'], ['livre pour apprendre le chinois', 'hskbook'],
  ['ampoule', 'bulbnote'], ['post-it jaune', 'bulbnote'],
  ['chaussures de sport', null], ['réfrigérateur', null], ['téléphone samsung', null],
  ['casserole en inox', null], ['parfum pour femme', null], ['matelas deux places', null],
  ['lunettes de soleil', null], ['ordinateur portable', null], ['sac de riz 50kg', null],
  ['ventilateur sur pied', null],
];

async function b64(file, crop) {
  // Free tier: 10K tokens a minute, and an image costs 1 token per 560 px. 512px on the
  // long side is ~175K px = ~312 tokens, so the whole calibration fits in one minute.
  let img = sharp(file).rotate();
  if (crop) img = img.extract(crop);
  const side = MAX_SIDE_OVERRIDE.v || MAX_SIDE;
  img = img.resize({ width: side, height: side, fit: "inside", withoutEnlargement: true }).jpeg({ quality: crop ? 60 : 85 });
  const buf = await img.toBuffer();
  const meta = await sharp(buf).metadata();
  const mime = meta.format === 'png' ? 'image/png' : 'image/jpeg';
  return { data: `data:${mime};base64,${buf.toString('base64')}`, px: meta.width * meta.height };
}

let calls = 0;
async function embed(inputs, inputType) {
  // 3 RPM: pace every call after the first by 25 s.
  await new Promise(r => setTimeout(r, calls++ > 0 ? 25000 : 65000));
  const res = await fetch('https://api.voyageai.com/v1/multimodalembeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'voyage-multimodal-3.5', input_type: inputType, inputs }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`[call ${calls} ${inputType}] Voyage ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

async function embedAll(inputs, inputType, per = 5) {
  const data = []; const usage = { image_pixels: 0, total_tokens: 0 };
  for (let i = 0; i < inputs.length; i += per) {
    const r = await embed(inputs.slice(i, i + per), inputType);
    for (const d of r.data) data.push({ ...d, index: d.index + i });
    usage.image_pixels += r.usage.image_pixels || 0; usage.total_tokens += r.usage.total_tokens || 0;
  }
  return { data, usage };
}
const cos = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - d / Math.sqrt(na * nb); };

(async () => {
  const docIds = Object.keys(docs);
  const docImgs = await Promise.all(docIds.map(k => b64(docs[k])));
  const D = await embedAll(docImgs.map(d => ({ content: [{ type: 'image_base64', image_base64: d.data }] })), 'document');
  console.log('docs:', D.data.length, 'dims:', D.data[0].embedding.length, 'usage:', JSON.stringify(D.usage));

  const qImgs = await Promise.all(photoQueries.map(q => b64(q.src, q.crop)));
  const Q = await embedAll(qImgs.map(d => ({ content: [{ type: 'image_base64', image_base64: d.data }] })), 'query');
  console.log('photo queries:', Q.data.length, 'usage:', JSON.stringify(Q.usage));

  const T = await embedAll(textQueries.map(([t]) => ({ content: [{ type: 'text', text: t }] })), 'query', 50);
  console.log('text queries:', T.data.length, 'usage:', JSON.stringify(T.usage));

  const hiIds = ["clock", "porsche"];
  const saved = MAX_SIDE_OVERRIDE.v; MAX_SIDE_OVERRIDE.v = 1440;
  const hiImgs = await Promise.all(hiIds.map(k => b64(docs[k])));
  MAX_SIDE_OVERRIDE.v = saved;
  const H = await embedAll(hiImgs.map(d => ({ content: [{ type: "image_base64", image_base64: d.data }] })), "document");
  console.log("hi-res check:", H.data.length, "usage:", JSON.stringify(H.usage));
  const byIndex = r => r.data.slice().sort((a, b) => a.index - b.index).map(x => x.embedding);
  const dv = byIndex(D), qv = byIndex(Q), tv = byIndex(T);

  const report = (label, expect, vec) => {
    const ranked = docIds.map((id, i) => ({ id, d: cos(vec, dv[i]) })).sort((a, b) => a.d - b.d);
    const target = expect ? ranked.findIndex(r => r.id === expect) : -1;
    return { label, expect, nearest: ranked[0].id, nearestD: +ranked[0].d.toFixed(4),
             targetRank: expect ? target + 1 : null, targetD: expect ? +ranked[target].d.toFixed(4) : null,
             secondD: +ranked[1].d.toFixed(4), top3: ranked.slice(0, 3).map(r => `${r.id}:${r.d.toFixed(3)}`).join(' ') };
  };
  const hv = byIndex(H);
  console.log("\n── SAME PHOTO, 1440px vs " + MAX_SIDE + "px (document vs document)");
  hiIds.forEach((id, i) => console.log("  ", id, cos(hv[i], dv[docIds.indexOf(id)]).toFixed(4)));
  const photo = photoQueries.map((q, i) => report(q.id, q.expect, qv[i]));
  const text = textQueries.map(([t, e], i) => report(t, e, tv[i]));
  console.log('\n── PHOTO → PHOTO'); console.table(photo);
  console.log('\n── TEXT → PHOTO'); console.table(text);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ photo, text, usage: { docs: D.usage, photos: Q.usage, texts: T.usage } }, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
