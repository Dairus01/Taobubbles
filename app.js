/* ============================================================
   TAObubbles — app.js
   Bittensor subnet token bubble visualization
   ============================================================ */

'use strict';

// ─── Constants ───────────────────────────────────────────────
const API_URL = '/api/subnets';
const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const RAO = 1e9; // rao → TAO conversion
const THEME_STORAGE_KEY = 'taobubbles-theme';

// Bubble physics
const GRAVITY_STRENGTH = 0.04;    // pull toward center (CSS pixels/frame²)
const DAMPING = 0.92;             // velocity decay per frame — higher = settles faster
const COLLISION_RESPONSE = 0.4;   // elasticity of collisions
const MIN_RADIUS = 14;            // CSS pixels
const MAX_RADIUS = 120;           // CSS pixels

// Color thresholds (%)
const COLOR_THRESHOLDS = [
  { min: 10,   color: '#00e676', glow: 'rgba(0,230,118,0.35)' },
  { min: 3,    color: '#4caf50', glow: 'rgba(76,175,80,0.3)' },
  { min: 0,    color: '#81c784', glow: 'rgba(129,199,132,0.25)' },
  { min: -3,   color: '#e57373', glow: 'rgba(229,115,115,0.25)' },
  { min: -10,  color: '#f44336', glow: 'rgba(244,67,54,0.3)' },
  { min: -Infinity, color: '#b71c1c', glow: 'rgba(183,28,28,0.35)' },
];

// ─── State ───────────────────────────────────────────────────
let subnets = [];       // normalized subnet objects
let bubbles = [];       // bubble physics objects
let activePeriod = 'day';
let activeSizeMetric = 'market_cap';
let tableSortCol = 'rank';
let tableSortAsc = true;
let animFrameId = null;
let refreshTimer = null;
let isDragging = false;
let dragBubble = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let mouseVX = 0;
let mouseVY = 0;
let popupOpen = false;
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let isTap = false;
let controlsInitialized = false;
let canvasInteractionsInitialized = false;
let refreshFailures = 0;
let activeFetchController = null;
let previousFocusedElement = null;
const subnetLogoCache = new Map();

// ─── DOM refs ────────────────────────────────────────────────
const canvas = document.getElementById('bubbleCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const errorOverlay = document.getElementById('errorOverlay');
const errorText = document.getElementById('errorText');
const retryBtn = document.getElementById('retryBtn');
const subnetCount = document.getElementById('subnetCount');
const refreshDot = document.getElementById('refreshDot');
const refreshLabel = document.getElementById('refreshLabel');
const timePeriodGroup = document.getElementById('timePeriodGroup');
const sizeMetricGroup = document.getElementById('sizeMetricGroup');
const popupBackdrop = document.getElementById('popupBackdrop');
const popupClose = document.getElementById('popupClose');
const tableBody = document.getElementById('tableBody');
const dataTable = document.getElementById('dataTable');
const headerEl = document.getElementById('header');
const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeToggleIcon = document.getElementById('themeToggleIcon');
const themeToggleLabel = document.getElementById('themeToggleLabel');

const REQUIRED_ELEMENTS = [
  ['bubbleCanvas', canvas],
  ['loadingOverlay', loadingOverlay],
  ['loadingText', loadingText],
  ['errorOverlay', errorOverlay],
  ['errorText', errorText],
  ['retryBtn', retryBtn],
  ['subnetCount', subnetCount],
  ['refreshDot', refreshDot],
  ['refreshLabel', refreshLabel],
  ['timePeriodGroup', timePeriodGroup],
  ['sizeMetricGroup', sizeMetricGroup],
  ['popupBackdrop', popupBackdrop],
  ['popupClose', popupClose],
  ['tableBody', tableBody],
  ['dataTable', dataTable],
  ['header', headerEl],
  ['themeToggleBtn', themeToggleBtn],
  ['themeToggleIcon', themeToggleIcon],
  ['themeToggleLabel', themeToggleLabel],
];

// Tooltip
const tooltip = document.createElement('div');
tooltip.className = 'bubble-tooltip hidden';
document.body.appendChild(tooltip);

// ─── Utility ─────────────────────────────────────────────────
function formatTAO(rao) {
  const tao = toFiniteNumber(rao, 0) / RAO;
  if (!Number.isFinite(tao)) return '—';
  if (tao >= 1e6) return (tao / 1e6).toFixed(2) + 'M τ';
  if (tao >= 1e3) return (tao / 1e3).toFixed(2) + 'K τ';
  return tao.toFixed(2) + ' τ';
}

function formatPrice(price) {
  const p = toFiniteNumber(price, 0);
  if (!Number.isFinite(p)) return '—';
  if (p === 0) return '0';
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  return p.toFixed(8);
}

function formatPct(val) {
  const n = toFiniteNumber(val, NaN);
  if (isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function pctClass(val) {
  const n = Number(val);
  if (n > 0) return 'change-pos';
  if (n < 0) return 'change-neg';
  return 'change-zero';
}

function tdPctClass(val) {
  const n = Number(val);
  if (n > 0) return 'td-pos';
  if (n < 0) return 'td-neg';
  return 'td-zero';
}

function getColor(pct) {
  const n = toFiniteNumber(pct, 0);
  for (const t of COLOR_THRESHOLDS) {
    if (n >= t.min) return t;
  }
  return COLOR_THRESHOLDS[COLOR_THRESHOLDS.length - 1];
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function assertRequiredDom() {
  const missing = REQUIRED_ELEMENTS.filter(([, el]) => !el).map(([id]) => id);
  if (!ctx) missing.push('bubbleCanvas.getContext("2d")');
  if (missing.length > 0) {
    throw new Error(`Missing required DOM element(s): ${missing.join(', ')}`);
  }
}

function normalizeTimestamp(value) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n > 1e12 ? n : n * 1000;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePricePoint(point) {
  if (!point || typeof point !== 'object') return null;

  const price = toFiniteNumber(point.price, NaN);
  const timestamp = normalizeTimestamp(point.timestamp);
  if (!Number.isFinite(price) || timestamp === null) return null;

  return { price, timestamp };
}

function safeExternalUrl(rawUrl, options = {}) {
  if (typeof rawUrl !== 'string') return null;

  let input = rawUrl.trim();
  if (!input) return null;

  if (options.discordInvite && !/^https?:\/\//i.test(input)) {
    input = `https://discord.gg/${input.replace(/^\/+/, '')}`;
  }

  try {
    const normalized = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(normalized);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function compareValues(a, b, asc = true) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;

  if (typeof a === 'string' && typeof b === 'string') {
    const result = a.localeCompare(b);
    return asc ? result : -result;
  }

  const an = Number(a);
  const bn = Number(b);
  const av = Number.isFinite(an) ? an : 0;
  const bv = Number.isFinite(bn) ? bn : 0;
  if (av < bv) return asc ? -1 : 1;
  if (av > bv) return asc ? 1 : -1;
  return 0;
}

function drawRoundedRect(context, x, y, width, height, radius) {
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius);
    return;
  }

  const r = Math.min(radius, width / 2, height / 2);
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
}

function getSubnetLogoCandidates(subnet) {
  const netuid = toFiniteNumber(subnet.netuid, NaN);
  const candidates = [];

  if (Number.isFinite(netuid)) {
    candidates.push(`/logos/${netuid}.jpg`);
    candidates.push(`/logos/${netuid}.png`);
    candidates.push(`/logos/${netuid}.webp`);
  }

  // Static local fallback for any subnet without a netuid-specific logo.
  candidates.push('/logos/tao.jpg');

  return [...new Set(candidates)];
}

function getSubnetLogo(subnet) {
  const key = String(subnet.netuid);
  const existing = subnetLogoCache.get(key);
  if (existing) {
    return existing.status === 'loaded' ? existing.image : null;
  }

  const entry = {
    status: 'loading',
    image: null,
    candidates: getSubnetLogoCandidates(subnet),
    index: 0,
  };
  subnetLogoCache.set(key, entry);

  const tryNext = () => {
    if (entry.index >= entry.candidates.length) {
      entry.status = 'failed';
      return;
    }

    const src = entry.candidates[entry.index++];
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      entry.status = 'loaded';
      entry.image = img;
    };
    img.onerror = () => {
      tryNext();
    };
    img.src = src;
  };

  tryNext();
  return null;
}

function drawBubbleLogo(context, image, x, y, radius) {
  if (!image || !image.naturalWidth || !image.naturalHeight) return;

  const drawRadius = radius * 0.74;
  const drawSize = drawRadius * 2;
  const imgAspect = image.naturalWidth / image.naturalHeight;
  let srcW = image.naturalWidth;
  let srcH = image.naturalHeight;
  let srcX = 0;
  let srcY = 0;

  if (imgAspect > 1) {
    srcH = image.naturalHeight;
    srcW = srcH;
    srcX = (image.naturalWidth - srcW) / 2;
  } else if (imgAspect < 1) {
    srcW = image.naturalWidth;
    srcH = srcW;
    srcY = (image.naturalHeight - srcH) / 2;
  }

  context.save();
  context.beginPath();
  context.arc(x, y, drawRadius, 0, Math.PI * 2);
  context.closePath();
  context.clip();
  context.drawImage(
    image,
    srcX,
    srcY,
    srcW,
    srcH,
    x - drawRadius,
    y - drawRadius,
    drawSize,
    drawSize
  );
  context.restore();
}

function drawBubbleLabelBackground(context, x, y, text, fontSize, alpha = 0.58) {
  const metrics = context.measureText(text);
  const textWidth = metrics.width;
  const padX = Math.max(4, fontSize * 0.45);
  const padY = Math.max(2, fontSize * 0.32);
  const width = textWidth + padX * 2;
  const height = fontSize + padY * 2;
  const left = x - width / 2;
  const top = y - height / 2;
  const radius = Math.max(4, height * 0.42);

  context.beginPath();
  drawRoundedRect(context, left, top, width, height, radius);
  context.fillStyle = `rgba(7, 9, 18, ${alpha})`;
  context.fill();
}

function drawBubbleText(context, text, x, y, options = {}) {
  const fontSize = toFiniteNumber(options.fontSize, 12);
  const fontWeight = options.fontWeight || 700;
  const fillStyle = options.fillStyle || 'rgba(255,255,255,0.98)';
  const strokeStyle = options.strokeStyle || 'rgba(0,0,0,0.9)';
  const withBadge = Boolean(options.withBadge);

  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `${fontWeight} ${fontSize}px Inter, sans-serif`;
  context.lineJoin = 'round';
  context.lineCap = 'round';

  if (withBadge) {
    drawBubbleLabelBackground(context, x, y, text, fontSize, options.badgeAlpha ?? 0.58);
  }

  context.strokeStyle = strokeStyle;
  context.lineWidth = Math.max(1.6, fontSize * 0.22);
  context.strokeText(text, x, y);
  context.fillStyle = fillStyle;
  context.fillText(text, x, y);
  context.restore();
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getSavedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', normalized);

  if (themeToggleIcon) {
    themeToggleIcon.textContent = normalized === 'light' ? '🌙' : '☀';
  }
  if (themeToggleLabel) {
    themeToggleLabel.textContent = normalized === 'light' ? 'Dark' : 'Light';
  }
  if (themeToggleBtn) {
    themeToggleBtn.setAttribute('aria-label', normalized === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  }
}

function initTheme() {
  const saved = getSavedTheme();
  applyTheme(saved || getSystemTheme());
}

function getThemeChartPalette() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue('--bg-soft').trim() || '#0d0d18',
    grid: styles.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.05)',
    label: styles.getPropertyValue('--chart-label').trim() || 'rgba(136,136,153,0.65)',
    crosshair: styles.getPropertyValue('--chart-crosshair').trim() || 'rgba(255,255,255,0.25)',
    pillBackground: styles.getPropertyValue('--chart-pill-bg').trim() || 'rgba(20,20,35,0.92)',
  };
}

function isMobileViewport() {
  return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
}

function syncHeaderHeight() {
  if (!headerEl) return;
  const h = Math.max(56, Math.round(headerEl.getBoundingClientRect().height));
  document.documentElement.style.setProperty('--header-h', `${h}px`);
}

// ─── Data Fetching & Normalization ───────────────────────────
async function fetchSubnets() {
  setFetching(true);

  if (activeFetchController) {
    activeFetchController.abort();
  }

  const controller = new AbortController();
  activeFetchController = controller;
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = Array.isArray(json.data) ? json.data : [];

    // Normalize — exclude netuid 0 (Root/TAO itself — would dwarf all others)
    subnets = raw
      .filter(s => toFiniteNumber(s.netuid, 0) !== 0)
      .map(s => ({
        netuid: toFiniteNumber(s.netuid, 0),
        name: s.name || `Subnet ${s.netuid}`,
        symbol: s.symbol || '?',
        description: s.description || s.subnet_description || '',
        rank: toFiniteNumber(s.rank, 999),
        price: toFiniteNumber(s.price, 0),
        market_cap: toFiniteNumber(s.market_cap, 0),
        volume: toFiniteNumber(s.tao_volume_24_hr, 0),
        liquidity: toFiniteNumber(s.liquidity, 0),
        emission: toFiniteNumber(s.emission, 0),
        projected_emission: toFiniteNumber(s.projected_emission, 0),
        active_keys: toFiniteNumber(s.active_keys, 0),
        max_neurons: toFiniteNumber(s.max_neurons, 0),
        highest_price_24hr: toFiniteNumber(s.highest_price_24_hr, 0),
        lowest_price_24hr: toFiniteNumber(s.lowest_price_24_hr, 0),
        price_change_hour: toFiniteNumber(s.price_change_1_hour, 0),
        price_change_day: toFiniteNumber(s.price_change_1_day, 0),
        price_change_week: toFiniteNumber(s.price_change_1_week, 0),
        price_change_month: toFiniteNumber(s.price_change_1_month, 0),
        fear_greed_index: s.fear_and_greed_index != null ? toFiniteNumber(s.fear_and_greed_index, null) : null,
        fear_greed_sentiment: s.fear_and_greed_sentiment || null,
        github: s.github || '',
        discord: s.discord_url || '',
        website: s.subnet_url || '',
        seven_day_prices: Array.isArray(s.seven_day_prices)
          ? s.seven_day_prices.map(normalizePricePoint).filter(Boolean)
          : [],
        startup_mode: s.startup_mode || false,
      }));

    refreshFailures = 0;
    subnetCount.textContent = `${subnets.length} subnets`;
    hideError();
    return true;
  } catch (err) {
    refreshFailures += 1;
    if (err.name === 'AbortError') {
      showError(`Failed to load data: request timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`);
    } else {
      showError(`Failed to load data: ${err.message}`);
    }
    return false;
  } finally {
    window.clearTimeout(timeout);
    if (activeFetchController === controller) {
      activeFetchController = null;
    }
    setFetching(false);
  }
}

function setFetching(on) {
  if (on) {
    refreshDot.classList.add('fetching');
    refreshLabel.textContent = 'Loading…';
  } else {
    refreshDot.classList.remove('fetching');
    refreshLabel.textContent = 'Live';
  }
}

function showError(msg) {
  if (!errorText || !errorOverlay || !loadingOverlay) return;
  errorText.textContent = msg;
  errorOverlay.classList.remove('hidden');
  loadingOverlay.classList.add('hidden');
}

function hideError() {
  if (!errorOverlay) return;
  errorOverlay.classList.add('hidden');
}

// ─── Canvas logical dimensions (CSS pixels, NOT physical pixels) ─
// All physics and drawing use these — DPR is only applied via ctx.scale
let W = 0;  // logical canvas width
let H = 0;  // logical canvas height

// ─── Bubble Creation & Sizing ─────────────────────────────────
function getMetricValue(subnet) {
  return activeSizeMetric === 'volume' ? subnet.volume : subnet.market_cap;
}

function getPeriodChange(subnet) {
  switch (activePeriod) {
    case 'hour':  return subnet.price_change_hour;
    case 'week':  return subnet.price_change_week;
    case 'month': return subnet.price_change_month;
    default:      return subnet.price_change_day;
  }
}

function computeRadii() {
  const values = subnets.map(s => getMetricValue(s));
  const positiveVals = values.filter(v => v > 0);
  if (positiveVals.length === 0) return subnets.map(() => MIN_RADIUS);

  const maxVal = Math.max(...positiveVals);

  // Scale so that the total area of all bubbles fills ~55% of the canvas area.
  // Area of a circle = π*r². We want Σ(π*r²) ≈ 0.55 * W * H
  // r_i = scale * sqrt(v_i), so Σ(π * scale² * v_i) = 0.55 * W * H
  // => scale = sqrt(0.55 * W * H / (π * Σv_i))
  const totalVal = positiveVals.reduce((a, b) => a + b, 0);
  const targetArea = 0.55 * W * H;
  let scale = Math.sqrt(targetArea / (Math.PI * totalVal));

  // Clamp individual radii to [MIN_RADIUS, MAX_RADIUS]
  // Then re-check and re-scale if needed
  const rawRadii = values.map(v => v > 0 ? scale * Math.sqrt(v) : 0);
  const rawMax = Math.max(...rawRadii);

  if (rawMax > MAX_RADIUS) {
    scale *= MAX_RADIUS / rawMax;
  }

  return values.map(v => {
    if (v <= 0) return MIN_RADIUS;
    const r = scale * Math.sqrt(v);
    return clamp(r, MIN_RADIUS, MAX_RADIUS);
  });
}

function initBubbles() {
  const radii = computeRadii();

  // Spread bubbles across the full canvas in a grid-like pattern
  // then let physics settle them naturally
  const cols = Math.ceil(Math.sqrt(subnets.length * (W / H)));
  const rows = Math.ceil(subnets.length / cols);
  const cellW = W / cols;
  const cellH = H / rows;

  bubbles = subnets.map((subnet, i) => {
    getSubnetLogo(subnet);
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Place at cell center with small random jitter
    const x = cellW * (col + 0.5) + (Math.random() - 0.5) * cellW * 0.4;
    const y = cellH * (row + 0.5) + (Math.random() - 0.5) * cellH * 0.4;
    return {
      subnet,
      x: clamp(x, radii[i], W - radii[i]),
      y: clamp(y, radii[i], H - radii[i]),
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      radius: radii[i],
      targetRadius: radii[i],
    };
  });
}

function updateBubbleSizes() {
  const radii = computeRadii();
  bubbles.forEach((b, i) => {
    b.targetRadius = radii[i];
  });
}

// ─── Physics Loop ─────────────────────────────────────────────
function physicsStep() {
  const cx = W / 2;
  const cy = H / 2;

  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (b === dragBubble) continue;

    // Lerp radius toward target
    b.radius += (b.targetRadius - b.radius) * 0.06;

    // Weak gravity toward center — keeps bubbles from drifting to edges
    const dx = cx - b.x;
    const dy = cy - b.y;
    const distToCenter = Math.sqrt(dx * dx + dy * dy);
    // Only pull if far from center, proportional to distance
    if (distToCenter > 1) {
      b.vx += (dx / distToCenter) * GRAVITY_STRENGTH;
      b.vy += (dy / distToCenter) * GRAVITY_STRENGTH;
    }

    // Damping
    b.vx *= DAMPING;
    b.vy *= DAMPING;

    // Update position
    b.x += b.vx;
    b.y += b.vy;

    // Hard wall clamp — no bounce, just stop at edge
    if (b.x - b.radius < 0) { b.x = b.radius; b.vx *= -0.3; }
    if (b.x + b.radius > W) { b.x = W - b.radius; b.vx *= -0.3; }
    if (b.y - b.radius < 0) { b.y = b.radius; b.vy *= -0.3; }
    if (b.y + b.radius > H) { b.y = H - b.radius; b.vy *= -0.3; }
  }

  // Collision detection & resolution (O(n²) — fine for ~128 bubbles)
  for (let i = 0; i < bubbles.length; i++) {
    for (let j = i + 1; j < bubbles.length; j++) {
      const a = bubbles[i];
      const b = bubbles[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distSq = dx * dx + dy * dy;
      const minDist = a.radius + b.radius + 1;

      if (distSq < minDist * minDist && distSq > 0.1) {
        const dist = Math.sqrt(distSq);
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;

        // Push apart proportionally — heavier (bigger) bubbles move less
        const totalR = a.radius + b.radius;
        const wa = b.radius / totalR;  // a moves by b's proportion
        const wb = a.radius / totalR;  // b moves by a's proportion

        if (a !== dragBubble) { a.x -= nx * overlap * wa; a.y -= ny * overlap * wa; }
        if (b !== dragBubble) { b.x += nx * overlap * wb; b.y += ny * overlap * wb; }

        // Velocity exchange
        const relVx = b.vx - a.vx;
        const relVy = b.vy - a.vy;
        const dot = relVx * nx + relVy * ny;

        if (dot < 0) {
          const impulse = dot * COLLISION_RESPONSE;
          if (a !== dragBubble) { a.vx += impulse * nx * wa * 2; a.vy += impulse * ny * wa * 2; }
          if (b !== dragBubble) { b.vx -= impulse * nx * wb * 2; b.vy -= impulse * ny * wb * 2; }
        }
      }
    }
  }
}

// ─── Drawing ──────────────────────────────────────────────────
function drawBubbles() {
  ctx.clearRect(0, 0, W, H);

  for (const b of bubbles) {
    const pct = getPeriodChange(b.subnet);
    const { color, glow } = getColor(pct);
    const r = b.radius;
    const logo = getSubnetLogo(b.subnet);

    ctx.save();

    // Glow
    ctx.shadowColor = glow;
    ctx.shadowBlur = r * 0.5;

    // Radial gradient fill
    const grad = ctx.createRadialGradient(
      b.x - r * 0.3, b.y - r * 0.3, r * 0.05,
      b.x, b.y, r
    );
    grad.addColorStop(0, lightenColor(color, 0.35));
    grad.addColorStop(0.6, color);
    grad.addColorStop(1, darkenColor(color, 0.45));

    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle border
    ctx.shadowBlur = 0;
    ctx.strokeStyle = lightenColor(color, 0.2);
    ctx.lineWidth = 1;
    ctx.stroke();

    if (logo) {
      drawBubbleLogo(ctx, logo, b.x, b.y - (r >= 38 ? r * 0.08 : 0), r);
      if (r >= 34) {
        const vignette = ctx.createRadialGradient(b.x, b.y, r * 0.25, b.x, b.y, r);
        vignette.addColorStop(0, 'rgba(0,0,0,0)');
        vignette.addColorStop(1, 'rgba(0,0,0,0.25)');
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fillStyle = vignette;
        ctx.fill();
      }
    }

    ctx.restore();

    // Text — only draw if bubble is large enough to be readable
    if (r >= 14) {
      if (r >= 38) {
        // Large bubble: logo (if available) + name + pct stacked
        if (!logo) {
          const symbolSize = clamp(r * 0.32, 11, 22);
          drawBubbleText(ctx, b.subnet.symbol, b.x, b.y - r * 0.25, {
            fontSize: symbolSize,
            fontWeight: 700,
            withBadge: false,
          });
        }

        const nameSize = clamp(r * 0.18, 8, 12);
        drawBubbleText(ctx, truncate(b.subnet.name, r < 55 ? 7 : 12), b.x, b.y + (logo ? r * 0.22 : r * 0.05), {
          fontSize: nameSize,
          fontWeight: 600,
          fillStyle: 'rgba(255,255,255,0.93)',
          withBadge: logo,
          badgeAlpha: 0.52,
        });

        const pctSize = clamp(r * 0.2, 9, 13);
        drawBubbleText(ctx, formatPct(pct), b.x, b.y + r * 0.33, {
          fontSize: pctSize,
          fontWeight: 700,
          withBadge: logo,
          badgeAlpha: 0.62,
        });
      } else if (r >= 22) {
        // Medium bubble: logo (if available) or symbol + pct
        if (!logo) {
          const symbolSize = clamp(r * 0.35, 10, 16);
          drawBubbleText(ctx, b.subnet.symbol, b.x, b.y - r * 0.15, {
            fontSize: symbolSize,
            fontWeight: 700,
            withBadge: false,
          });
        }

        const pctSize = clamp(r * 0.25, 8, 11);
        drawBubbleText(ctx, formatPct(pct), b.x, b.y + (logo ? r * 0.46 : r * 0.28), {
          fontSize: pctSize,
          fontWeight: 700,
          fillStyle: 'rgba(255,255,255,0.95)',
          withBadge: logo,
          badgeAlpha: 0.66,
        });
      } else {
        // Small bubble: prefer logo, fallback to symbol
        if (!logo) {
          const symbolSize = clamp(r * 0.55, 8, 13);
          drawBubbleText(ctx, b.subnet.symbol, b.x, b.y, {
            fontSize: symbolSize,
            fontWeight: 700,
            withBadge: false,
          });
        }
      }
    }
  }
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function lightenColor(hex, amount) {
  return adjustColor(hex, amount);
}

function darkenColor(hex, amount) {
  return adjustColor(hex, -amount);
}

function adjustColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = clamp(((num >> 16) & 0xff) + Math.round(255 * amount), 0, 255);
  const g = clamp(((num >> 8) & 0xff) + Math.round(255 * amount), 0, 255);
  const b = clamp((num & 0xff) + Math.round(255 * amount), 0, 255);
  return `rgb(${r},${g},${b})`;
}

// ─── Animation Loop ───────────────────────────────────────────
function animate() {
  physicsStep();
  drawBubbles();
  animFrameId = requestAnimationFrame(animate);
}

function startAnimation() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  animate();
}

// ─── Canvas Resize ────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();

  // Logical (CSS) dimensions — used for ALL physics and drawing
  W = rect.width;
  H = rect.height;

  // Physical dimensions — only for the canvas backing store
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  // Scale ctx so that 1 unit = 1 CSS pixel everywhere
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (bubbles.length > 0) {
    updateBubbleSizes();
    for (const b of bubbles) {
      b.x = clamp(b.x, b.radius, W - b.radius);
      b.y = clamp(b.y, b.radius, H - b.radius);
    }
  }
}

// ─── Controls ─────────────────────────────────────────────────
function setupControls() {
  if (controlsInitialized) return;
  controlsInitialized = true;

  // Time period
  timePeriodGroup.addEventListener('click', e => {
    const btn = e.target.closest('[data-period]');
    if (!btn) return;
    activePeriod = btn.dataset.period;
    timePeriodGroup.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Update table sort hint
    dataTable.querySelectorAll('th.active-sort').forEach(th => th.classList.remove('active-sort'));
    const periodColMap = { hour: 'hour', day: 'day', week: 'week', month: 'month' };
    const th = dataTable.querySelector(`th[data-col="${periodColMap[activePeriod]}"]`);
    if (th) th.classList.add('active-sort');
    renderTable();
  });

  // Size metric
  sizeMetricGroup.addEventListener('click', e => {
    const btn = e.target.closest('[data-size]');
    if (!btn) return;
    activeSizeMetric = btn.dataset.size;
    sizeMetricGroup.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateBubbleSizes();
  });

  // Retry button
  retryBtn.addEventListener('click', () => {
    errorOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    init().catch(err => {
      showError(`Initialization failed: ${err.message}`);
    });
  });

  // Popup close
  popupClose.addEventListener('click', closePopup);
  popupBackdrop.addEventListener('click', e => {
    if (e.target === popupBackdrop) closePopup();
  });

  // Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePopup();
  });

  // Table sorting
  dataTable.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (tableSortCol === col) {
        tableSortAsc = !tableSortAsc;
      } else {
        tableSortCol = col;
        tableSortAsc = col === 'rank' || col === 'name' || col === 'symbol';
      }
      dataTable.querySelectorAll('th').forEach(t => {
        t.classList.remove('active-sort', 'asc');
      });
      th.classList.add('active-sort');
      if (tableSortAsc) th.classList.add('asc');
      renderTable();
    });
  });

  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage failures; theme still applies for this session.
    }
  });
}

function setupCanvasInteractions() {
  if (canvasInteractionsInitialized) return;
  canvasInteractionsInitialized = true;

  // Mouse events
  canvas.addEventListener('mousedown', e => {
    const { x, y } = getCanvasPos(e.clientX, e.clientY);
    const b = getBubbleAt(x, y);
    if (b) {
      isDragging = true;
      dragBubble = b;
      dragOffsetX = b.x - x;
      dragOffsetY = b.y - y;
      b.vx = 0;
      b.vy = 0;
      canvas.style.cursor = 'grabbing';
    }
    lastMouseX = x;
    lastMouseY = y;
    mouseVX = 0;
    mouseVY = 0;
  });

  canvas.addEventListener('mousemove', e => {
    const { x, y } = getCanvasPos(e.clientX, e.clientY);
    mouseVX = x - lastMouseX;
    mouseVY = y - lastMouseY;
    lastMouseX = x;
    lastMouseY = y;

    if (isDragging && dragBubble) {
      dragBubble.x = x + dragOffsetX;
      dragBubble.y = y + dragOffsetY;
    } else {
      const b = getBubbleAt(x, y);
      if (b) {
        showTooltip(b, e.clientX, e.clientY);
        canvas.style.cursor = 'pointer';
      } else {
        hideTooltip();
        canvas.style.cursor = 'grab';
      }
    }
  });

  canvas.addEventListener('mouseup', e => {
    const { x, y } = getCanvasPos(e.clientX, e.clientY);
    if (isDragging && dragBubble) {
      dragBubble.vx = mouseVX * 0.8;
      dragBubble.vy = mouseVY * 0.8;
      const wasDragged = Math.abs(dragBubble.x - (x + dragOffsetX)) > 5 ||
                         Math.abs(dragBubble.y - (y + dragOffsetY)) > 5;
      if (!wasDragged) {
        openPopup(dragBubble.subnet);
      }
      dragBubble = null;
      isDragging = false;
      canvas.style.cursor = 'grab';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    hideTooltip();
    if (isDragging && dragBubble) {
      dragBubble.vx = mouseVX * 0.8;
      dragBubble.vy = mouseVY * 0.8;
      dragBubble = null;
      isDragging = false;
    }
  });

  // Click (for non-drag clicks)
  canvas.addEventListener('click', e => {
    if (isDragging) return;
    const { x, y } = getCanvasPos(e.clientX, e.clientY);
    const b = getBubbleAt(x, y);
    if (b) openPopup(b.subnet);
  });

  // Touch events
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const touch = e.touches[0];
    const { x, y } = getCanvasPos(touch.clientX, touch.clientY);
    touchStartX = x;
    touchStartY = y;
    touchStartTime = Date.now();
    isTap = true;

    const b = getBubbleAt(x, y);
    if (b) {
      isDragging = true;
      dragBubble = b;
      dragOffsetX = b.x - x;
      dragOffsetY = b.y - y;
      b.vx = 0;
      b.vy = 0;
    }
    lastMouseX = x;
    lastMouseY = y;
    mouseVX = 0;
    mouseVY = 0;
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touch = e.touches[0];
    const { x, y } = getCanvasPos(touch.clientX, touch.clientY);
    mouseVX = x - lastMouseX;
    mouseVY = y - lastMouseY;
    lastMouseX = x;
    lastMouseY = y;

    const moved = Math.abs(x - touchStartX) > 8 || Math.abs(y - touchStartY) > 8;
    if (moved) isTap = false;

    if (isDragging && dragBubble) {
      dragBubble.x = x + dragOffsetX;
      dragBubble.y = y + dragOffsetY;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    const elapsed = Date.now() - touchStartTime;

    if (isDragging && dragBubble) {
      dragBubble.vx = mouseVX * 0.8;
      dragBubble.vy = mouseVY * 0.8;

      if (isTap && elapsed < 300) {
        openPopup(dragBubble.subnet);
      }

      dragBubble = null;
      isDragging = false;
    }
  }, { passive: false });
}

// ─── Mouse / Touch Interaction ────────────────────────────────
function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function getBubbleAt(x, y) {
  // Iterate in reverse so topmost (last drawn) is hit first
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const dx = x - b.x;
    const dy = y - b.y;
    if (dx * dx + dy * dy <= b.radius * b.radius) return b;
  }
  return null;
}

// ─── Tooltip ──────────────────────────────────────────────────
function showTooltip(b, clientX, clientY) {
  const pct = getPeriodChange(b.subnet);
  const sign = pct > 0 ? '+' : '';
  tooltip.textContent = `${b.subnet.name} (${b.subnet.symbol})  ${sign}${Number(pct).toFixed(2)}%`;
  tooltip.style.left = clientX + 'px';
  tooltip.style.top = clientY + 'px';
  tooltip.classList.remove('hidden');
}

function hideTooltip() {
  tooltip.classList.add('hidden');
}

// ─── Popup ────────────────────────────────────────────────────
function openPopup(subnet) {
  popupOpen = true;
  hideTooltip();

  // Header
  document.getElementById('popupSymbol').textContent = subnet.symbol;
  document.getElementById('popupTitle').textContent = subnet.name;
  document.getElementById('popupNetuid').textContent = `netuid ${subnet.netuid}`;
  document.getElementById('popupDescription').textContent = subnet.description || '';

  // External links
  const linksEl = document.getElementById('popupLinks');
  if (!linksEl) return;
  linksEl.innerHTML = '';

  const addLink = (href, label, svgPath) => {
    const safeHref = safeExternalUrl(href);
    if (!safeHref) return;
    const a = document.createElement('a');
    a.className = 'popup-link-btn';
    a.href = safeHref;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor">${svgPath}</svg>${label}`;
    linksEl.appendChild(a);
  };

  // taostats always present
  addLink(
    `https://taostats.io/subnets/${subnet.netuid}`,
    'taostats',
    '<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM7.25 5v3.5H5l3 3 3-3H8.75V5h-1.5z"/>'
  );

  if (subnet.website) addLink(
    subnet.website,
    'Website',
    '<path d="M8 1a7 7 0 100 14A7 7 0 008 1zm5.47 6.5h-2.01a10.7 10.7 0 00-.87-3.93A5.52 5.52 0 0113.47 7.5zm-7.97 0H3.53a5.52 5.52 0 012.88-3.93A10.7 10.7 0 005.5 7.5zm0 1h2v4.47A5.52 5.52 0 013.53 8.5H5.5zm3 0h1.97a5.52 5.52 0 01-2.88 4.47L8.5 8.5zm0-1V4.03A5.52 5.52 0 0111.47 7.5H8.5zm-1 0H5.53A5.52 5.52 0 018.5 4.03V7.5H7.5z"/>'
  );

  if (subnet.github) addLink(
    subnet.github,
    'GitHub',
    '<path d="M8 1C4.13 1 1 4.13 1 8c0 3.09 2 5.71 4.79 6.64.35.06.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.81-.78-1.03-.78-1.03-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.62 1.07 1.63.76 2.03.58.06-.45.24-.76.44-.93-1.56-.18-3.2-.78-3.2-3.47 0-.77.27-1.4.72-1.89-.07-.18-.31-.9.07-1.87 0 0 .59-.19 1.93.72A6.7 6.7 0 018 4.84c.6 0 1.2.08 1.76.23 1.34-.91 1.93-.72 1.93-.72.38.97.14 1.69.07 1.87.45.49.72 1.12.72 1.89 0 2.7-1.64 3.29-3.2 3.47.25.22.47.65.47 1.31v1.94c0 .19.13.4.48.34A7.01 7.01 0 0015 8c0-3.87-3.13-7-7-7z"/>'
  );

  if (subnet.discord) addLink(
    safeExternalUrl(subnet.discord, { discordInvite: true }),
    'Discord',
    '<path d="M13.55 3.18A12.6 12.6 0 0010.3 2.2a.05.05 0 00-.05.02c-.14.25-.3.58-.41.84a11.63 11.63 0 00-3.68 0 8.5 8.5 0 00-.42-.84.05.05 0 00-.05-.02 12.56 12.56 0 00-3.25.98.04.04 0 00-.02.02C.92 6.37.4 9.47.6 12.53c0 .02.01.03.03.04a12.67 12.67 0 003.83 1.94.05.05 0 00.05-.02c.3-.4.56-.82.78-1.26a.05.05 0 00-.03-.07 8.34 8.34 0 01-1.19-.57.05.05 0 010-.08l.24-.19a.05.05 0 01.05 0c2.49 1.14 5.19 1.14 7.65 0a.05.05 0 01.05 0l.24.19a.05.05 0 010 .08c-.38.22-.78.42-1.19.57a.05.05 0 00-.03.07c.23.44.49.86.78 1.26a.05.05 0 00.05.02 12.63 12.63 0 003.84-1.94.05.05 0 00.03-.04c.24-3.48-.4-6.5-1.69-9.33a.04.04 0 00-.02-.02zM5.68 10.72c-.79 0-1.44-.73-1.44-1.62s.64-1.62 1.44-1.62c.8 0 1.45.73 1.44 1.62 0 .89-.64 1.62-1.44 1.62zm5.32 0c-.79 0-1.44-.73-1.44-1.62s.64-1.62 1.44-1.62c.8 0 1.45.73 1.44 1.62 0 .89-.63 1.62-1.44 1.62z"/>'
  );

  // Price
  document.getElementById('popupPrice').textContent = formatPrice(subnet.price);

  // Calculator
  const calcInput = document.getElementById('calcInput');
  if (!calcInput) return;
  calcInput.value = '1';
  updateCalc(subnet);
  calcInput.oninput = () => updateCalc(subnet);

  // Stats
  document.getElementById('statMarketCap').textContent = formatTAO(subnet.market_cap);
  document.getElementById('statVolume').textContent = formatTAO(subnet.volume);
  document.getElementById('statLiquidity').textContent = formatTAO(subnet.liquidity);

  const emVal = subnet.emission > 0
    ? (subnet.emission / RAO).toFixed(4) + ' τ'
    : (subnet.projected_emission > 0
        ? '~' + Number(subnet.projected_emission).toFixed(4) + ' τ'
        : '—');
  document.getElementById('statEmission').textContent = emVal;

  document.getElementById('statActiveKeys').textContent =
    `${subnet.active_keys} / ${subnet.max_neurons}`;

  const fgEl = document.getElementById('statFearGreed');
  if (subnet.fear_greed_index !== null) {
    const sent = subnet.fear_greed_sentiment || '';
    fgEl.textContent = `${Number(subnet.fear_greed_index).toFixed(1)} — ${sent}`;
    fgEl.className = 'stat-value ' + fearGreedClass(sent);
  } else {
    fgEl.textContent = '—';
    fgEl.className = 'stat-value fg-neutral';
  }

  // 7-day chart
  drawPopupChart(subnet);

  // % change badges
  const changesEl = document.getElementById('popupChanges');
  changesEl.innerHTML = '';
  const periods = [
    { label: 'Hour', val: subnet.price_change_hour },
    { label: 'Day',  val: subnet.price_change_day },
    { label: 'Week', val: subnet.price_change_week },
    { label: 'Month', val: subnet.price_change_month },
  ];
  periods.forEach(({ label, val }) => {
    const div = document.createElement('div');
    div.className = 'change-badge';
    div.innerHTML = `
      <span class="change-badge-label">${label}</span>
      <span class="change-badge-value ${pctClass(val)}">${formatPct(val)}</span>
    `;
    changesEl.appendChild(div);
  });

  // taostats link
  const taoStatsAnchor = document.getElementById('taoStatsLink');
  const taoStatsHref = safeExternalUrl(`https://taostats.io/subnets/${subnet.netuid}`);
  if (taoStatsAnchor && taoStatsHref) {
    taoStatsAnchor.href = taoStatsHref;
  }

  // Show
  previousFocusedElement = document.activeElement;
  popupBackdrop.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  popupBackdrop.addEventListener('keydown', handlePopupKeydown);
  if (popupClose && typeof popupClose.focus === 'function') {
    popupClose.focus();
  }
}

function updateCalc(subnet) {
  const input = document.getElementById('calcInput');
  if (!input) return;
  let amount = parseFloat(input.value);
  if (!Number.isFinite(amount)) amount = 0;
  amount = clamp(amount, 0, 1e12);
  const result = amount * subnet.price;
  const calcResult = document.getElementById('calcResult');
  if (calcResult) {
    calcResult.textContent = Number.isFinite(result) ? formatPrice(result) : '—';
  }
}

function fearGreedClass(sentiment) {
  const s = (sentiment || '').toLowerCase();
  if (s.includes('extreme greed')) return 'fg-extreme-greed';
  if (s.includes('greed')) return 'fg-greed';
  if (s.includes('extreme fear')) return 'fg-extreme-fear';
  if (s.includes('fear')) return 'fg-fear';
  return 'fg-neutral';
}

function closePopup() {
  popupOpen = false;
  popupBackdrop.classList.add('hidden');
  document.body.style.overflow = '';
  popupBackdrop.removeEventListener('keydown', handlePopupKeydown);
  if (previousFocusedElement && typeof previousFocusedElement.focus === 'function') {
    previousFocusedElement.focus();
  }
}

function handlePopupKeydown(event) {
  if (event.key === 'Escape') {
    closePopup();
    return;
  }

  if (event.key !== 'Tab') return;

  const popup = document.getElementById('popup');
  if (!popup) return;

  const focusable = popup.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ─── Popup Chart (interactive) ────────────────────────────────

// Chart state — kept outside drawPopupChart so event handlers can reference it
let chartState = null;

function drawPopupChart(subnet) {
  try {
  const chartCanvas = document.getElementById('popupChartCanvas');
  if (!chartCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const displayW = chartCanvas.parentElement.clientWidth - 40;
  const displayH = 160;

  chartCanvas.width = Math.round(displayW * dpr);
  chartCanvas.height = Math.round(displayH * dpr);
  chartCanvas.style.width = displayW + 'px';
  chartCanvas.style.height = displayH + 'px';

  const cctx = chartCanvas.getContext('2d');
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const prices = Array.isArray(subnet.seven_day_prices) ? subnet.seven_day_prices : [];
  const palette = getThemeChartPalette();
  if (!prices || prices.length < 2) {
    cctx.fillStyle = palette.background;
    cctx.fillRect(0, 0, displayW, displayH);
    cctx.fillStyle = '#888';
    cctx.font = '12px Inter, sans-serif';
    cctx.textAlign = 'center';
    cctx.fillText('No chart data', displayW / 2, displayH / 2);
    chartState = null;
    return;
  }

  const vals = prices.map(p => toFiniteNumber(p.price, NaN)).filter(Number.isFinite);
  if (vals.length < 2) {
    cctx.fillStyle = palette.background;
    cctx.fillRect(0, 0, displayW, displayH);
    cctx.fillStyle = '#888';
    cctx.font = '12px Inter, sans-serif';
    cctx.textAlign = 'center';
    cctx.fillText('No valid chart data', displayW / 2, displayH / 2);
    chartState = null;
    return;
  }

  const normalizedPrices = prices.filter(p => Number.isFinite(toFiniteNumber(p.price, NaN)) && normalizeTimestamp(p.timestamp) !== null);
  if (normalizedPrices.length < 2) {
    cctx.fillStyle = palette.background;
    cctx.fillRect(0, 0, displayW, displayH);
    cctx.fillStyle = '#888';
    cctx.font = '12px Inter, sans-serif';
    cctx.textAlign = 'center';
    cctx.fillText('No valid chart data', displayW / 2, displayH / 2);
    chartState = null;
    return;
  }

  const cleanVals = normalizedPrices.map(p => toFiniteNumber(p.price, 0));
  const minVal = Math.min(...cleanVals);
  const maxVal = Math.max(...cleanVals);
  const range = maxVal - minVal || maxVal * 0.01 || 0.0001;
  const pad = { top: 18, right: 14, bottom: 22, left: 14 };
  const chartW = displayW - pad.left - pad.right;
  const chartH = displayH - pad.top - pad.bottom;

  const toX = (i) => pad.left + (i / (cleanVals.length - 1)) * chartW;
  const toY = (v) => pad.top + chartH - ((v - minVal) / range) * chartH;

  // Store chart geometry for interactive hit-testing
  chartState = { vals: cleanVals, prices: normalizedPrices, minVal, maxVal, range, pad, chartW, chartH,
                 displayW, displayH, toX, toY, lineColor: null, dpr };

  const isUp = cleanVals[cleanVals.length - 1] >= cleanVals[0];
  const lineColor = isUp ? '#4caf50' : '#f44336';
  const fillColor = isUp ? 'rgba(76,175,80,' : 'rgba(244,67,54,';
  chartState.lineColor = lineColor;
  chartState.canvas = chartCanvas;
  chartState.cctx = cctx;

  renderChartBase(cctx, chartState, fillColor);

  // High/low header
  const hiLoEl = document.getElementById('chartHiLo');
  hiLoEl.innerHTML = `
    <span class="chart-high">▲ ${formatPrice(maxVal)}</span>
    <span class="chart-low">▼ ${formatPrice(minVal)}</span>
  `;

  chartCanvas.onmousemove = onChartMouseMove;
  chartCanvas.onmouseleave = onChartMouseLeave;
  chartCanvas.ontouchmove = onChartTouchMove;
  chartCanvas.ontouchend = onChartMouseLeave;
  } catch (err) {
    const chartCanvas = document.getElementById('popupChartCanvas');
    if (!chartCanvas) return;
    const cctx = chartCanvas.getContext('2d');
    if (!cctx) return;
    const width = chartCanvas.parentElement ? chartCanvas.parentElement.clientWidth - 40 : 300;
    const height = 160;
    cctx.clearRect(0, 0, width, height);
    cctx.fillStyle = getThemeChartPalette().background;
    cctx.fillRect(0, 0, width, height);
    cctx.fillStyle = '#888';
    cctx.font = '12px Inter, sans-serif';
    cctx.textAlign = 'center';
    cctx.fillText('Chart unavailable', width / 2, height / 2);
  }
}

function renderChartBase(cctx, cs, fillColor) {
  const { vals, minVal, maxVal, pad, chartW, chartH, displayW, displayH,
          toX, toY, lineColor, prices } = cs;

  const palette = getThemeChartPalette();

  // Background
  cctx.fillStyle = palette.background;
  cctx.fillRect(0, 0, displayW, displayH);

  // Horizontal grid lines
  cctx.strokeStyle = palette.grid;
  cctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = pad.top + (chartH / 4) * i;
    cctx.beginPath();
    cctx.moveTo(pad.left, y);
    cctx.lineTo(displayW - pad.right, y);
    cctx.stroke();
  }

  // Area fill
  const areaGrad = cctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
  areaGrad.addColorStop(0, (fillColor || 'rgba(76,175,80,') + '0.28)');
  areaGrad.addColorStop(1, (fillColor || 'rgba(76,175,80,') + '0.02)');

  cctx.beginPath();
  cctx.moveTo(toX(0), toY(vals[0]));
  for (let i = 1; i < vals.length; i++) cctx.lineTo(toX(i), toY(vals[i]));
  cctx.lineTo(toX(vals.length - 1), pad.top + chartH);
  cctx.lineTo(toX(0), pad.top + chartH);
  cctx.closePath();
  cctx.fillStyle = areaGrad;
  cctx.fill();

  // Line
  cctx.beginPath();
  cctx.moveTo(toX(0), toY(vals[0]));
  for (let i = 1; i < vals.length; i++) cctx.lineTo(toX(i), toY(vals[i]));
  cctx.strokeStyle = lineColor;
  cctx.lineWidth = 1.8;
  cctx.lineJoin = 'round';
  cctx.stroke();

  // High/low dots
  const maxIdx = vals.indexOf(maxVal);
  const minIdx = vals.indexOf(minVal);
  cctx.beginPath();
  cctx.arc(toX(maxIdx), toY(maxVal), 3.5, 0, Math.PI * 2);
  cctx.fillStyle = '#4caf50';
  cctx.fill();
  cctx.beginPath();
  cctx.arc(toX(minIdx), toY(minVal), 3.5, 0, Math.PI * 2);
  cctx.fillStyle = '#f44336';
  cctx.fill();

  // Date labels
  cctx.fillStyle = palette.label;
  cctx.font = '9px Inter, sans-serif';
  cctx.textAlign = 'left';
  cctx.fillText(formatChartDate(new Date(prices[0].timestamp)), pad.left, displayH - 4);
  cctx.textAlign = 'right';
  cctx.fillText(formatChartDate(new Date(prices[prices.length - 1].timestamp)), displayW - pad.right, displayH - 4);
}

function getChartIndexFromX(clientX) {
  if (!chartState) return -1;
  const rect = chartState.canvas.getBoundingClientRect();
  const relX = clientX - rect.left;
  const { pad, chartW, vals } = chartState;
  if (vals.length < 2 || chartW <= 0) return -1;
  const t = (relX - pad.left) / chartW;
  const idx = Math.round(t * (vals.length - 1));
  return clamp(idx, 0, vals.length - 1);
}

function drawChartCrosshair(idx) {
  if (!chartState) return;
  const { cctx, vals, prices, pad, chartH, displayW, displayH,
          toX, toY, lineColor, dpr } = chartState;
  const fillColor = lineColor === '#4caf50' ? 'rgba(76,175,80,' : 'rgba(244,67,54,';

  const palette = getThemeChartPalette();

  // Redraw base
  renderChartBase(cctx, chartState, fillColor);

  const x = toX(idx);
  const y = toY(vals[idx]);
  const price = vals[idx];
  const ts = new Date(prices[idx].timestamp);
  if (!Number.isFinite(ts.getTime())) return;

  // Vertical crosshair line
  cctx.save();
  cctx.strokeStyle = palette.crosshair;
  cctx.lineWidth = 1;
  cctx.setLineDash([3, 3]);
  cctx.beginPath();
  cctx.moveTo(x, pad.top);
  cctx.lineTo(x, pad.top + chartH);
  cctx.stroke();
  cctx.setLineDash([]);
  cctx.restore();

  // Dot on line
  cctx.beginPath();
  cctx.arc(x, y, 5, 0, Math.PI * 2);
  cctx.fillStyle = lineColor;
  cctx.fill();
  cctx.beginPath();
  cctx.arc(x, y, 3, 0, Math.PI * 2);
  cctx.fillStyle = '#fff';
  cctx.fill();

  // Price label — position left or right depending on which side has more room
  const labelText = formatPrice(price) + ' τ';
  const dateText = formatChartDate(ts) + ' ' + ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  cctx.font = 'bold 11px Inter, sans-serif';
  const labelW = cctx.measureText(labelText).width + 10;
  const onRight = x + labelW + 6 < displayW - pad.right;
  const lx = onRight ? x + 6 : x - labelW - 6;
  const ly = clamp(y - 18, pad.top + 2, pad.top + chartH - 36);

  // Price pill background
  cctx.fillStyle = palette.pillBackground;
  cctx.beginPath();
  drawRoundedRect(cctx, lx - 2, ly, labelW, 18, 4);
  cctx.fill();
  cctx.strokeStyle = lineColor;
  cctx.lineWidth = 1;
  cctx.stroke();

  // Price text
  cctx.fillStyle = '#fff';
  cctx.textAlign = 'left';
  cctx.fillText(labelText, lx + 3, ly + 12);

  // Date below
  cctx.font = '9px Inter, sans-serif';
  cctx.fillStyle = palette.label;
  cctx.fillText(dateText, lx - 2, ly + 30);

  // Update hi/lo header to show hovered price
  const hiLoEl = document.getElementById('chartHiLo');
  if (hiLoEl) {
    hiLoEl.innerHTML = `
      <span style="color:#00d4aa;font-weight:600">${formatPrice(price)} τ</span>
      <span style="color:var(--text-muted);font-size:10px">${formatChartDate(ts)}</span>
    `;
  }
}

function onChartMouseMove(e) {
  const idx = getChartIndexFromX(e.clientX);
  if (idx >= 0) drawChartCrosshair(idx);
}

function onChartTouchMove(e) {
  if (e.touches.length > 0) {
    const idx = getChartIndexFromX(e.touches[0].clientX);
    if (idx >= 0) drawChartCrosshair(idx);
  }
}

function onChartMouseLeave() {
  if (!chartState) return;
  const fillColor = chartState.lineColor === '#4caf50' ? 'rgba(76,175,80,' : 'rgba(244,67,54,';
  renderChartBase(chartState.cctx, chartState, fillColor);
  // Restore hi/lo
  const hiLoEl = document.getElementById('chartHiLo');
  if (hiLoEl) {
    hiLoEl.innerHTML = `
      <span class="chart-high">▲ ${formatPrice(chartState.maxVal)}</span>
      <span class="chart-low">▼ ${formatPrice(chartState.minVal)}</span>
    `;
  }
}

function formatChartDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Data Table ───────────────────────────────────────────────
function renderTable() {
  const tableWrapper = document.querySelector('.table-wrapper');
  const previousScrollLeft = tableWrapper ? tableWrapper.scrollLeft : 0;
  const sorted = [...subnets].sort((a, b) => {
    let aVal, bVal;
    switch (tableSortCol) {
      case 'rank':       aVal = a.rank; bVal = b.rank; break;
      case 'name':       aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase(); break;
      case 'price':      aVal = a.price; bVal = b.price; break;
      case 'market_cap': aVal = a.market_cap; bVal = b.market_cap; break;
      case 'volume':     aVal = a.volume; bVal = b.volume; break;
      case 'hour':       aVal = a.price_change_hour; bVal = b.price_change_hour; break;
      case 'day':        aVal = a.price_change_day; bVal = b.price_change_day; break;
      case 'week':       aVal = a.price_change_week; bVal = b.price_change_week; break;
      case 'month':      aVal = a.price_change_month; bVal = b.price_change_month; break;
      default:           aVal = a.rank; bVal = b.rank;
    }
    return compareValues(aVal, bVal, tableSortAsc);
  });

  tableBody.innerHTML = '';
  sorted.forEach((subnet) => {
    const tr = document.createElement('tr');

    const rankCell = `<td class="td-rank col-rank">${subnet.rank}</td>`;

    const nameCell = `
      <td class="td-name-cell td-left col-name">
        <span class="td-glyph">${escHtml(subnet.symbol)}</span>
        <span class="td-name-text">${escHtml(subnet.name)}</span>
        <span class="td-netuid-badge">SN${subnet.netuid}</span>
      </td>`;

    const priceCell = `<td class="td-num col-price">${formatPrice(subnet.price)} <span class="td-unit">τ</span></td>`;
    const mcCell = `<td class="td-num col-market-cap">${formatTAO(subnet.market_cap)}</td>`;
    const volCell = `<td class="td-num col-volume">${formatTAO(subnet.volume)}</td>`;

    const pctCell = (val, colClass) => {
      const n = Number(val);
      const cls = n > 0 ? 'pct-pos' : n < 0 ? 'pct-neg' : 'pct-zero';
      return `<td class="td-pct ${colClass}"><span class="pct-badge ${cls}">${formatPct(val)}</span></td>`;
    };

    // Links cell
    const links = [];
    const taostatsHref = safeExternalUrl(`https://taostats.io/subnets/${subnet.netuid}`);
    const websiteHref = safeExternalUrl(subnet.website);
    const githubHref = safeExternalUrl(subnet.github);

    if (taostatsHref) links.push(`<a class="tbl-link" href="${escHtml(taostatsHref)}" target="_blank" rel="noopener noreferrer" title="taostats.io">
      <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 4.5v7M5 8h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
    </a>`);
    if (websiteHref) links.push(`<a class="tbl-link" href="${escHtml(websiteHref)}" target="_blank" rel="noopener noreferrer" title="Website">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6"/><path d="M8 2C6 4 5 6 5 8s1 4 3 6M8 2c2 2 3 4 3 6s-1 4-3 6M2 8h12"/></svg>
    </a>`);
    if (githubHref) links.push(`<a class="tbl-link" href="${escHtml(githubHref)}" target="_blank" rel="noopener noreferrer" title="GitHub">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1C4.13 1 1 4.13 1 8c0 3.09 2 5.71 4.79 6.64.35.06.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.81-.78-1.03-.78-1.03-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.62 1.07 1.63.76 2.03.58.06-.45.24-.76.44-.93-1.56-.18-3.2-.78-3.2-3.47 0-.77.27-1.4.72-1.89-.07-.18-.31-.9.07-1.87 0 0 .59-.19 1.93.72A6.7 6.7 0 018 4.84c.6 0 1.2.08 1.76.23 1.34-.91 1.93-.72 1.93-.72.38.97.14 1.69.07 1.87.45.49.72 1.12.72 1.89 0 2.7-1.64 3.29-3.2 3.47.25.22.47.65.47 1.31v1.94c0 .19.13.4.48.34A7.01 7.01 0 0015 8c0-3.87-3.13-7-7-7z"/></svg>
    </a>`);
    const linksCell = `<td class="td-links td-left col-links">${links.join('')}</td>`;

    tr.innerHTML = rankCell + nameCell + priceCell + mcCell + volCell +
      pctCell(subnet.price_change_hour, 'col-hour') + pctCell(subnet.price_change_day, 'col-day') +
      pctCell(subnet.price_change_week, 'col-week') + pctCell(subnet.price_change_month, 'col-month') +
      linksCell;

    // Click row (but not link clicks) opens popup
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      openPopup(subnet);
    });
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPopup(subnet);
      }
    });
    tableBody.appendChild(tr);
  });

  if (tableWrapper) {
    tableWrapper.scrollLeft = isMobileViewport() ? 0 : previousScrollLeft;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Auto-Refresh ─────────────────────────────────────────────
function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const intervalMs = Math.round(REFRESH_INTERVAL_MS * Math.min(4, Math.max(1, 1 + refreshFailures * 0.5)));
  refreshTimer = setInterval(async () => {
    const ok = await fetchSubnets();
    if (ok) {
      updateBubbleSizes();
      renderTable();
    }
  }, intervalMs);
}

// ─── Init ─────────────────────────────────────────────────────
async function init() {
  assertRequiredDom();
  initTheme();
  loadingOverlay.classList.remove('hidden');
  loadingText.textContent = 'Fetching subnet data…';

  const ok = await fetchSubnets();
  if (!ok) return;

  loadingText.textContent = 'Initializing bubbles…';

  syncHeaderHeight();
  resizeCanvas();
  initBubbles();
  setupControls();
  setupCanvasInteractions();
  renderTable();
  startAnimation();

  loadingOverlay.classList.add('hidden');
  scheduleRefresh();
}

// Resize handler
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    const oldW = W;
    const oldH = H;
    syncHeaderHeight();
    resizeCanvas();
    if (bubbles.length === 0) return;
    // If canvas size changed significantly, re-spread bubbles
    if (Math.abs(W - oldW) > 50 || Math.abs(H - oldH) > 50) {
      const scaleX = W / (oldW || W);
      const scaleY = H / (oldH || H);
      for (const b of bubbles) {
        b.x = clamp(b.x * scaleX, b.radius, W - b.radius);
        b.y = clamp(b.y * scaleY, b.radius, H - b.radius);
      }
    }
    updateBubbleSizes();
  }, 150);
});

// Kick off
init().catch(err => {
  showError(`Initialization failed: ${err.message}`);
});
