const API_BASE = 'https://api.curatedtrading.com';
const APP_VERSION = '1.1.0';

const state = {
  mode: 'featured',
  query: '',
  lane: '',
  offset: 0,
  nextOffset: null,
  hasMore: false,
  loading: false,
  detailRequest: 0,
  items: new Map()
};

const els = {
  status: document.querySelector('#api-status'),
  form: document.querySelector('#hero-search'),
  query: document.querySelector('#hero-query'),
  title: document.querySelector('#market-title'),
  grid: document.querySelector('#market-grid'),
  message: document.querySelector('#market-message'),
  minPrice: document.querySelector('#min-price'),
  refresh: document.querySelector('#refresh-market'),
  more: document.querySelector('#load-more'),
  dialog: document.querySelector('#detail-dialog'),
  dialogContent: document.querySelector('#detail-content'),
  dialogClose: document.querySelector('#detail-close')
};

document.querySelector('#year').textContent = new Date().getFullYear();

function money(price) {
  if (!price || price.value == null) return 'Price unavailable';
  const value = Number(price.value);
  if (!Number.isFinite(value)) return `${price.value} ${price.currency || ''}`.trim();
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency || 'USD',
      maximumFractionDigits: value >= 1000 ? 0 : 2
    }).format(value);
  } catch {
    return `$${value.toLocaleString()}`;
  }
}

function safe(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function itemLocation(item) {
  const loc = item.itemLocation || {};
  return [loc.city, loc.stateOrProvince, loc.postalCode, loc.country].filter(Boolean).join(', ') || 'Location varies';
}

function humanize(value) {
  return String(value || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function dateText(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, { retries = 2, timeoutMs = 30000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || payload.error || `Marketplace request failed (${response.status})`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(350 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('Marketplace request failed');
}

function setApiState(mode, label) {
  els.status.classList.remove('live', 'down');
  if (mode) els.status.classList.add(mode);
  els.status.innerHTML = `<i></i>${safe(label)}`;
}

async function checkHealth() {
  try {
    const health = await request('/health', { retries: 1, timeoutMs: 12000 });
    setApiState('live', `${health.environment === 'production' ? 'live' : health.environment} marketplace`);
    return true;
  } catch (error) {
    console.warn('CuratedTrading health check failed', error);
    return false;
  }
}

function renderCard(item) {
  const id = String(item.id || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
  state.items.set(id, item);
  const score = Math.round(Number(item.curatedScore || 0));
  const lane = item.curatedLane || item.lane || 'Curated find';
  const image = item.image || item.imageUrl || '';
  const location = itemLocation(item);
  const outbound = item.affiliateUrl || item.itemWebUrl || '#';
  return `
    <article class="item-card">
      <div class="item-image">
        ${image ? `<img src="${safe(image)}" alt="${safe(item.title)}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
        <span class="score">CURATED <b>${score || '—'}</b></span>
      </div>
      <div class="item-body">
        <span class="item-lane">${safe(lane)}</span>
        <h3 class="item-title">${safe(item.title || 'Marketplace discovery')}</h3>
        <div class="item-meta">
          <span class="item-price">${safe(money(item.price))}</span>
          <span class="item-location">${safe(location)}</span>
        </div>
        <div class="item-actions">
          <button class="details-btn" data-detail-id="${safe(id)}">Details</button>
          <a class="ebay-btn" href="${safe(outbound)}" target="_blank" rel="noopener sponsored">View listing</a>
        </div>
      </div>
    </article>`;
}

function renderShipping(option) {
  const type = humanize(option?.type || option?.shippingCostType || 'Shipping');
  const costValue = Number(option?.shippingCost?.value);
  const cost = option?.shippingCost
    ? (Number.isFinite(costValue) && costValue === 0 ? 'Free' : money(option.shippingCost))
    : 'Cost shown by seller';
  const min = dateText(option?.minEstimatedDeliveryDate);
  const max = dateText(option?.maxEstimatedDeliveryDate);
  const delivery = min && max ? `${min} – ${max}` : min || max || '';
  return `<div class="detail-shipping-row"><strong>${safe(type)}</strong><span>${safe(cost)}</span>${delivery ? `<small>Estimated ${safe(delivery)}</small>` : ''}</div>`;
}

function renderDetail(item, { loading = false, detailError = '' } = {}) {
  const images = [...new Set([...(Array.isArray(item.images) ? item.images : []), item.image, item.imageUrl].filter(Boolean))];
  const primaryImage = images[0] || '';
  const signals = Array.isArray(item.curatedSignals) && item.curatedSignals.length ? item.curatedSignals : ['Curated marketplace match'];
  const buyingOptions = Array.isArray(item.buyingOptions) && item.buyingOptions.length ? item.buyingOptions.map(humanize).join(' · ') : 'See listing';
  const seller = item.seller?.username || 'Marketplace seller';
  const feedbackParts = [];
  if (item.seller?.feedbackPercentage != null) feedbackParts.push(`${item.seller.feedbackPercentage}% positive`);
  if (item.seller?.feedbackScore != null) feedbackParts.push(`${Number(item.seller.feedbackScore).toLocaleString()} feedback`);
  const sellerFeedback = feedbackParts.join(' · ');
  const condition = item.condition || 'See listing';
  const outbound = item.affiliateUrl || item.itemWebUrl || '#';
  const score = Math.round(Number(item.curatedScore || 0));
  const aspects = Array.isArray(item.aspects) ? item.aspects.slice(0, 30) : [];
  const shipping = Array.isArray(item.shippingOptions) ? item.shippingOptions : [];
  const availability = Array.isArray(item.estimatedAvailabilities) ? item.estimatedAvailabilities[0] : null;
  const returnTerms = item.returnTerms || null;
  const description = item.shortDescription || item.conditionDescription || '';
  const originalPrice = item.marketingPrice?.originalPrice;
  const discount = item.marketingPrice?.discountPercentage;
  const availabilityLabel = availability?.status ? humanize(availability.status) : '';
  const quantityLabel = availability?.quantity != null ? `${availability.quantity} estimated available` : '';
  const returnsLabel = returnTerms?.returnsAccepted === true
    ? `Returns accepted${returnTerms.returnPeriod?.value ? ` · ${returnTerms.returnPeriod.value} ${String(returnTerms.returnPeriod.unit || 'day').toLowerCase()}${Number(returnTerms.returnPeriod.value) === 1 ? '' : 's'}` : ''}`
    : returnTerms?.returnsAccepted === false ? 'Seller does not accept returns' : '';

  return `
    <div class="detail-shell">
      <div class="detail-top">
        <div class="detail-gallery">
          <div class="detail-main-media">
            ${primaryImage ? `<img id="detail-main-image" src="${safe(primaryImage)}" alt="${safe(item.title)}" referrerpolicy="no-referrer" />` : '<div class="detail-image-empty">No listing image</div>'}
          </div>
          ${images.length > 1 ? `<div class="detail-thumbs" aria-label="Listing photos">${images.map((image, index) => `<button type="button" class="detail-thumb${index === 0 ? ' active' : ''}" data-gallery-src="${safe(image)}" aria-label="View listing photo ${index + 1}"><img src="${safe(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></button>`).join('')}</div>` : ''}
          <p class="detail-photo-note">Listing imagery shown uncropped so you can inspect more of the asset.</p>
        </div>

        <div class="detail-info">
          <p class="eyebrow">${safe((item.curatedLane || 'CURATED DISCOVERY').toUpperCase())}</p>
          <h3>${safe(item.title || 'Marketplace discovery')}</h3>
          ${item.subtitle ? `<p class="detail-subtitle">${safe(item.subtitle)}</p>` : ''}
          <div class="detail-price-row">
            <div class="detail-price">${safe(money(item.price))}</div>
            ${originalPrice ? `<div class="detail-original-price">${safe(money(originalPrice))}${discount != null ? ` · ${safe(discount)}% off` : ''}</div>` : ''}
          </div>

          <div class="detail-signal-chips">${signals.map(signal => `<span>${safe(signal)}</span>`).join('')}</div>

          <div class="detail-list">
            <div><small>Curated score</small><strong>${safe(score || '—')} / 100</strong></div>
            <div><small>Condition</small><strong>${safe(condition)}</strong></div>
            <div><small>Buying format</small><strong>${safe(buyingOptions)}</strong></div>
            <div><small>Location</small><strong>${safe(itemLocation(item))}</strong></div>
            <div><small>Seller</small><strong>${safe(seller)}</strong>${sellerFeedback ? `<span>${safe(sellerFeedback)}</span>` : ''}</div>
            <div><small>Availability</small><strong>${safe(availabilityLabel || quantityLabel || 'Check listing')}</strong>${availabilityLabel && quantityLabel ? `<span>${safe(quantityLabel)}</span>` : ''}</div>
          </div>

          ${loading ? '<div class="detail-load-state">Loading full listing specifications…</div>' : ''}
          ${detailError ? `<div class="detail-load-state warning">Full specifications could not be loaded. Summary details are still available.</div>` : ''}
          <a class="detail-ebay" href="${safe(outbound)}" target="_blank" rel="noopener sponsored">Inspect original listing →</a>
        </div>
      </div>

      <div class="detail-extra">
        ${description ? `<section class="detail-section"><p class="detail-section-kicker">ABOUT THIS LISTING</p><h4>Listing summary</h4><p class="detail-description">${safe(description)}</p></section>` : ''}

        <section class="detail-section detail-facts-section">
          <p class="detail-section-kicker">MARKETPLACE DATA</p>
          <h4>Asset details</h4>
          <div class="detail-facts">
            ${item.brand ? `<div><small>Brand</small><strong>${safe(item.brand)}</strong></div>` : ''}
            ${item.mpn ? `<div><small>MPN / Part no.</small><strong>${safe(item.mpn)}</strong></div>` : ''}
            ${item.gtin ? `<div><small>GTIN</small><strong>${safe(item.gtin)}</strong></div>` : ''}
            ${item.categoryPath ? `<div><small>Category</small><strong>${safe(item.categoryPath)}</strong></div>` : ''}
            ${item.itemEndDate ? `<div><small>Listing ends</small><strong>${safe(dateText(item.itemEndDate))}</strong></div>` : ''}
            ${returnsLabel ? `<div><small>Returns</small><strong>${safe(returnsLabel)}</strong></div>` : ''}
            ${item.topRatedBuyingExperience === true ? '<div><small>Marketplace signal</small><strong>Top-rated buying experience</strong></div>' : ''}
            ${item.id ? `<div><small>Listing ID</small><strong>${safe(item.id)}</strong></div>` : ''}
          </div>
        </section>

        ${aspects.length ? `<section class="detail-section"><p class="detail-section-kicker">SPECIFICATIONS</p><h4>Item specifics</h4><div class="detail-spec-grid">${aspects.map(aspect => `<div><small>${safe(aspect.name)}</small><strong>${safe(aspect.value)}</strong></div>`).join('')}</div></section>` : ''}

        ${shipping.length ? `<section class="detail-section"><p class="detail-section-kicker">DELIVERY</p><h4>Shipping options</h4><div class="detail-shipping">${shipping.map(renderShipping).join('')}</div></section>` : ''}
      </div>
    </div>`;
}

function bindDetailGallery() {
  const mainImage = document.querySelector('#detail-main-image');
  if (!mainImage) return;
  document.querySelectorAll('[data-gallery-src]').forEach((button) => {
    button.addEventListener('click', () => {
      mainImage.src = button.dataset.gallerySrc;
      document.querySelectorAll('.detail-thumb').forEach(thumb => thumb.classList.remove('active'));
      button.classList.add('active');
    });
  });
}

async function openDetail(item) {
  if (!item) return;
  const requestId = ++state.detailRequest;
  els.dialogContent.innerHTML = renderDetail(item, { loading: true });
  if (!els.dialog.open) els.dialog.showModal();
  bindDetailGallery();

  if (!item.id) return;
  try {
    const payload = await request(`/api/commerce/curated/item/${encodeURIComponent(item.id)}`, { retries: 1, timeoutMs: 24000 });
    if (requestId !== state.detailRequest || !els.dialog.open) return;
    const detailed = { ...item, ...(payload.item || {}) };
    state.items.set(String(item.id), detailed);
    els.dialogContent.innerHTML = renderDetail(detailed);
    bindDetailGallery();
  } catch (error) {
    if (requestId !== state.detailRequest || !els.dialog.open) return;
    console.warn('CuratedTrading listing detail request failed', error);
    els.dialogContent.innerHTML = renderDetail(item, { detailError: error.message || 'detail request failed' });
    bindDetailGallery();
  }
}

function setLoading(on, text = 'Loading curated inventory…') {
  state.loading = on;
  els.message.textContent = text;
  els.refresh.disabled = on;
  els.more.disabled = on;
}

function buildPath({ append = false } = {}) {
  const min = Number(els.minPrice.value || 0);
  if (state.mode === 'featured') {
    return `/api/commerce/curated/featured?min_price=${min}&limit=16`;
  }
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.lane) params.set('lane', state.lane);
  params.set('min_price', String(min));
  params.set('limit', '16');
  params.set('offset', String(append ? state.nextOffset || 0 : 0));
  return `/api/commerce/curated/search?${params.toString()}`;
}

async function loadMarket({ append = false } = {}) {
  if (state.loading) return;
  setLoading(true, append ? 'Loading more discoveries…' : 'Scanning marketplace inventory…');
  if (!append) {
    state.offset = 0;
    state.nextOffset = null;
    state.hasMore = false;
    state.items.clear();
  }
  try {
    const payload = await request(buildPath({ append }), { retries: 2, timeoutMs: 30000 });
    const items = Array.isArray(payload.items) ? payload.items : [];
    const html = items.map(renderCard).join('');
    if (append) els.grid.insertAdjacentHTML('beforeend', html);
    else els.grid.innerHTML = html;
    state.nextOffset = payload.nextOffset ?? null;
    state.hasMore = Boolean(payload.hasMore && payload.nextOffset != null);
    els.more.hidden = !state.hasMore;
    const sourceTotal = payload.sourceTotal != null ? ` from ${Number(payload.sourceTotal).toLocaleString()} source matches` : '';
    els.message.textContent = items.length ? `${items.length}${append ? ' more' : ''} curated discoveries${sourceTotal}.` : 'No clean matches at this threshold. Try a lower minimum value or another lane.';
    setApiState('live', `${payload.environment || 'live'} marketplace`);
  } catch (error) {
    if (!append) els.grid.innerHTML = '';
    els.more.hidden = true;
    els.message.textContent = 'Marketplace connection interrupted. Tap Refresh to reconnect to live inventory.';
    setApiState('down', 'marketplace reconnecting');
    console.warn('CuratedTrading marketplace request failed', error);
  } finally {
    state.loading = false;
    els.refresh.disabled = false;
    els.more.disabled = false;
  }
}

function runQuery(query) {
  state.mode = 'search';
  state.query = query.trim();
  state.lane = '';
  els.query.value = state.query;
  els.title.textContent = state.query ? `Curated results: ${state.query}` : 'Curated marketplace discoveries';
  document.querySelector('#market').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadMarket();
}

function runLane(lane, label) {
  state.mode = 'search';
  state.query = '';
  state.lane = lane;
  els.query.value = '';
  els.title.textContent = label || 'Curated lane';
  document.querySelector('#market').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadMarket();
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  runQuery(els.query.value);
});

document.querySelectorAll('.quick-links [data-query]').forEach((button) => {
  button.addEventListener('click', () => runQuery(button.dataset.query || ''));
});

document.querySelectorAll('.lane-card[data-lane]').forEach((button) => {
  button.addEventListener('click', () => runLane(button.dataset.lane, button.querySelector('strong')?.textContent));
});

els.grid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-detail-id]');
  if (!button) return;
  openDetail(state.items.get(button.dataset.detailId));
});

els.refresh.addEventListener('click', () => loadMarket());
els.minPrice.addEventListener('change', () => loadMarket());
els.more.addEventListener('click', () => loadMarket({ append: true }));
els.dialogClose.addEventListener('click', () => {
  state.detailRequest += 1;
  els.dialog.close();
});
els.dialog.addEventListener('click', (event) => {
  if (event.target === els.dialog) {
    state.detailRequest += 1;
    els.dialog.close();
  }
});

window.addEventListener('online', () => {
  if (!state.loading && els.grid.children.length === 0) loadMarket();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !state.loading && els.grid.children.length === 0) {
    loadMarket();
  }
});

(async function boot() {
  console.info(`CuratedTrading storefront ${APP_VERSION}`);
  await Promise.allSettled([
    checkHealth(),
    loadMarket()
  ]);
})();