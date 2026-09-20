import 'dotenv/config';
import express from 'express';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 4318);
const EBAY_ENV = String(process.env.EBAY_ENV || 'production').toLowerCase();
const MARKETPLACE = process.env.EBAY_MARKETPLACE_ID || 'EBAY_US';
const IS_SANDBOX = EBAY_ENV !== 'production';
const APP_ID = IS_SANDBOX ? (process.env.SB_APP_ID || process.env.APP_ID || '') : (process.env.APP_ID || '');
const CERT_ID = IS_SANDBOX ? (process.env.SB_CERT_ID || process.env.CERT_ID || '') : (process.env.CERT_ID || '');
const EPN_CAMPAIGN_ID = process.env.CT_EPN_CAMPAIGN_ID || process.env.EPN_CAMPAIGN_ID || '5339211724';
const CACHE_SECONDS = Math.max(60, Number(process.env.CACHE_SECONDS || 300));
const RATE_LIMIT_PER_MINUTE = Math.max(10, Number(process.env.RATE_LIMIT_PER_MINUTE || 90));
const API_BASE = IS_SANDBOX ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
const TOKEN_URL = `${API_BASE}/identity/v1/oauth2/token`;
const SEARCH_URL = `${API_BASE}/buy/browse/v1/item_summary/search`;
const ALLOWED_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || 'https://curatedtrading.com,https://www.curatedtrading.com').split(',').map(x => x.trim()).filter(Boolean));

const LANES = {
  'heavy-equipment': {
    label: 'Heavy Equipment',
    queries: ['excavator', 'crane', 'forklift', 'skid steer', 'wheel loader', 'backhoe', 'bulldozer', 'telehandler']
  },
  pallets: {
    label: 'Pallets & Bulk Lots',
    queries: ['pallet wholesale lot', 'liquidation pallet', 'bulk lot wholesale', 'truckload inventory', 'case lot wholesale']
  },
  industrial: {
    label: 'Industrial Machinery',
    queries: ['CNC machine', 'industrial lathe', 'milling machine', 'industrial generator', 'air compressor industrial', 'welding machine industrial']
  },
  commercial: {
    label: 'Commercial Mobility',
    queries: ['commercial trailer', 'dump trailer', 'utility trailer', 'work truck', 'box truck', 'material handling equipment']
  },
  agriculture: {
    label: 'Agriculture',
    queries: ['farm tractor', 'agricultural equipment', 'tractor attachment', 'farm implement', 'mini excavator farm']
  },
  oddities: {
    label: 'Oversized Oddities',
    queries: ['industrial surplus', 'large commercial equipment', 'amusement ride', 'aircraft equipment', 'shipping container', 'specialty vehicle']
  }
};

const FEATURED_QUERIES = [
  'excavator', 'crane', 'forklift', 'pallet wholesale lot', 'CNC machine',
  'commercial trailer', 'farm tractor', 'industrial generator', 'shipping container', 'industrial surplus'
];

const bulkWords = ['pallet', 'pallets', 'bulk', 'wholesale', 'lot of', 'case lot', 'truckload', 'quantity', 'qty', 'liquidation'];
const heavyWords = ['excavator', 'crane', 'forklift', 'loader', 'backhoe', 'bulldozer', 'skid steer', 'telehandler', 'dozer', 'boom lift', 'scissor lift'];
const industrialWords = ['cnc', 'lathe', 'mill', 'milling', 'compressor', 'generator', 'welder', 'industrial', 'machinery', 'machine', 'press', 'conveyor'];
const commercialWords = ['trailer', 'truck', 'commercial', 'container', 'material handling', 'utility vehicle', 'dump'];
const agricultureWords = ['tractor', 'farm', 'agricultural', 'agriculture', 'implement', 'harvester', 'baler'];
const oddWords = ['surplus', 'aircraft', 'amusement', 'specialty', 'oversized', 'container', 'ride', 'military'];

let tokenCache = { token: '', expiresAt: 0 };
const responseCache = new Map();
const rateBuckets = new Map();

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt > 60000) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > RATE_LIMIT_PER_MINUTE) return res.status(429).json({ error: 'rate_limited' });
  next();
}

app.use(cors);
app.use(rateLimit);

function safeText(value, max = 140) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function priceNumber(item) {
  const n = Number(item?.price?.value);
  return Number.isFinite(n) ? n : 0;
}

function containsAny(text, words) {
  const lower = String(text || '').toLowerCase();
  return words.some(word => lower.includes(word));
}

function detectLane(title) {
  if (containsAny(title, bulkWords)) return { key: 'pallets', label: LANES.pallets.label };
  if (containsAny(title, heavyWords)) return { key: 'heavy-equipment', label: LANES['heavy-equipment'].label };
  if (containsAny(title, agricultureWords)) return { key: 'agriculture', label: LANES.agriculture.label };
  if (containsAny(title, industrialWords)) return { key: 'industrial', label: LANES.industrial.label };
  if (containsAny(title, commercialWords)) return { key: 'commercial', label: LANES.commercial.label };
  if (containsAny(title, oddWords)) return { key: 'oddities', label: LANES.oddities.label };
  return { key: 'oddities', label: 'Curated Find' };
}

function scoreItem(item) {
  const title = String(item?.title || '');
  const price = priceNumber(item);
  const signals = [];
  let score = 24;

  if (containsAny(title, bulkWords)) { score += 22; signals.push('bulk / quantity signal'); }
  if (containsAny(title, heavyWords)) { score += 20; signals.push('heavy equipment signal'); }
  if (containsAny(title, industrialWords)) { score += 15; signals.push('industrial utility'); }
  if (containsAny(title, commercialWords)) { score += 10; signals.push('commercial asset'); }
  if (containsAny(title, agricultureWords)) { score += 10; signals.push('agricultural asset'); }
  if (containsAny(title, oddWords)) { score += 8; signals.push('unusual inventory'); }

  if (price >= 100000) { score += 22; signals.push('$100K+ transaction'); }
  else if (price >= 50000) { score += 18; signals.push('$50K+ transaction'); }
  else if (price >= 25000) { score += 15; signals.push('$25K+ transaction'); }
  else if (price >= 10000) { score += 12; signals.push('$10K+ transaction'); }
  else if (price >= 5000) { score += 8; signals.push('$5K+ transaction'); }
  else if (price >= 1000) { score += 4; signals.push('$1K+ transaction'); }

  if (Array.isArray(item?.buyingOptions) && item.buyingOptions.includes('AUCTION')) { score += 4; signals.push('auction discovery'); }
  if (item?.seller?.feedbackScore >= 1000) { score += 4; signals.push('established seller'); }
  if (item?.image?.imageUrl) score += 3;
  if (item?.itemLocation?.stateOrProvince || item?.itemLocation?.country) score += 2;

  return { score: Math.min(100, score), signals: signals.slice(0, 5) };
}

function affiliateUrl(rawUrl, lane) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.includes('ebay.')) return rawUrl;
    url.searchParams.set('mkevt', '1');
    url.searchParams.set('mkcid', '1');
    url.searchParams.set('mkrid', '711-53200-19255-0');
    url.searchParams.set('campid', EPN_CAMPAIGN_ID);
    url.searchParams.set('toolid', '10001');
    url.searchParams.set('customid', `curatedtrading-${lane || 'discovery'}`.slice(0, 64));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function normalizeItem(item) {
  const lane = detectLane(item?.title);
  const scored = scoreItem(item);
  const image = item?.image?.imageUrl || item?.thumbnailImages?.[0]?.imageUrl || null;
  return {
    id: item?.itemId || null,
    title: item?.title || null,
    price: item?.price ? { value: item.price.value ?? null, currency: item.price.currency || 'USD' } : null,
    image,
    imageUrl: image,
    condition: item?.condition || null,
    buyingOptions: Array.isArray(item?.buyingOptions) ? item.buyingOptions : [],
    itemWebUrl: item?.itemWebUrl || null,
    affiliateUrl: affiliateUrl(item?.itemWebUrl, lane.key),
    seller: item?.seller ? {
      username: item.seller.username || null,
      feedbackScore: item.seller.feedbackScore ?? null,
      feedbackPercentage: item.seller.feedbackPercentage ?? null
    } : null,
    itemLocation: item?.itemLocation ? {
      city: item.itemLocation.city || null,
      stateOrProvince: item.itemLocation.stateOrProvince || null,
      country: item.itemLocation.country || null
    } : {},
    curatedLane: lane.label,
    curatedLaneKey: lane.key,
    curatedScore: scored.score,
    curatedSignals: scored.signals
  };
}

function usable(item) {
  return Boolean(item?.id && item?.title && item?.price?.value != null && item?.itemWebUrl && item?.image);
}

async function getToken() {
  if (!APP_ID || !CERT_ID) throw Object.assign(new Error('eBay credentials missing'), { status: 500 });
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60000) return tokenCache.token;
  const basic = Buffer.from(`${APP_ID}:${CERT_ID}`, 'utf8').toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const message = payload.error_description || payload.error || `eBay OAuth failed (${response.status})`;
    throw Object.assign(new Error(message), { status: 502 });
  }
  tokenCache = { token: payload.access_token, expiresAt: now + Number(payload.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

async function browse({ query, minPrice = 0, offset = 0, limit = 50 }) {
  const descriptor = `${EBAY_ENV}|${query}|${minPrice}|${offset}|${limit}`;
  const cached = responseCache.get(descriptor);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  const token = await getToken();
  const url = new URL(SEARCH_URL);
  url.searchParams.set('q', safeText(query, 120));
  url.searchParams.set('limit', String(Math.min(50, Math.max(1, limit))));
  url.searchParams.set('offset', String(Math.max(0, offset)));
  if (minPrice > 0 && !IS_SANDBOX) {
    url.searchParams.set('filter', `price:[${minPrice}..],priceCurrency:USD`);
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(22000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstream = payload?.errors?.[0];
    throw Object.assign(new Error(upstream?.message || `eBay Browse failed (${response.status})`), { status: 502 });
  }
  responseCache.set(descriptor, { payload, expiresAt: Date.now() + CACHE_SECONDS * 1000 });
  return payload;
}

function curate(rawItems, minPrice, limit) {
  const seen = new Set();
  return rawItems
    .map(normalizeItem)
    .filter(usable)
    .filter(item => priceNumber(item) >= minPrice)
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => (b.curatedScore - a.curatedScore) || (priceNumber(b) - priceNumber(a)))
    .slice(0, limit);
}

async function multiBrowse(queries, { minPrice = 0, offset = 0, sourceLimit = 30 } = {}) {
  const results = await Promise.allSettled(queries.map(query => browse({ query, minPrice, offset, limit: sourceLimit })));
  const rawItems = [];
  let sourceTotal = 0;
  let more = false;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const payload = result.value;
    rawItems.push(...(Array.isArray(payload.itemSummaries) ? payload.itemSummaries : []));
    sourceTotal += Number(payload.total || 0);
    if (Number(payload.total || 0) > offset + sourceLimit) more = true;
  }
  return { rawItems, sourceTotal, more };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'curatedtrading-ebay-gateway', version: VERSION, environment: EBAY_ENV, marketplace: MARKETPLACE });
});

app.get('/api/commerce/ebay/status', async (req, res, next) => {
  try {
    await getToken();
    res.json({ ok: true, tokenValid: true, environment: EBAY_ENV, marketplace: MARKETPLACE, version: VERSION });
  } catch (error) { next(error); }
});

app.get('/api/commerce/curated/lanes', (req, res) => {
  res.json({ ok: true, lanes: Object.entries(LANES).map(([key, lane]) => ({ key, label: lane.label })) });
});

app.get('/api/commerce/curated/featured', async (req, res, next) => {
  try {
    const minPrice = Math.max(0, Number(req.query.min_price || 5000));
    const limit = clampInt(req.query.limit, 1, 32, 16);
    const { rawItems, sourceTotal } = await multiBrowse(FEATURED_QUERIES, { minPrice, offset: 0, sourceLimit: 24 });
    const items = curate(rawItems, minPrice, limit);
    res.json({ ok: true, environment: EBAY_ENV, mode: 'featured', sourceTotal, count: items.length, hasMore: false, nextOffset: null, items });
  } catch (error) { next(error); }
});

app.get('/api/commerce/curated/search', async (req, res, next) => {
  try {
    const q = safeText(req.query.q, 120);
    const laneKey = safeText(req.query.lane, 40);
    const minPrice = Math.max(0, Number(req.query.min_price || 0));
    const limit = clampInt(req.query.limit, 1, 32, 16);
    const offset = clampInt(req.query.offset, 0, 9950, 0);

    let queries = [];
    if (q) queries = [q];
    else if (LANES[laneKey]) queries = LANES[laneKey].queries.slice(0, 5);
    else queries = FEATURED_QUERIES.slice(0, 5);

    const sourceLimit = q ? 50 : 30;
    const { rawItems, sourceTotal, more } = await multiBrowse(queries, { minPrice, offset, sourceLimit });
    const items = curate(rawItems, minPrice, limit);
    const nextOffset = more ? offset + sourceLimit : null;
    res.json({
      ok: true,
      environment: EBAY_ENV,
      mode: 'search',
      query: q || null,
      lane: laneKey || null,
      sourceTotal,
      count: items.length,
      hasMore: nextOffset != null,
      nextOffset,
      items
    });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    error: 'curatedtrading_gateway_error',
    message: error.message || 'Unexpected marketplace gateway error'
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`CuratedTrading eBay gateway ${VERSION} listening on 127.0.0.1:${PORT} (${EBAY_ENV})`);
});
