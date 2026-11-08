// Builds EVERY product's text in one pass, then groups them into chunks that the
// embedding call can take in a SINGLE request.
//
// ── Why chunks ──────────────────────────────────────────────────────────────
// Voyage accepts up to 128 inputs per request. The previous shape called it once
// per product, and on this account that hit a wall: the free tier without a
// payment method is 3 REQUESTS PER MINUTE, so the fourth product of any minute
// was refused. Batching turns N calls into ceil(N/CHUNK_SIZE).
//
// ⚠ CHUNK_SIZE is 32, not 128, and the reason is that requests stop being the
// binding limit once you batch: TOKENS do. The free tier allows 10K per minute,
// and a product is roughly 150-300 tokens, so ~40 products a minute is the real
// ceiling whatever the chunk size. A 128-product chunk could not fit in one
// minute's token budget, so it could not be retried into success either -- it
// would just fail bigger. 32 keeps a chunk inside the budget.
//
// ── Two kinds of item come out of here ──────────────────────────────────────
// `chunk`  — products whose text built, ready to embed.
// `failed` — a product whose payload was missing or whose text threw. These skip
//            embedding entirely and are already in final report shape, so they
//            still reach the report and the debug table. Dropping them here is
//            how a product silently disappears between "accepted" and "done".
const CHUNK_SIZE = 32;
const MAX_TEXT = 12000;
const DEFAULT_CURRENCY = 'XAF';

function clean(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

// Number(null) is 0 and Number('') is 0, and both are finite -- a bare Number()
// here turns "the vendor set no compare-at price" into "it was free".
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v, currency) {
  const n = num(v);
  if (n === null) return '';
  return n.toLocaleString('en-US') + ' ' + (currency || DEFAULT_CURRENCY);
}

function list(items) {
  const xs = (items || []).map(clean).filter(Boolean);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
}

function bytes(n) {
  const b = num(n);
  if (b === null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
  return (b / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
}

function mimeLabel(mime) {
  const m = clean(mime);
  if (!m) return '';
  const sub = m.split('/')[1] || m;
  return sub.replace(/^x-/, '').toUpperCase();
}

const COUNTRIES = { cm: 'Cameroon', ng: 'Nigeria', ga: 'Gabon', td: 'Chad', cf: 'Central African Republic', gq: 'Equatorial Guinea', cg: 'Congo' };
function country(code) {
  const c = clean(code);
  if (!c) return '';
  return COUNTRIES[c.toLowerCase()] || (c.length === 2 ? c.toUpperCase() : c);
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function variantLabel(v) {
  const name = clean(v.name);
  if (name) return name;
  const opts = (v.options || []).map(function (o) {
    const value = clean(o.value);
    if (!value) return '';
    const axis = clean(o.option);
    return axis ? axis + ' ' + value : value;
  }).filter(Boolean);
  if (opts.length) return opts.join(' / ');
  return clean(v.sku) || 'Standard';
}

function variantInStock(v) {
  if (v.isInfiniteStock === true) return true;
  const s = num(v.stock);
  return s !== null && s > 0;
}

// A BPE-shaped approximation, used only to APPORTION the chunk's real token
// total between its products -- the provider reports usage per REQUEST, not per
// input, so a batched call can be exact about the sum and only proportional
// about the split. A one-product chunk is exact.
function estimateTokens(s) {
  const text = String(s || '');
  if (!text) return 0;
  const pieces = text.match(/[A-Za-zÀ-ÿ]+|\d+|\S/g) || [];
  let total = 0;
  for (const p of pieces) {
    if (/^\d/.test(p)) total += Math.ceil(p.length / 2);
    else if (/^[A-Za-zÀ-ÿ]/.test(p)) total += Math.max(1, Math.ceil(p.length / 4.5));
    else total += 1;
  }
  return total;
}

function buildProductText(p) {
  const currency = clean(p.currency) || DEFAULT_CURRENCY;
  const type = clean(p.type) || 'physical';
  const title = clean(p.title) || 'Untitled product';
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const vendorName = clean(p.vendor && (p.vendor.business_name || p.vendor.display_name));
  const vendorCountry = country(p.vendor && p.vendor.country);

  const lines = [];
  lines.push(title);
  lines.push('');

  const noun = type === 'service' ? 'service' : type === 'digital' ? 'digital product' : 'product';
  const verb = type === 'service' ? 'provided by' : type === 'digital' ? 'offered by' : 'sold by';
  let identity = title + ' is a ' + noun;
  if (vendorName) identity += ' ' + verb + ' ' + vendorName;
  if (vendorCountry) identity += ' in ' + vendorCountry;
  lines.push(identity + '.');

  // 2026-10-04: a product holds 1-5 categories (jovi-mall sends `categories`, names in the
  // vendor's order, plus `category` = the first). A payload without the list (the CSV path,
  // an older job) falls back to the single value, so either shape indexes the same way.
  const categories = (Array.isArray(p.categories) && p.categories.length ? p.categories : [p.category])
    .map(clean).filter(Boolean)
    .filter(function (c, i, all) { return all.indexOf(c) === i; });
  const category = categories.length ? categories[0] : '';
  const tags = (p.tags || []).map(clean).filter(Boolean);
  if (categories.length) lines.push((categories.length > 1 ? 'Categories: ' : 'Category: ') + categories.join(', ') + '.');
  if (tags.length) lines.push('Tags: ' + tags.join(', ') + '.');

  const prices = variants.map(function (v) { return num(v.price); }).filter(function (n) { return n !== null; });
  const priceMin = prices.length ? Math.min.apply(null, prices) : null;
  const priceMax = prices.length ? Math.max.apply(null, prices) : null;

  if (priceMin !== null && priceMax !== null) {
    if (type === 'service') {
      const svc = variants.find(function (v) { return v.serviceConfig; });
      const mins = svc ? num(svc.serviceConfig.durationMinutes) : null;
      lines.push(mins
        ? 'Price: ' + money(priceMin, currency) + ' per ' + mins + ' minutes, charged for the time actually booked.'
        : 'Price: ' + money(priceMin, currency) + '.');
    } else if (priceMin === priceMax) {
      lines.push('Price: ' + money(priceMin, currency) + '.');
    } else {
      lines.push('Price: from ' + money(priceMin, currency) + ' to ' + money(priceMax, currency) + ' across ' + variants.length + ' options.');
    }
  }

  const compares = variants
    .map(function (v) { return { was: num(v.compareAtPrice), now: num(v.price) }; })
    .filter(function (x) { return x.was !== null && x.now !== null && x.was > x.now; });
  if (compares.length) {
    const best = compares.reduce(function (a, b) { return (1 - b.now / b.was) > (1 - a.now / a.was) ? b : a; });
    const pct = Math.round((1 - best.now / best.was) * 100);
    lines.push('On offer: was ' + money(best.was, currency) + ', now ' + money(best.now, currency) + ' - ' + pct + '% off.');
  }

  const bargainable = variants.some(function (v) { return v.bargain && num(v.bargain.maxPrice) !== null; });
  if (bargainable) lines.push('The price on this item is negotiable - the customer may make an offer.');

  const inStockVariants = variants.filter(variantInStock);
  const infinite = variants.some(function (v) { return v.isInfiniteStock === true; });
  const finiteStock = variants
    .filter(function (v) { return v.isInfiniteStock !== true; })
    .map(function (v) { return num(v.stock) || 0; })
    .reduce(function (a, b) { return a + b; }, 0);

  if (variants.length === 0) {
    lines.push('Availability: not currently purchasable.');
  } else if (type === 'digital') {
    lines.push('Availability: available for immediate download after payment.');
  } else if (type === 'service') {
    lines.push('Availability: bookable.');
  } else if (inStockVariants.length === 0) {
    lines.push('Availability: currently out of stock.');
  } else if (!infinite && finiteStock <= 5) {
    lines.push('Availability: in stock, only a few left.');
  } else if (inStockVariants.length < variants.length) {
    lines.push('Availability: in stock - ' + inStockVariants.length + ' of ' + variants.length + ' options available.');
  } else {
    lines.push('Availability: in stock.');
  }

  const axes = {};
  const axisOrder = [];
  variants.forEach(function (v) {
    (v.options || []).forEach(function (o) {
      const name = clean(o.option);
      const value = clean(o.value);
      if (!name || !value) return;
      if (!axes[name]) { axes[name] = []; axisOrder.push(name); }
      if (axes[name].indexOf(value) === -1) axes[name].push(value);
    });
  });
  if (axisOrder.length) {
    lines.push('Available in ' + axisOrder.map(function (n) { return n + ' (' + axes[n].join(', ') + ')'; }).join('; ') + '.');
  }

  if (variants.length) {
    lines.push('Options and prices:');
    variants.forEach(function (v) {
      const sku = clean(v.sku);
      const stockNote = (type === 'physical') ? ', ' + (variantInStock(v) ? 'in stock' : 'out of stock') : '';
      let row = '- ' + variantLabel(v) + (sku ? ' (SKU ' + sku + ')' : '') + ': ' + money(v.price, currency) + stockNote;
      const w = num(v.weight);
      const dims = [num(v.length), num(v.width), num(v.height)];
      const extra = [];
      if (w !== null && w > 0) extra.push(w + ' g');
      if (dims.every(function (d) { return d !== null && d > 0; })) extra.push(dims[0] + ' x ' + dims[1] + ' x ' + dims[2] + ' cm');
      if (extra.length) row += ' (' + extra.join('; ') + ')';
      lines.push(row + '.');
    });
  }

  if (type === 'digital') {
    const dv = variants.find(function (v) { return v.digitalConfig; });
    if (dv) {
      const a = dv.digitalConfig.asset;
      const parts = [];
      if (a) {
        const label = mimeLabel(a.mimeType);
        const size = bytes(a.size);
        const detail = label ? ' (' + label + (size ? ', ' + size : '') + ')' : '';
        parts.push('the file ' + clean(a.originalName) + detail);
      }
      const md = num(dv.digitalConfig.maxDownloads);
      parts.push(md === null ? 'unlimited downloads' : md + ' download' + (md === 1 ? '' : 's'));
      const ex = num(dv.digitalConfig.expiresAfterDays);
      parts.push(ex === null ? 'no expiry' : 'access expires ' + ex + ' day' + (ex === 1 ? '' : 's') + ' after purchase');
      lines.push('Delivered digitally: ' + list(parts) + '.');
    } else {
      lines.push('Delivered digitally as a download after payment.');
    }
    if (p.digitalConfig && p.digitalConfig.isActive === false) {
      lines.push('Digital delivery is currently switched off for this product.');
    }
  } else if (type === 'service') {
    const sv = variants.find(function (v) { return v.serviceConfig; });
    if (sv) {
      const sc = sv.serviceConfig;
      const mode = clean(sc.bookingMode);
      const modeText = mode === 'calendar' ? 'booked from the vendor calendar'
        : mode === 'capacity' ? 'booked into a shared slot'
        : 'booked by arrangement with the vendor';
      const parts = ['sold in ' + num(sc.durationMinutes) + '-minute sessions', modeText];
      if (mode === 'capacity' && num(sc.maxBookings)) parts.push('up to ' + num(sc.maxBookings) + ' people per slot');
      const bb = num(sc.bufferBeforeMinutes) || 0;
      const ba = num(sc.bufferAfterMinutes) || 0;
      if (bb > 0 || ba > 0) parts.push('with ' + bb + ' minutes before and ' + ba + ' minutes after each session');
      lines.push('This service is ' + list(parts) + '.');
      if (sc.peakHours) {
        const ph = sc.peakHours;
        const days = (ph.daysOfWeek && ph.daysOfWeek.length)
          ? list(ph.daysOfWeek.map(function (d) { return DAYS[d] || ('day ' + d); }))
          : 'every day';
        const surcharge = ph.priceType === 'percentage' ? num(ph.value) + '%' : money(ph.value, currency);
        lines.push('A peak-hours surcharge of ' + surcharge + ' applies ' + days + ' between ' + clean(ph.startTime) + ' and ' + clean(ph.endTime) + '.');
      }
    }
  } else {
    const agency = p.delivery && p.delivery.agency;
    if (agency && clean(agency.name)) {
      const where = country(agency.country);
      lines.push('Delivery is handled by ' + clean(agency.name) + (where ? ' in ' + where : '') + '.');
    }
  }

  const description = clean(p.description);
  if (description) lines.push('Description: ' + description);

  const images = Array.isArray(p.images) ? p.images.filter(function (f) { return f && f.url; }) : [];
  if (images.length) lines.push(images.length + ' product photo' + (images.length === 1 ? '' : 's') + ' available.');

  const seoBits = [clean(p.seo && p.seo.title), clean(p.seo && p.seo.description)].filter(Boolean);
  if (seoBits.length) lines.push('Also described as: ' + seoBits.join(' '));

  lines.push('Reference: product ' + clean(p.product_id) + ', slug ' + clean(p.slug) + '.');

  let text = lines.join('\n').trim();

  if (text.length > MAX_TEXT && description) {
    const overflow = text.length - MAX_TEXT;
    const keep = Math.max(200, description.length - overflow - 20);
    const shortened = description.slice(0, keep).replace(/\s+\S*$/, '') + '...';
    text = text.replace('Description: ' + description, 'Description: ' + shortened);
  }
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 3) + '...';

  const primaryImage = images.length ? clean(images[0].url) : null;

  const metadata = {
    product_id: clean(p.product_id),
    title: title,
    slug: clean(p.slug),
    type: type,
    status: clean(p.status),
    category: category || null,
    categories: categories,
    tags: tags,
    vendor_id: clean(p.vendor && p.vendor.id) || null,
    vendor_name: vendorName || null,
    country: clean(p.vendor && p.vendor.country) || null,
    currency: currency,
    price_min: priceMin,
    price_max: priceMax,
    in_stock: inStockVariants.length > 0,
    stock_total: infinite ? null : finiteStock,
    bargainable: bargainable,
    bargain_windows: variants.filter(function (v) { return v.bargain; }).map(function (v) {
      return { variant_id: clean(v.id), sku: clean(v.sku), floor: num(v.bargain.minPrice), ceiling: num(v.bargain.maxPrice) };
    }),
    variant_count: variants.length,
    primary_image: primaryImage,
    images: images.slice(0, 5).map(function (f) { return clean(f.url); }),
    // The image arm's own key (README § 15). NOT `images` above, which is five
    // bare URL strings with readers of its own; product_vectors' trigger reads this.
    image_files: embeddableImages(p),
    delivery_agency: (p.delivery && p.delivery.agency && clean(p.delivery.agency.name)) || null,
    variants: variants.map(function (v) {
      return { id: clean(v.id), sku: clean(v.sku), label: variantLabel(v), price: num(v.price), compare_at_price: num(v.compareAtPrice), in_stock: variantInStock(v) };
    }),
  };

  return { text: text, metadata: metadata };
}

// ── embeddableImages(p): the photos the image arm embeds (README § 15) ────────
// It only LISTS them into metadata.image_files; wi-mall-image-vectoriser embeds them.
//
// Which images, and why:
//   · pictures only: PNG / JPEG / WEBP / GIF -- the four Voyage accepts. A video
//     in the gallery (video/mp4) and a digital asset (variants[].digitalConfig.asset,
//     never read here) are skipped by construction, not by a filter someone has
//     to remember.
//   · https only: Voyage fetches the URL itself from the public internet. An
//     http:// URL is a dev laptop's storage, which Voyage can never reach, and
//     queuing it would only burn five attempts.
//   · gallery first, then each variant's own photos, in payload order. Position
//     0 is the product's primary image, and the drainer embeds every product's
//     position 0 before anyone's position 1.
//   · deduplicated by file id: a gallery photo reused on a variant is one image.
//   · at most MAX_IMAGES_PER_PRODUCT. At the free tier's 2 images a minute, six is
//     three minutes of the drainer per product; the cap bounds the queue a single
//     vendor with 40 photos could otherwise build.
//   · url null means the platform withheld the address (quota-blocked file). It is
//     skipped rather than guessed.

const EMBEDDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES_PER_PRODUCT = 6;

function embeddableImages(p) {
  const out = [];
  const seen = new Set();
  const take = (f, variantId) => {
    if (!f || typeof f !== 'object' || out.length >= MAX_IMAGES_PER_PRODUCT) return;
    const fileId = f.id != null ? String(f.id) : '';
    const url = typeof f.url === 'string' ? f.url.trim() : '';
    const mime = String(f.mimeType || '').toLowerCase().split(';')[0].trim();
    if (!fileId || seen.has(fileId)) return;
    if (!/^https:\/\//i.test(url)) return;
    if (!EMBEDDABLE_IMAGE_TYPES.has(mime)) return;
    seen.add(fileId);
    out.push({ file_id: fileId, url, variant_id: variantId, mime_type: mime });
  };
  for (const f of Array.isArray(p?.images) ? p.images : []) take(f, null);
  for (const v of Array.isArray(p?.variants) ? p.variants : []) {
    for (const f of Array.isArray(v?.files) ? v.files : []) take(f, v?.id != null ? String(v.id) : null);
  }
  return out;
}

// ── buildListingText(p): a SERVICE LISTING (SERVICE-LISTINGS-PLAN L-18, L-26, 2026-11-08) ──
// jovi-mall's listing payload holds public fields only: no contact, no vendor block, no pin. The
// row is keyed `listing:<id>`, typed `listing` (so a product-type filter never returns it) and
// carries no price and no stock (a price or in-stock filter excludes it, which is right: a
// listing is not sold). No `image_files`: listing photos are not in the image arm in v1.
function buildListingText(p) {
  const id = clean(p.listing_id);
  const title = clean(p.title);
  const company = clean(p.company_name);
  const categories = (Array.isArray(p.categories) ? p.categories : []).map(clean).filter(Boolean);
  const category = clean(p.category) || categories[0] || null;
  const place = [clean(p.area), clean(p.city), country(p.country)].filter(Boolean).join(', ');
  const lines = [];
  lines.push('Service listing: ' + title + (company ? ', by ' + company : '') + '.');
  lines.push('A local business that provides this service in person. The customer unlocks its contact details on Wi-Mall; nothing is bought through Wi-Mall.');
  if (categories.length) lines.push('Categories: ' + list(categories) + '.');
  if (place) lines.push('Location: ' + place + '.');
  const hours = (Array.isArray(p.opening_hours) ? p.opening_hours : []).map(function (h) {
    if (!h || !h.day) return '';
    const day = clean(h.day).charAt(0).toUpperCase() + clean(h.day).slice(1);
    return h.is_closed ? day + ' closed' : day + ' ' + clean(h.open_time) + '-' + clean(h.close_time);
  }).filter(Boolean);
  if (hours.length) lines.push('Opening hours: ' + hours.join('; ') + '.');
  const description = clean(p.description);
  if (description) lines.push('Description: ' + description);
  lines.push('Reference: listing ' + id + ', slug ' + clean(p.slug) + '.');
  let text = lines.join(String.fromCharCode(10)).trim();
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 3) + '...';
  const images = (Array.isArray(p.images) ? p.images : []).map(function (f) { return f && typeof f.url === 'string' ? clean(f.url) : ''; }).filter(Boolean);
  const metadata = {
    product_id: 'listing:' + id,
    kind: 'listing',
    listing_id: id,
    title: title,
    slug: clean(p.slug),
    type: 'listing',
    status: 'active',
    category: category,
    categories: categories,
    tags: [],
    vendor_id: null,
    vendor_name: company || null,
    country: clean(p.country) || null,
    city: clean(p.city) || null,
    area: clean(p.area) || null,
    currency: null,
    price_min: null,
    price_max: null,
    in_stock: null,
    bargainable: false,
    variant_count: 0,
    primary_image: images.length ? images[0] : null,
    images: images.slice(0, 5),
  };
  return { text: text, metadata: metadata };
}

function emptyDebug() {
  return { title: null, product_type: null, product_status: null, text: '', text_length: 0, price_min: 0, price_max: 0, variant_count: 0, in_stock: false, bargainable: false, metadata_json: '{}' };
}

const ready = [];
const out = [];

for (const it of $input.all()) {
  const src = it.json || {};
  const productId = src.product_id || null;
  const p = src.product;

  if (!p) {
    out.push({ json: { kind: 'failed', product_id: productId, status: 'failed', vectorised_id: null, error: src.resolve_error || 'no payload for this product', token_estimate: 0, tokens_are_estimated: true, _debug: emptyDebug() } });
    continue;
  }

  try {
    const built = p.kind === 'listing' ? buildListingText(p) : buildProductText(p);
    if (!built.metadata.product_id) built.metadata.product_id = String(productId || '');
    ready.push({ product_id: built.metadata.product_id, text: built.text, metadata: built.metadata, token_estimate: estimateTokens(built.text) });
  } catch (e) {
    out.push({ json: { kind: 'failed', product_id: productId, status: 'failed', vectorised_id: null, error: 'text build failed: ' + (e.message || String(e)), token_estimate: 0, tokens_are_estimated: true, _debug: emptyDebug() } });
  }
}

for (let i = 0; i < ready.length; i += CHUNK_SIZE) {
  out.push({ json: { kind: 'chunk', chunk_index: Math.floor(i / CHUNK_SIZE), products: ready.slice(i, i + CHUNK_SIZE) } });
}

return out;