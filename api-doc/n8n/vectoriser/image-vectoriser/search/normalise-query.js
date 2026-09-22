const inp = $input.first().json || {};

const raw = String(inp.query == null ? "" : inp.query).trim();

// The CACHE KEY, not the embedded text. Case and spacing do not change what
// somebody meant, so folding them turns "Nike  Shoes" and "nike shoes" into one
// paid embedding instead of two. The ORIGINAL string is what gets embedded and
// what the keyword arm parses -- normalising the input to the model would throw
// away capitalisation its tokenizer legitimately uses.
const key = raw.toLowerCase().replace(/\s+/g, " ");

function blankToNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  return v;
}
function numOrNull(v) {
  const c = blankToNull(v);
  if (c === null) return null;
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

// ⚠ ZERO MEANS "NOT GIVEN" for the price ceiling and the distance floor -- and
// reading it literally was a live defect (found 2026-09-21, execution 1335).
// wi-mall-core's tool node cannot leave a typed `number` input blank (a blank one
// throws before this workflow even starts), so it sends maxDistance: 0, and an
// absent budget reaches here as maxPrice: 0. Taken at face value those are a
// relevance floor of 0.00 and a price ceiling of 0 XAF: the semantic arm matched
// nothing, the price filter excluded every priced product, product_search()
// returned NOTHING for every bot search, and every turn fell to the keyword
// fallback. Nobody searches for a distance of 0 or a budget of 0.
function positiveOrNull(v) {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
}

// A chat shows a handful of products, never a page of them. Capped rather than
// trusted: the caller is a language model, and this bounds what it can ask for.
const askedFor = numOrNull(inp.limit);
const limit = askedFor && askedFor > 0 ? Math.min(Math.trunc(askedFor), 10) : 5;

// ── THE RELEVANCE FLOOR, AND IT IS MEASURED ─────────────────────────────────
//
// The semantic arm is the only one with no natural floor: @@ and <% return
// nothing when nothing matches, but a nearest-neighbour scan always returns a
// full pool however unrelated it is. Without this, "chaussures de sport" against
// a catalogue holding no shoes returned five confident, unrelated products --
// earphones, a t-shirt, a fan -- and an AI agent presents those as
// recommendations. For this caller, NOTHING is a better answer than anything.
//
// 0.60 is not a guess. Measured on the live index (schema workflow, node 6):
//
//   "ventilateur sur pied"  nearest 0.3044   <- a genuine match
//   "chaussures de sport"   nearest 0.6908   <- nothing in the catalogue matches
//
// 0.60 sits between them with margin on both sides, and leaves room for a weaker
// but real semantic hit (a synonym, or a cross-language match) in the 0.3-0.6
// band. RE-MEASURE as the catalogue grows, and ALWAYS after changing the
// embedding model -- a distance from one vector space means nothing in another.
//
// A caller may still override it with a positive number.
const DEFAULT_MAX_DISTANCE = 0.60;
const askedDistance = positiveOrNull(inp.maxDistance);

// ── THE IMAGE ARM (README § 15) ─────────────────────────────────────────────
//
// A customer's photo from THIS message only -- owner decision 2026-09-21 -- used
// for this search and dropped: never cached, never stored. Only the four formats
// Voyage accepts; anything else searches by words alone.
//
// ⚠ TWO inputs, on purpose. wi-mall-core passes the message's picture whenever
// the message carried one (photoBase64), and the MODEL says whether this search
// is about it (usePhoto, a plain from-AI boolean -- the same shape as
// inStockOnly, the one pattern already proven in that tool node). A picture sent
// as support evidence must not turn an unrelated search into a photo search, so
// the photo counts only when usePhoto is exactly true.
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const wantsPhoto = inp.usePhoto === true || inp.usePhoto === "true";
const photoMime = String(inp.photoMimeType || "").toLowerCase().split(";")[0].trim();
const hasPhoto = wantsPhoto
  && typeof inp.photoBase64 === "string"
  && inp.photoBase64.trim().length > 0
  && PHOTO_TYPES.indexOf(photoMime) !== -1;

// The floors, MEASURED 2026-09-21 on real voyage-multimodal-3.5 vectors
// (README § 15.6, calibration-2026-09-21.json):
//   photo -> photo   matches 0.146-0.379, nothing-matches from 0.641   -> 0.50
//   text  -> photo   matches 0.498-0.827, nothing-matches from 0.773   -> 0.72
// The text floor is deliberately conservative -- those ranges overlap, and a
// wrong product shown is worse than a weak one missed, which the three text
// arms can still find. RE-MEASURE on the live index, and after any model change.
const IMAGE_FLOOR_PHOTO = 0.50;
const IMAGE_FLOOR_TEXT = 0.72;

// The text -> photo arm runs on typed queries too. On a cache miss it costs one
// voyage-multimodal-3.5 call, and that model's free-tier budget is SEPARATE from
// voyage-4's (measured 2026-09-21: a 4th voyage-4 call in a minute got 429, a
// multimodal call in the same minute got 200), so it cannot starve the text
// search. Set false to run the image arm for photos only.
const IMAGE_ARM_FOR_TEXT = true;

const hasText = raw !== "";

return [{ json: {
  query: raw,
  query_key: key,
  limit: limit,
  country: blankToNull(inp.country),
  category: blankToNull(inp.category),
  maxPrice: positiveOrNull(inp.maxPrice),
  inStockOnly: inp.inStockOnly === true || inp.inStockOnly === "true",
  maxDistance: askedDistance === null ? DEFAULT_MAX_DISTANCE : askedDistance,
  has_text: hasText,
  has_photo: hasPhoto,
  photo_mime: hasPhoto ? photoMime : null,
  image_arm: hasPhoto || (hasText && IMAGE_ARM_FOR_TEXT),
  // Typed words are cached under their own namespace; a photo never is.
  image_query_key: hasPhoto ? null : (hasText ? "text:" + key : null),
  imageMaxDistance: hasPhoto ? IMAGE_FLOOR_PHOTO : IMAGE_FLOOR_TEXT,
} }];
