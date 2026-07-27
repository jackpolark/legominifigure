/* ============================================================
   LEGO MINIFIG BUILDER — Application Logic v5
   ============================================================

   KEY CHANGES IN v5
   ──────────────────
   1. Offline catalog (see catalog.js)
      Part metadata (part_num/name/category) for all 4 slots now
      loads instantly from an IndexedDB snapshot of Rebrickable's
      daily CSV dump — no rate limit, no "0 parts" flash. Photos
      are the only thing that still needs the API, so they stream
      in progressively (skeleton → photo) instead of gating the
      whole category. See seedFromCatalog() / state.usingCatalog.

   2. Prioritized image queue
      A single shared queue (imageQueue) keeps the 1 req/sec API
      limiter busy with whatever the user can actually see first:
      the current selection > the default view's likely prefix
      (e.g. "3626" for standard heads) > a full background sweep
      of the rest of the category. See startImageLoading() /
      prioritizeImage().

   3. Instant local search
      In catalog mode, typing filters+ranks the in-memory metadata
      directly (searchScore()) with no network round-trip; a
      targeted API call then backfills photos for the matches.
      Categories without an offline snapshot (CORS/old browser)
      fall back to the original live-API search.

   4. Live reconciliation
      Every 15 min while the tab is visible, and whenever a photo
      page is fetched, part_nums are diffed against the offline
      snapshot — anything new gets folded in and badged "NEW"
      instead of waiting for the next full catalog refresh.

   ─── Carried over from v4 ───
   • ensureMinimumVisible() / startBackgroundLoad() — legacy paging
     fallback for any category the offline catalog couldn't cover.
   • Searchable theme combo (search all themes incl. retired).
   • Collapsible variant chips (show 10, "••• N more" to expand).
   ============================================================ */

// ──── Config ──────────────────────────────────────────────────────────────────
const API_BASE      = "https://legominifigure-rebrickable-proxy.jackpolark.workers.dev";
const PAGE_SIZE     = 100;
const THEME_MAX_SETS = 20;
const VARIANT_SHOW  = 10;   // chips shown before "show more"
const MIN_VISIBLE   = 20;   // minimum parts per slot before background kicks in
const MIN_EXTRA_PAGES = 8;  // max extra pages to fetch for minimum-visible guarantee

const PART_TYPES = [
  { key: "hair",  catId: 65, label: "Headwear", icon: "👒" },
  { key: "head",  catId: 59, label: "Head",     icon: "🙂" },
  { key: "torso", catId: 60, label: "Torso",    icon: "👕" },
  { key: "legs",  catId: 61, label: "Legs",     icon: "👖" },
];

const MULTIWORD_PRIMARIES = ["Santa Hat", "Top Hat"];

const STANDARD_PREFIXES = {
  hair: null, head: "3626", torso: "973", legs: "970",
};

// The part shown on first load, per slot, before the user picks anything
// themselves. Applied whenever the part becomes available (catalog seed,
// legacy fetch, or a later catalog upgrade) as long as the user hasn't
// already made an explicit selection — see state.userSelected.
const DEFAULT_PART_NUMS = {
  hair:  "30167",         // Headgear Hat, Wide Brim Flat
  head:  "3626pa3",       // Head — thin eyebrows/moustache/hair/sideburns print
  torso: "973pb0391c01",  // Safari Shirt torso assembly
  legs:  "970c00",        // Hips and Legs Plain
};

const SUBCATEGORIES = {
  hair: [
    { label: "Hair",    test: p => /^hair$/i.test(p._p.primary) },
    { label: "Helmet",  test: p => /^helmet$/i.test(p._p.primary) },
    { label: "Hat",     test: p => /^(hat|cap|santa hat|top hat)$/i.test(p._p.primary) },
    { label: "Mask",    test: p => /^mask$/i.test(p._p.primary) },
    { label: "Hood",    test: p => /^hood$/i.test(p._p.primary) },
    { label: "Crown",   test: p => /^crown$/i.test(p._p.primary) },
    { label: "Costume", test: p => /^costume$/i.test(p._p.primary) },
    { label: "Other",   test: () => true },
  ],
  head: [
    { label: "Standard",     test: p => p.part_num.startsWith("3626") },
    { label: "Head Special", test: p => /head special/i.test(p.name) },
    { label: "Minidoll",     test: p => /minidoll/i.test(p.name) },
    { label: "Other",        test: () => true },
  ],
  torso: [
    { label: "Standard",  test: p => /^973/.test(p.part_num) && /^torso/i.test(p.name) },
    { label: "Minidoll",  test: p => /minidoll/i.test(p.name) },
    { label: "Other",     test: () => true },
  ],
  legs: [
    { label: "Legs",     test: p => /hips and legs/i.test(p.name) },
    { label: "Skirt",    test: p => /skirt/i.test(p.name) },
    { label: "Minidoll", test: p => /minidoll/i.test(p.name) },
    { label: "Other",    test: () => true },
  ],
};

// Known current/popular themes by name — shown in the combo default list.
// Search will also include every theme returned by the API (incl. retired).
const CURRENT_THEME_NAMES = new Set([
  "Animal Crossing", "Architecture", "Art", "Avatar", "Batman",
  "Botanical Collection", "City", "Classic", "Creator 3 in 1",
  "DC Comics Super Heroes", "Disney", "Dots", "Dreamzzz", "Duplo",
  "Friends", "Harry Potter", "Icons", "Ideas", "Jurassic World",
  "Marvel Super Heroes", "Minecraft", "Minions", "Monkie Kid",
  "Ninjago", "Speed Champions", "Star Wars", "Super Mario",
  "Technic", "The Lord of the Rings", "Trolls",
]);


// ──── LocalStorage Cache ──────────────────────────────────────────────────────
const CACHE_VERSION = 4;
const CACHE_TTL     = 12 * 60 * 60 * 1000;

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(`lmb_${key}`);
    if (!raw) return null;
    const { v, t, d } = JSON.parse(raw);
    if (v !== CACHE_VERSION || Date.now() - t > CACHE_TTL) {
      localStorage.removeItem(`lmb_${key}`); return null;
    }
    return d;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(`lmb_${key}`, JSON.stringify({ v: CACHE_VERSION, t: Date.now(), d: data }));
  } catch {
    for (const k of Object.keys(localStorage)) { if (k.startsWith("lmb_")) localStorage.removeItem(k); }
    try { localStorage.setItem(`lmb_${key}`, JSON.stringify({ v: CACHE_VERSION, t: Date.now(), d: data })); } catch {}
  }
}


// ──── Parsers ─────────────────────────────────────────────────────────────────
function parsePartNum(num) {
  const m = num.match(/^(.+?)(pr\d+|pat\d+|c\d+)$/i);
  if (!m) return { baseId: num, variantType: null, variantSuffix: null };
  return {
    baseId: m[1],
    variantType: m[2].match(/^(pr|pat|c)/i)?.[1]?.toLowerCase() ?? null,
    variantSuffix: m[2],
  };
}

function parseName(rawName) {
  let s = rawName.trim();
  let decoration = null;
  if (/\[plain\]$/i.test(s))     { decoration = "Plain";   s = s.replace(/\s*\[plain\]$/i, "").trim(); }
  else if (/ prints?$/i.test(s)) { decoration = "Print";   s = s.replace(/ prints?$/i, "").trim(); }
  else if (/ patterns?$/i.test(s)){ decoration = "Pattern"; s = s.replace(/ patterns?$/i, "").trim(); }

  const withIdx = s.toLowerCase().indexOf(" with ");
  const baseDesc = withIdx !== -1 ? s.slice(0, withIdx).trim() : s;
  const featStr  = withIdx !== -1 ? s.slice(withIdx + 6).trim() : "";
  const tokens   = baseDesc.split(/,\s*/);
  let primaryRaw = tokens[0].trim().replace(/^Minifig\s+/i, "");
  const descriptors = tokens.slice(1).map(t => t.trim()).filter(Boolean);

  let primaryType, fusion = [];
  const andM   = primaryRaw.match(/^(.+?)\s+and\s+(.+)$/i);
  const slashM = primaryRaw.match(/^(.+?)\s*\/\s*(.+)$/);
  if (andM)        { primaryType = andM[1].trim();   fusion = [andM[2].trim()]; }
  else if (slashM) { primaryType = slashM[1].trim(); fusion = [slashM[2].trim()]; }
  else {
    const multi = MULTIWORD_PRIMARIES.find(t => primaryRaw.toLowerCase().startsWith(t.toLowerCase()));
    primaryType = multi ?? primaryRaw.split(/\s+/)[0];
  }
  return { primary: primaryType, fusion, descriptors, features: featStr ? featStr.split(/,\s*/) : [], decoration };
}

function annotatePart(part) {
  if (!part._n) part._n = parsePartNum(part.part_num);
  if (!part._p) part._p = parseName(part.name);
  return part;
}

function getSubcategoryLabel(partKey, part) {
  for (const r of (SUBCATEGORIES[partKey] ?? []).filter(r => r.label !== "Other")) {
    if (r.test(part)) return r.label;
  }
  return "Other";
}

function isStandardPart(partKey, part) {
  const prefix = STANDARD_PREFIXES[partKey];
  return !prefix || part.part_num.startsWith(prefix);
}


// ──── State ───────────────────────────────────────────────────────────────────
const state = {
  parts:           { hair: [], head: [], torso: [], legs: [] },
  groups:          { hair: {}, head: {}, torso: {}, legs: {} },
  selected:        { hair: null, head: null, torso: null, legs: null },
  nextUrl:         { hair: null, head: null, torso: null, legs: null },
  loading:         { hair: false, head: false, torso: false, legs: false },
  bgLoading:       { hair: false, head: false, torso: false, legs: false },
  search:          { hair: "", head: "", torso: "", legs: "" },
  subcat:          { hair: "All", head: "Standard", torso: "Standard", legs: "Legs" },
  standardOnly:    true,

  allThemes:       [],  // full list from API
  themeId:         { hair: null, head: null, torso: null, legs: null },
  themeParts:      { hair: {}, head: {}, torso: {}, legs: {} },
  themeLoading:    { hair: false, head: false, torso: false, legs: false },
  themeName:       { hair: "", head: "", torso: "", legs: "" },

  // Variant chip expand state per slot
  variantExpanded: { hair: false, head: false, torso: false, legs: false },

  // Offline-catalog mode: metadata for the whole category is already known
  // (from catalog.js), only photos stream in progressively.
  usingCatalog:    { hair: false, head: false, torso: false, legs: false },
  imageSweepDone:  { hair: false, head: false, torso: false, legs: false },

  // True once the user has explicitly picked a part for that slot (thumb
  // click, nav arrows, variant chip, randomize) — blocks DEFAULT_PART_NUMS
  // from overriding their choice on a later catalog upgrade.
  userSelected:    { hair: false, head: false, torso: false, legs: false },
};

const searchTimers = {};
// Track which theme combo dropdown is open (partKey | null)
let openComboKey = null;


// ──── Rate Limiter ────────────────────────────────────────────────────────────
const rateLimiter = (() => {
  let last = 0;
  return async () => {
    const wait = Math.max(0, 1100 - (Date.now() - last));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
})();

async function apiFetch(url, retries = 0) {
  await rateLimiter();
  const res = await fetch(url);
  if (res.status === 429) {
    const backoff = Math.min(8000, 1500 * (retries + 1));
    console.warn(`⏳ Rate limited – retrying in ${backoff}ms…`);
    await new Promise(r => setTimeout(r, backoff));
    return apiFetch(url, retries + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}


// ──── Fetch Parts ─────────────────────────────────────────────────────────────
async function fetchParts(partKey, search = "", append = false, url = null) {
  const type = PART_TYPES.find(t => t.key === partKey);
  if (!type) return;

  state.loading[partKey] = true;
  if (!append) updateLoadingUI(partKey);

  try {
    const fetchUrl = url ||
      `${API_BASE}/api/v3/lego/parts/?part_cat_id=${type.catId}&page_size=${PAGE_SIZE}&inc_color_details=0` +
      (search ? `&search=${encodeURIComponent(search)}` : "");

    const data    = await apiFetch(fetchUrl);
    const results = (data.results ?? []).filter(p => p.part_img_url).map(annotatePart);

    if (append) {
      state.parts[partKey].push(...results);
    } else {
      state.parts[partKey] = results;
    }

    rebuildGroups(partKey);
    state.nextUrl[partKey] = data.next;

    if (!append) {
      if (search) {
        // Explicit search — show what was searched for, not the pinned default.
        state.userSelected[partKey] = true;
        const visible = getVisibleParts(partKey);
        state.selected[partKey] = visible[0] ?? null;
      } else {
        ensureSelection(partKey);
      }
    }
  } catch (err) {
    console.error(`Error fetching ${partKey}:`, err);
  } finally {
    state.loading[partKey] = false;
    renderSelector(partKey);
    renderPreview(); renderSummary(); checkCompatibility();
  }
}

function rebuildGroups(partKey) {
  state.groups[partKey] = {};
  for (const p of state.parts[partKey]) {
    const bid = p._n.baseId;
    if (!state.groups[partKey][bid]) state.groups[partKey][bid] = [];
    state.groups[partKey][bid].push(p);
  }
}


// ──── Ensure Minimum Visible ──────────────────────────────────────────────────
// If the active subcategory filter yields fewer than MIN_VISIBLE parts and
// more pages exist, keep fetching until we reach MIN_VISIBLE or run out.
// Called right after each initial fetch so the UI never shows an empty slot.
async function ensureMinimumVisible(partKey) {
  if (state.search[partKey]) return;      // user is searching — don't interfere
  if (state.themeId[partKey] !== null) return; // theme mode handles its own loading

  let extra = 0;
  while (
    getVisibleParts(partKey).length < MIN_VISIBLE &&
    state.nextUrl[partKey] &&
    extra < MIN_EXTRA_PAGES
  ) {
    await fetchParts(partKey, "", true, state.nextUrl[partKey]);
    extra++;
  }
}


// ──── Background Eager Loading ────────────────────────────────────────────────
async function startBackgroundLoad(partKey) {
  if (state.bgLoading[partKey]) return;
  state.bgLoading[partKey] = true;
  const type = PART_TYPES.find(t => t.key === partKey);

  try {
    while (state.nextUrl[partKey]) {
      if (state.search[partKey]) break;   // abort if user is searching
      await fetchParts(partKey, "", true, state.nextUrl[partKey]);
    }

    // Cache full list once complete
    if (!state.search[partKey] && !state.nextUrl[partKey]) {
      const toCache = state.parts[partKey].map(p => ({
        part_num: p.part_num, name: p.name,
        part_img_url: p.part_img_url, part_cat_id: p.part_cat_id,
      }));
      cacheSet(`parts_${type.catId}`, toCache);
    }
  } finally {
    state.bgLoading[partKey] = false;
    renderCountLabel(partKey);
  }
}

function renderCountLabel(partKey) {
  const countEl = document.getElementById(`count-${partKey}`);
  if (!countEl) return;
  const themeId  = state.themeId[partKey];
  const allParts = themeId !== null ? (state.themeParts[partKey][themeId] ?? []) : state.parts[partKey];
  const visible  = getVisibleParts(partKey).length;
  const hasMore  = !!state.nextUrl[partKey];
  const bg       = state.bgLoading[partKey];
  const loadingPhotos = state.usingCatalog[partKey] && !state.imageSweepDone[partKey];
  const suffix   = hasMore || bg ? "…" : loadingPhotos ? " (loading photos…)" : "";
  const filtered = state.subcat[partKey] !== "All" || state.standardOnly || themeId !== null;
  countEl.textContent = filtered
    ? `${visible} / ${allParts.length}${suffix} parts`
    : `${allParts.length}${suffix} parts`;
}


// If the user hasn't explicitly chosen a part for this slot yet and its
// DEFAULT_PART_NUMS pick is present in state.parts, select it. Returns
// whether it applied, so callers can skip their own fallback selection.
function applyDefaultIfUnselected(partKey) {
  if (state.userSelected[partKey]) return false;
  const wanted = DEFAULT_PART_NUMS[partKey];
  if (!wanted) return false;
  const match = state.parts[partKey].find(p => p.part_num === wanted);
  if (!match) return false;
  state.selected[partKey] = match;
  return true;
}

// True while this slot is showing its DEFAULT_PART_NUMS pick and the user
// hasn't acted on it yet. While pinned, background processes must not swap
// the selection to something else — see ensureSelection().
function isPinnedDefault(partKey) {
  return !state.userSelected[partKey] &&
    state.selected[partKey]?.part_num === DEFAULT_PART_NUMS[partKey];
}

// Called by every automatic (non-user-driven) code path that rebuilds
// state.parts[partKey] and needs to (re)establish a selection: initial live
// fetch, catalog seed, catalog upgrade, incremental reconciliation. If a
// selection already exists — the pinned default, or a part the user
// explicitly picked before this rebuild ran — it's kept as-is, re-adding it
// to the parts list if the rebuild happened to drop it, instead of falling
// back to whatever ends up first in the new list.
function ensureSelection(partKey) {
  const cur = state.selected[partKey];
  if (cur && (isPinnedDefault(partKey) || state.userSelected[partKey])) {
    if (!state.parts[partKey].some(p => p.part_num === cur.part_num)) {
      state.parts[partKey] = [cur, ...state.parts[partKey]];
      rebuildGroups(partKey);
    }
    return;
  }
  if (applyDefaultIfUnselected(partKey)) return;
  const visible = getVisibleParts(partKey);
  state.selected[partKey] = visible[0] ?? null;
}

// Fetches this build's default part for each slot directly by part_num —
// independent of whatever page/category-listing order the live API or
// offline catalog happens to load in, and immune to a part being filed
// under a category-id we don't otherwise fetch. Dispatched first thing in
// init() so these 4 requests are first in the shared apiFetch rate-limiter
// queue; each renders as soon as it resolves rather than waiting for the
// others.
async function loadDefaultParts() {
  await Promise.all(PART_TYPES.map(async type => {
    const num = DEFAULT_PART_NUMS[type.key];
    if (!num) return;
    try {
      const data = await apiFetch(`${API_BASE}/api/v3/lego/parts/${encodeURIComponent(num)}/?inc_color_details=0`);
      if (!data?.part_num) return;

      let part = state.parts[type.key].find(p => p.part_num === data.part_num);
      if (!part) {
        part = annotatePart(data);
        state.parts[type.key] = [part, ...state.parts[type.key]];
        rebuildGroups(type.key);
      }
      if (state.userSelected[type.key]) return;

      state.selected[type.key] = part;
      if (state.usingCatalog[type.key]) prioritizeImage(type.key, part);
      renderSelector(type.key);
      renderPreview(); renderSummary(); checkCompatibility();
    } catch (e) {
      console.warn(`Could not load default part for ${type.key} (${num}):`, e);
    }
  }));
}

// ──── Offline Catalog Integration ──────────────────────────────────────────────
// Seed a category straight from the offline metadata snapshot (instant, no
// network) and kick off progressive, prioritized photo loading for it.
function seedFromCatalog(partKey, catParts) {
  state.usingCatalog[partKey] = true;
  state.parts[partKey] = catParts.map(p => annotatePart({
    ...p, part_img_url: Catalog.getImage(p.part_num) ?? null,
  }));
  rebuildGroups(partKey);
  state.nextUrl[partKey] = null; // metadata is already complete; only photos stream in

  ensureSelection(partKey);
  if (state.selected[partKey]) prioritizeImage(partKey, state.selected[partKey]);
  renderSelector(partKey);
  renderPreview(); renderSummary(); checkCompatibility();
}

// Called when catalog.js learns about new part_nums, either from a periodic
// CSV re-download or from reconciling a live API response.
function handleCatalogUpdate(partKey, info) {
  if (!info?.added?.length) return;
  // First time this category's offline snapshot becomes available (e.g. it
  // was still downloading at startup and we started on the live-API
  // fallback in the meantime) — switch it over instead of just appending.
  if (!state.usingCatalog[partKey]) { upgradeToCatalog(partKey, Catalog.getParts(partKey)); return; }

  const known = new Set(state.parts[partKey].map(p => p.part_num));
  let changed = false;
  for (const entry of info.added) {
    if (known.has(entry.part_num)) continue;
    known.add(entry.part_num);
    state.parts[partKey].push(annotatePart({
      ...entry, part_img_url: Catalog.getImage(entry.part_num) ?? null,
    }));
    changed = true;
  }
  if (changed) {
    rebuildGroups(partKey);
    ensureSelection(partKey);
    if (state.selected[partKey]) prioritizeImage(partKey, state.selected[partKey]);
    renderSelector(partKey);
    renderCountLabel(partKey);
  }
}

// Switch a category from the live-API fallback over to the offline catalog
// once its snapshot arrives, without discarding whatever the user was
// already looking at — see ensureSelection().
function upgradeToCatalog(partKey, catParts) {
  if (state.usingCatalog[partKey] || !catParts?.length) return;
  const existingByNum = new Map(state.parts[partKey].map(p => [p.part_num, p]));
  state.parts[partKey] = catParts.map(p => existingByNum.get(p.part_num) ?? annotatePart({
    ...p, part_img_url: Catalog.getImage(p.part_num) ?? null,
  }));
  state.usingCatalog[partKey] = true;
  state.nextUrl[partKey] = null;
  state.bgLoading[partKey] = false;
  rebuildGroups(partKey);

  ensureSelection(partKey);
  if (state.selected[partKey]) prioritizeImage(partKey, state.selected[partKey]);
  renderSelector(partKey);
  renderPreview(); renderSummary(); checkCompatibility();
  startImageLoading(partKey);
}


// ──── Prioritized Image Loading (catalog mode) ─────────────────────────────────
// A single shared queue (still gated by the 1 req/sec rateLimiter used by
// apiFetch) so "fill what the user can see right now" requests always jump
// ahead of the slow, exhaustive background sweep of the whole category.
const imageQueue = { high: [], low: [] };
let imageQueueRunning = false;

function queueImageTask(task, priority = "low") {
  imageQueue[priority].push(task);
  runImageQueue();
}

async function runImageQueue() {
  if (imageQueueRunning) return;
  imageQueueRunning = true;
  try {
    while (imageQueue.high.length || imageQueue.low.length) {
      const task = imageQueue.high.shift() ?? imageQueue.low.shift();
      try { await task(); } catch (e) { console.warn("Image task failed:", e); }
    }
  } finally {
    imageQueueRunning = false;
  }
}

// Merge photo URLs (and any brand-new part_nums) from a page of live API
// results into the in-memory state + offline image cache.
function applyImageResults(partKey, apiParts) {
  const withImg = apiParts.filter(p => p.part_img_url);
  Catalog.setImages(withImg.map(p => [p.part_num, p.part_img_url]));

  const byNum = new Map(state.parts[partKey].map(p => [p.part_num, p]));
  let changed = false;
  for (const p of withImg) {
    const existing = byNum.get(p.part_num);
    if (existing && existing.part_img_url !== p.part_img_url) {
      existing.part_img_url = p.part_img_url;
      changed = true;
    }
  }

  const added = Catalog.reconcile(partKey, apiParts);
  for (const entry of added) {
    if (byNum.has(entry.part_num)) continue;
    state.parts[partKey].push(annotatePart({ ...entry }));
    changed = true;
  }

  if (changed) {
    rebuildGroups(partKey);
    renderSelector(partKey);
    renderCountLabel(partKey);
  }
}

function startImageLoading(partKey) {
  const type = PART_TYPES.find(t => t.key === partKey);

  // 1) Targeted fetch for whatever the default view actually needs — usually
  //    1-2 requests instead of blindly paginating from page 1 and hoping.
  const prefix = STANDARD_PREFIXES[partKey];
  const targetedUrl = `${API_BASE}/api/v3/lego/parts/?part_cat_id=${type.catId}&page_size=${PAGE_SIZE}` +
    (prefix ? `&search=${encodeURIComponent(prefix)}` : "");
  queueImageTask(async () => {
    const data = await apiFetch(targetedUrl);
    applyImageResults(partKey, data.results ?? []);
  }, "high");

  // 2) Broad low-priority sweep of every page to backfill the rest of the
  //    category and to catch parts added since the offline snapshot.
  queueImageTask(() => sweepCategoryImages(partKey), "low");
}

async function sweepCategoryImages(partKey) {
  const type = PART_TYPES.find(t => t.key === partKey);
  let url = `${API_BASE}/api/v3/lego/parts/?part_cat_id=${type.catId}&page_size=${PAGE_SIZE}`;
  while (url) {
    const data = await apiFetch(url);
    applyImageResults(partKey, data.results ?? []);
    url = data.next;
  }
  state.imageSweepDone[partKey] = true;
  flagPartsWithNoImage(partKey);
  renderCountLabel(partKey);
}

function flagPartsWithNoImage(partKey) {
  let changed = false;
  for (const p of state.parts[partKey]) {
    if (!p.part_img_url && !p._noImage) { p._noImage = true; changed = true; }
  }
  if (changed) renderSelector(partKey);
}

// Jump a specific part's photo to the front of the queue — used when the
// user selects/navigates to a part whose image hasn't loaded yet.
function prioritizeImage(partKey, part) {
  if (!state.usingCatalog[partKey] || part.part_img_url || part._noImage) return;
  const url = `${API_BASE}/api/v3/lego/parts/${encodeURIComponent(part.part_num)}/`;
  imageQueue.high.unshift(async () => {
    try {
      const data = await apiFetch(url);
      applyImageResults(partKey, [data]);
    } catch {
      part._noImage = true;
      renderSelector(partKey);
    }
  });
  runImageQueue();
}

// Selection helper shared by thumb clicks, nav buttons, variant chips and
// randomize — centralizes the "bump this part's photo to the front" step.
function selectPart(partKey, part) {
  const prev = state.selected[partKey];
  state.selected[partKey] = part;
  state.userSelected[partKey] = true;
  // Only collapse the variant chip row when switching to a different mold —
  // picking a sibling variant should keep it expanded.
  if (!prev || prev._n?.baseId !== part._n?.baseId) state.variantExpanded[partKey] = false;
  prioritizeImage(partKey, part);
  renderSelector(partKey);
  renderPreview(); renderSummary(); checkCompatibility();
}

// Search box handler: instant local filter+rank in catalog mode (getVisibleParts
// does the actual filtering), backfilled by a targeted high-priority photo
// fetch for the matches. Legacy categories still hit the live API directly.
function runSearch(partKey, term) {
  if (term) state.userSelected[partKey] = true; // searching is an explicit choice — stop pinning the default
  state.themeId[partKey] = null;
  state.themeName[partKey] = "";
  const ti = document.getElementById(`themeSearch-${partKey}`);
  if (ti) ti.value = "";

  if (!state.usingCatalog[partKey]) {
    fetchParts(partKey, term);
    return;
  }

  const visible = getVisibleParts(partKey);
  if (!visible.find(p => p.part_num === state.selected[partKey]?.part_num)) {
    state.selected[partKey] = visible[0] ?? null;
    if (state.selected[partKey]) prioritizeImage(partKey, state.selected[partKey]);
  }
  renderSelector(partKey);
  renderPreview(); renderSummary(); checkCompatibility();

  if (term) {
    const type = PART_TYPES.find(t => t.key === partKey);
    queueImageTask(async () => {
      const data = await apiFetch(
        `${API_BASE}/api/v3/lego/parts/?part_cat_id=${type.catId}&page_size=${PAGE_SIZE}&search=${encodeURIComponent(term)}`
      );
      applyImageResults(partKey, data.results ?? []);
    }, "high");
  }
}

// While the tab stays open, periodically recheck each category's first page
// against the offline snapshot so parts added to Rebrickable mid-session
// show up without the user having to reload.
function startLiveReconciliation() {
  const INTERVAL_MS = 15 * 60 * 1000;
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    for (const type of PART_TYPES) {
      if (!state.usingCatalog[type.key]) continue;
      queueImageTask(async () => {
        const data = await apiFetch(
          `${API_BASE}/api/v3/lego/parts/?part_cat_id=${type.catId}&page_size=${PAGE_SIZE}`
        );
        applyImageResults(type.key, data.results ?? []);
      }, "low");
    }
  }, INTERVAL_MS);
}


// ──── Theme Loading Chain ─────────────────────────────────────────────────────
async function loadThemesList() {
  const cached = cacheGet("themes_v4");
  if (cached?.length) {
    state.allThemes = cached;
    refreshAllThemeCombos();
    return;
  }

  try {
    let url = `${API_BASE}/api/v3/lego/themes/?page_size=1000`;
    const all = [];
    while (url) {
      const data = await apiFetch(url);
      all.push(...(data.results ?? []));
      url = data.next;
    }
    // Keep only top-level themes (parent_id = null) + sort
    state.allThemes = all
      .filter(t => t.parent_id === null)
      .sort((a, b) => a.name.localeCompare(b.name));

    cacheSet("themes_v4", state.allThemes);
    refreshAllThemeCombos();
  } catch (e) {
    console.warn("Could not load themes:", e);
  }
}

// After themes load, refresh the open dropdown if any
function refreshAllThemeCombos() {
  for (const type of PART_TYPES) {
    const input = document.getElementById(`themeSearch-${type.key}`);
    if (input) input.placeholder = "🎨 Filter by theme…";

    // If this combo is currently open, re-populate it
    if (openComboKey === type.key) {
      populateThemeDropdown(type.key, input?.value ?? "");
    }
  }
}

async function loadThemeParts(partKey, themeId) {
  const type     = PART_TYPES.find(t => t.key === partKey);
  const cacheKey = `theme_${themeId}_${type.catId}`;

  const cached = cacheGet(cacheKey);
  if (cached) {
    state.themeParts[partKey][themeId] = cached.map(p => annotatePart({ ...p }));
    finishThemeLoad(partKey, themeId);
    return;
  }

  state.themeLoading[partKey] = true;
  renderThemeLoadingState(partKey, "Fetching recent sets…");

  try {
    const setsData = await apiFetch(
      `${API_BASE}/api/v3/lego/sets/?theme_id=${themeId}&page_size=${THEME_MAX_SETS}&ordering=-year`
    );
    const setNums = (setsData.results ?? []).map(s => s.set_num);

    const partsMap = new Map();
    for (let i = 0; i < setNums.length; i++) {
      renderThemeLoadingState(partKey, `Scanning set ${i + 1} / ${setNums.length}…`);
      try {
        const pd = await apiFetch(
          `${API_BASE}/api/v3/lego/sets/${setNums[i]}/parts/?page_size=500`
        );
        for (const item of (pd.results ?? [])) {
          const p = item.part;
          if (p?.part_img_url && p.part_cat_id === type.catId && !partsMap.has(p.part_num)) {
            partsMap.set(p.part_num, p);
          }
        }
      } catch {}
    }

    const raw   = Array.from(partsMap.values());
    const parts = raw.map(p => annotatePart({ ...p }));
    state.themeParts[partKey][themeId] = parts;
    cacheSet(cacheKey, raw);
  } catch (e) {
    console.error("Theme load error:", e);
    state.themeParts[partKey][themeId] = [];
  } finally {
    state.themeLoading[partKey] = false;
    finishThemeLoad(partKey, themeId);
  }
}

function finishThemeLoad(partKey, themeId) {
  // Only apply if this theme is still the active one (user may have changed)
  if (state.themeId[partKey] !== themeId) return;
  const visible = getVisibleParts(partKey);
  state.selected[partKey] = visible[0] ?? null;
  renderSelector(partKey);
  renderPreview(); renderSummary(); checkCompatibility();
}

function renderThemeLoadingState(partKey, msg) {
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;
  const existing = strip.querySelector(".theme-load-msg");
  if (existing) { existing.textContent = msg; return; }
  strip.innerHTML = `<div class="theme-load-msg">${escapeHtml(msg)}</div>`;
}


// ──── Theme Combo (searchable picklist) ───────────────────────────────────────
function buildThemeCombo(partKey) {
  const input    = document.getElementById(`themeSearch-${partKey}`);
  const dropdown = document.getElementById(`themeDropdown-${partKey}`);
  if (!input || !dropdown) return;

  input.addEventListener("focus", () => {
    openComboKey = partKey;
    populateThemeDropdown(partKey, input.value);
    dropdown.style.display = "block";
  });

  input.addEventListener("input", () => {
    populateThemeDropdown(partKey, input.value);
    dropdown.style.display = "block";
  });

  // Close when focus leaves the combo
  input.addEventListener("blur", () => {
    // Small delay so clicks on dropdown options register first
    setTimeout(() => {
      if (openComboKey === partKey) {
        dropdown.style.display = "none";
        openComboKey = null;
        // If input text doesn't match selected theme, reset to selected name
        const expected = state.themeId[partKey] !== null ? state.themeName[partKey] : "";
        input.value = expected;
      }
    }, 180);
  });
}

function populateThemeDropdown(partKey, query) {
  const dropdown = document.getElementById(`themeDropdown-${partKey}`);
  if (!dropdown) return;
  dropdown.innerHTML = "";

  const q = query.trim().toLowerCase();
  const loading = state.allThemes.length === 0;

  // ── "All themes" option ──
  addThemeOption(dropdown, partKey, null, "All themes", false, !q && state.themeId[partKey] === null);
  addThemeDivider(dropdown, q ? "All themes" : "Current themes");

  if (loading) {
    addThemeHint(dropdown, "Loading themes…");
    return;
  }

  let shown;
  if (!q) {
    // Default list: known current/popular themes
    shown = state.allThemes.filter(t => CURRENT_THEME_NAMES.has(t.name));
  } else {
    // Search all themes (incl. retired) by name
    shown = state.allThemes.filter(t => t.name.toLowerCase().includes(q));
  }

  for (const t of shown) {
    addThemeOption(dropdown, partKey, t.id, t.name, false, state.themeId[partKey] === t.id);
  }

  if (!q) {
    addThemeHint(dropdown, "Type to search all themes (incl. retired)…");
  } else if (shown.length === 0) {
    addThemeHint(dropdown, "No matching themes");
  }
}

function addThemeOption(container, partKey, id, name, _unused, isSelected) {
  const el = document.createElement("div");
  el.className = "theme-option" + (isSelected ? " selected" : "");
  el.textContent = name;
  // Use mousedown so it fires before the input blur
  el.addEventListener("mousedown", e => {
    e.preventDefault();
    selectTheme(partKey, id, name);
  });
  container.appendChild(el);
}

function addThemeDivider(container, label) {
  const el = document.createElement("div");
  el.className = "theme-separator";
  el.textContent = label;
  container.appendChild(el);
}

function addThemeHint(container, text) {
  const el = document.createElement("div");
  el.className = "theme-hint";
  el.textContent = text;
  container.appendChild(el);
}

async function selectTheme(partKey, themeId, themeName) {
  state.userSelected[partKey] = true; // picking/clearing a theme is an explicit choice
  const input    = document.getElementById(`themeSearch-${partKey}`);
  const dropdown = document.getElementById(`themeDropdown-${partKey}`);

  // Update displayed text
  if (input) input.value = themeId === null ? "" : themeName;
  if (dropdown) dropdown.style.display = "none";
  openComboKey = null;

  state.themeId[partKey]   = themeId;
  state.themeName[partKey] = themeId === null ? "" : themeName;

  // Reset subcategory tabs to All
  state.subcat[partKey] = "All";
  const card = document.getElementById(`card-${partKey}`);
  card?.querySelectorAll(".subcat-tab").forEach(b => b.classList.toggle("active", b.dataset.subcat === "All"));

  if (themeId !== null) {
    // Show loading state immediately
    const themeLoadBadge = document.getElementById(`themeLoadBadge-${partKey}`);
    if (themeLoadBadge) themeLoadBadge.style.display = "inline";
    await loadThemeParts(partKey, themeId);
    if (themeLoadBadge) themeLoadBadge.style.display = "none";
  } else {
    // Cleared theme — revert to normal parts
    const visible = getVisibleParts(partKey);
    state.selected[partKey] = visible[0] ?? null;
    renderSelector(partKey);
    renderPreview(); renderSummary(); checkCompatibility();
  }
}


// ──── Filtering ───────────────────────────────────────────────────────────────
// Ranked local search: exact part_num > part_num prefix > name prefix >
// word-boundary match > plain substring. Runs instantly over the full
// in-memory catalog — no network round-trip per keystroke.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function searchScore(part, q) {
  const name = part.name.toLowerCase();
  const num  = part.part_num.toLowerCase();
  if (num === q) return 0;
  if (num.startsWith(q)) return 1;
  if (name.startsWith(q)) return 2;
  if (new RegExp(`\\b${escapeRegex(q)}`).test(name)) return 3;
  if (name.includes(q) || num.includes(q)) return 4;
  return -1;
}

function getVisibleParts(partKey) {
  const themeId = state.themeId[partKey];
  let list = themeId !== null
    ? (state.themeParts[partKey][themeId] ?? [])
    : state.parts[partKey];

  if (state.standardOnly) {
    const prefix = STANDARD_PREFIXES[partKey];
    if (prefix) list = list.filter(p => p.part_num.startsWith(prefix));
  }

  const subcat = state.subcat[partKey];
  if (subcat !== "All") {
    const rule = (SUBCATEGORIES[partKey] ?? []).find(r => r.label === subcat);
    if (rule) list = list.filter(rule.test);
  }

  // In catalog mode the search box filters the local metadata directly
  // instead of relying on a server round-trip for every keystroke.
  const term = state.search[partKey];
  if (term && state.usingCatalog[partKey] && themeId === null) {
    const q = term.trim().toLowerCase();
    list = list
      .map(p => ({ p, s: searchScore(p, q) }))
      .filter(x => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .map(x => x.p);
  }

  return list;
}


// ──── Compatibility ───────────────────────────────────────────────────────────
function checkCompatibility() {
  const { head, torso, legs } = state.selected;
  const warnings = [];
  if (head && torso) {
    const hs = isStandardPart("head", head), ts = isStandardPart("torso", torso);
    if (hs !== ts) warnings.push(hs
      ? "⚠️ Standard head may not fit this special torso."
      : "⚠️ Special head may not connect to a standard torso.");
  }
  if (torso && legs) {
    const ts = isStandardPart("torso", torso), ls = isStandardPart("legs", legs);
    if (ts !== ls) warnings.push(ts
      ? "⚠️ Standard torso may not attach to these special legs."
      : "⚠️ Special torso may not attach to standard legs.");
  }
  const el = document.getElementById("compatWarning");
  if (!el) return;
  el.innerHTML     = warnings.map(w => `<div>${escapeHtml(w)}</div>`).join("");
  el.style.display = warnings.length ? "block" : "none";
}


// ──── Init ────────────────────────────────────────────────────────────────────
async function init() {
  buildUI();

  // Fetch this build's 4 default parts directly by part_num — dispatched
  // first so they win the shared apiFetch rate-limiter queue and render as
  // soon as each resolves, independent of whatever page/category order the
  // catalog or live API loads the rest of the list in. Not awaited here.
  loadDefaultParts();

  // Offline metadata catalog: instant + complete when available (see
  // catalog.js). Resolves with empty arrays for any category it couldn't
  // fetch (no CORS, offline, old browser), which falls back to the
  // original live-API pagination path below for just that category.
  let offlineCatalog = { hair: [], head: [], torso: [], legs: [] };
  try {
    offlineCatalog = await Catalog.init();
  } catch (e) {
    console.warn("Catalog.init() failed, using live API for everything:", e);
  }
  Catalog.onUpdate(handleCatalogUpdate);

  for (const type of PART_TYPES) {
    if (offlineCatalog[type.key]?.length) {
      seedFromCatalog(type.key, offlineCatalog[type.key]);
    } else {
      // Legacy fallback: restore from localStorage for an instant-ish first paint.
      const cached = cacheGet(`parts_${type.catId}`);
      if (cached?.length) {
        state.parts[type.key] = cached.map(p => annotatePart({ ...p }));
        rebuildGroups(type.key);
        state.nextUrl[type.key] = null;
        ensureSelection(type.key);
        renderSelector(type.key);
        renderPreview(); renderSummary();
      }
    }
  }

  const anyReady = PART_TYPES.some(t => state.parts[t.key].length > 0);
  if (anyReady) document.getElementById("loadingScreen")?.remove();

  // Only categories without an offline snapshot need the old blocking
  // fetch-then-top-up dance; catalog-backed categories already have all
  // their metadata and just need photos (handled below, non-blocking).
  for (const type of PART_TYPES) {
    if (!state.usingCatalog[type.key]) {
      await fetchParts(type.key);
      await ensureMinimumVisible(type.key);
      ensureSelection(type.key);
      renderSelector(type.key);
      renderPreview(); renderSummary(); checkCompatibility();
    }
  }

  document.getElementById("loadingScreen")?.remove();

  // Start progressive photo loading (catalog mode) / eager paging (legacy).
  for (const type of PART_TYPES) {
    if (state.usingCatalog[type.key]) startImageLoading(type.key);
    else startBackgroundLoad(type.key);
  }

  // Load themes in background (non-blocking, updates combos when ready)
  loadThemesList();

  // Keep catching newly-added Rebrickable parts while the tab stays open.
  startLiveReconciliation();
}


// ──── UI Build ────────────────────────────────────────────────────────────────
function buildUI() {
  const ls = document.createElement("div");
  ls.id = "loadingScreen"; ls.className = "loading-screen";
  ls.innerHTML = `
    <div class="loading-brick">
      <div class="spinner-lg"></div>
      <h2>Loading minifig parts…</h2>
      <p>Connecting to Rebrickable API</p>
    </div>`;
  document.body.prepend(ls);

  const previewStack = document.getElementById("previewStack");
  previewStack.innerHTML = "";
  for (const type of PART_TYPES) {
    const slot = document.createElement("div");
    slot.className = "preview-slot"; slot.id = `preview-${type.key}`;
    slot.innerHTML = `<div class="preview-placeholder">?</div>`;
    previewStack.appendChild(slot);
  }

  const previewCard = document.querySelector(".preview-card");
  if (previewCard) {
    const warn = document.createElement("div");
    warn.id = "compatWarning"; warn.className = "compat-warning"; warn.style.display = "none";
    previewCard.insertBefore(warn, document.getElementById("summaryList"));

    const toggle = document.createElement("label");
    toggle.className = "standard-toggle";
    toggle.innerHTML = `
      <input type="checkbox" id="standardToggle"${state.standardOnly ? " checked" : ""}>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="toggle-label">Standard minifig only</span>`;
    previewCard.insertBefore(toggle, previewCard.querySelector(".btn-randomize"));

    document.getElementById("standardToggle").addEventListener("change", e => {
      state.standardOnly = e.target.checked;
      PART_TYPES.forEach(t => {
        state.subcat[t.key] = "All";
        const visible = getVisibleParts(t.key);
        if (!visible.find(p => p.part_num === state.selected[t.key]?.part_num)) {
          state.userSelected[t.key] = true;
          state.selected[t.key] = visible[0] ?? null;
          if (state.selected[t.key]) prioritizeImage(t.key, state.selected[t.key]);
        }
        renderSelector(t.key);
      });
      renderPreview(); renderSummary(); checkCompatibility();
    });
  }

  const col = document.getElementById("selectorsCol");
  col.innerHTML = "";
  for (const type of PART_TYPES) {
    const card = createSelectorCard(type);
    col.appendChild(card);
    buildThemeCombo(type.key);
  }

  document.getElementById("randomizeBtn").addEventListener("click", randomize);

  // Global click: close any open theme dropdown
  document.addEventListener("click", e => {
    if (!openComboKey) return;
    const combo = document.getElementById(`themeCombo-${openComboKey}`);
    if (combo && !combo.contains(e.target)) {
      const dropdown = document.getElementById(`themeDropdown-${openComboKey}`);
      if (dropdown) dropdown.style.display = "none";
      openComboKey = null;
    }
  });
}

function createSelectorCard(type) {
  const card = document.createElement("div");
  card.className = "selector-card"; card.id = `card-${type.key}`;

  const subcatLabels = ["All", ...SUBCATEGORIES[type.key].map(r => r.label)];
  const tabsHtml = subcatLabels.map(label =>
    `<button class="subcat-tab${label === state.subcat[type.key] ? " active" : ""}"
             data-key="${type.key}" data-subcat="${escapeHtml(label)}">${escapeHtml(label)}</button>`
  ).join("");

  card.innerHTML = `
    <div class="selector-header">
      <span class="selector-icon">${type.icon}</span>
      <span class="selector-label">${type.label}</span>
      <span class="part-count" id="count-${type.key}">Loading…</span>
    </div>

    <div class="theme-row">
      <span class="theme-row-label">🎨</span>
      <div class="theme-combo" id="themeCombo-${type.key}">
        <input type="text" class="theme-search-input" id="themeSearch-${type.key}"
               placeholder="🎨 Filter by theme…" autocomplete="off" spellcheck="false">
        <div class="theme-dropdown" id="themeDropdown-${type.key}" style="display:none"></div>
      </div>
      <span class="theme-load-badge" id="themeLoadBadge-${type.key}" style="display:none">⏳</span>
    </div>

    <div class="subcat-tabs" id="tabs-${type.key}">${tabsHtml}</div>

    <input type="text" class="search-input" id="search-${type.key}"
           placeholder="Search ${type.label.toLowerCase()}…">

    <div class="carousel-container">
      <button class="nav-btn" id="prev-${type.key}" disabled>‹</button>
      <div class="part-strip" id="strip-${type.key}">
        <div class="loading-dot"><div class="spinner"></div></div>
      </div>
      <button class="nav-btn" id="next-${type.key}" disabled>›</button>
    </div>

    <div class="part-info" id="info-${type.key}" style="display:none">
      <span class="part-name"  id="infoName-${type.key}"></span>
      <span class="part-id"    id="infoId-${type.key}"></span>
      <span class="part-badge" id="infoBadge-${type.key}"></span>
    </div>

    <div class="variant-row" id="variants-${type.key}" style="display:none">
      <div class="variant-label">Variants of this mold</div>
      <div class="variant-chips" id="variantChips-${type.key}"></div>
    </div>`;

  // Subcategory tabs
  card.querySelector(`#tabs-${type.key}`).addEventListener("click", e => {
    const btn = e.target.closest(".subcat-tab");
    if (!btn) return;
    const subcat = btn.dataset.subcat;
    state.subcat[type.key] = subcat;
    card.querySelectorAll(".subcat-tab").forEach(b => b.classList.toggle("active", b.dataset.subcat === subcat));
    const visible = getVisibleParts(type.key);
    if (!visible.find(p => p.part_num === state.selected[type.key]?.part_num)) {
      state.userSelected[type.key] = true;
      state.selected[type.key] = visible[0] ?? null;
      if (state.selected[type.key]) prioritizeImage(type.key, state.selected[type.key]);
    }
    renderSelector(type.key);
    renderPreview(); renderSummary(); checkCompatibility();
  });

  // Search input — instant local ranked search in catalog mode (no network
  // wait per keystroke); falls back to the live API for legacy categories.
  const searchInput = card.querySelector(`#search-${type.key}`);
  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim();
    state.search[type.key] = term;
    clearTimeout(searchTimers[type.key]);
    const delay = state.usingCatalog[type.key] ? 120 : 600;
    searchTimers[type.key] = setTimeout(() => runSearch(type.key, term), delay);
  });

  // Nav buttons
  card.querySelector(`#prev-${type.key}`).addEventListener("click", () => navigatePart(type.key, -1));
  card.querySelector(`#next-${type.key}`).addEventListener("click", () => navigatePart(type.key,  1));

  // Scroll-to-load-more
  const strip = card.querySelector(`#strip-${type.key}`);
  strip.addEventListener("scroll", () => {
    if (state.loading[type.key] || state.bgLoading[type.key] || !state.nextUrl[type.key]) return;
    if (strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 200) {
      startBackgroundLoad(type.key);
    }
  });

  return card;
}


// ──── Navigation ──────────────────────────────────────────────────────────────
function navigatePart(partKey, dir) {
  const parts = getVisibleParts(partKey);
  if (!parts.length) return;

  const idx = state.selected[partKey]
    ? parts.findIndex(p => p.part_num === state.selected[partKey].part_num)
    : -1;

  let newIdx = idx + dir;
  if (newIdx < 0) newIdx = parts.length - 1;
  if (newIdx >= parts.length) {
    if (!state.themeId[partKey] && state.nextUrl[partKey]) {
      startBackgroundLoad(partKey); return;
    }
    newIdx = 0;
  }

  selectPart(partKey, parts[newIdx]);
  document.querySelector(`#strip-${partKey} .part-thumb.selected`)
    ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}


// ──── Randomize ───────────────────────────────────────────────────────────────
function randomize() {
  for (const type of PART_TYPES) {
    const parts = getVisibleParts(type.key);
    if (!parts.length) continue;
    const part = parts[Math.floor(Math.random() * parts.length)];
    state.selected[type.key] = part;
    state.userSelected[type.key] = true;
    state.variantExpanded[type.key] = false;
    prioritizeImage(type.key, part);
  }
  PART_TYPES.forEach(t => renderSelector(t.key));
  renderPreview(); renderSummary(); checkCompatibility();
}


// ──── Render ──────────────────────────────────────────────────────────────────
function renderSelector(partKey) {
  const themeId   = state.themeId[partKey];
  const allParts  = themeId !== null ? (state.themeParts[partKey][themeId] ?? []) : state.parts[partKey];
  const visible   = getVisibleParts(partKey);
  const selected  = state.selected[partKey];
  const isLoading = state.loading[partKey];

  renderCountLabel(partKey);

  const prevBtn = document.getElementById(`prev-${partKey}`);
  const nextBtn = document.getElementById(`next-${partKey}`);
  if (prevBtn) prevBtn.disabled = !visible.length;
  if (nextBtn) nextBtn.disabled = !visible.length;

  // Part strip
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;
  strip.innerHTML = "";

  if (!visible.length && !isLoading && !state.themeLoading[partKey]) {
    const msg = state.themeLoading[partKey]
      ? ""
      : "No parts found";
    strip.innerHTML = `<div class="empty-msg">${escapeHtml(msg)}</div>`;
  }

  for (const part of visible) {
    const isSelected = selected?.part_num === part.part_num;
    const isStd      = isStandardPart(partKey, part);
    const hasFusion  = (part._p?.fusion?.length ?? 0) > 0;
    const fusionDot  = hasFusion
      ? `<span class="fusion-dot" title="${escapeHtml("+" + part._p.fusion.join(", "))}">+</span>` : "";
    const newBadge   = part._new ? `<span class="new-part-badge" title="Added since last catalog sync">NEW</span>` : "";

    const thumb = document.createElement("div");
    thumb.className = ["part-thumb", isSelected ? "selected" : "", !isStd ? "special-part" : ""]
      .filter(Boolean).join(" ");
    thumb.title = part.name;

    if (part.part_img_url) {
      thumb.innerHTML = `
        <img src="${part.part_img_url}" alt="${escapeHtml(part.name)}" loading="lazy">
        ${fusionDot}${newBadge}`;
      thumb.querySelector("img").addEventListener("error", e => e.target.style.display = "none");
    } else if (part._noImage) {
      thumb.innerHTML = `<div class="thumb-noimg" title="No photo available">🧱</div>${newBadge}`;
    } else {
      thumb.classList.add("pending-image");
      thumb.innerHTML = `<div class="thumb-skeleton"></div>${newBadge}`;
    }

    thumb.addEventListener("click", () => selectPart(partKey, part));
    strip.appendChild(thumb);
  }

  if (isLoading || state.themeLoading[partKey]) {
    const dot = document.createElement("div");
    dot.className = "loading-dot";
    dot.innerHTML = `<div class="spinner"></div>`;
    strip.appendChild(dot);
  }

  // Info bar
  const infoEl  = document.getElementById(`info-${partKey}`);
  const nameEl  = document.getElementById(`infoName-${partKey}`);
  const idEl    = document.getElementById(`infoId-${partKey}`);
  const badgeEl = document.getElementById(`infoBadge-${partKey}`);

  if (selected && infoEl) {
    infoEl.style.display = "flex";
    nameEl.textContent = selected.name;
    idEl.textContent   = `#${selected.part_num}`;
    const subcat = getSubcategoryLabel(partKey, selected);
    const fusion = selected._p?.fusion ?? [];
    const deco   = selected._p?.decoration;
    const bp     = [subcat];
    if (fusion.length)            bp.push(`+ ${fusion.join(", ")}`);
    if (deco && deco !== "Plain") bp.push(deco);
    badgeEl.textContent = bp.join(" · ");
    badgeEl.className   = isStandardPart(partKey, selected) ? "part-badge badge-std" : "part-badge badge-special";
  } else if (infoEl) {
    infoEl.style.display = "none";
  }

  // ── Variant chips with expand/collapse ──
  const variantEl = document.getElementById(`variants-${partKey}`);
  const chipsEl   = document.getElementById(`variantChips-${partKey}`);

  if (selected && variantEl && chipsEl) {
    const baseId   = selected._n?.baseId;
    const siblings = themeId !== null
      ? (state.themeParts[partKey][themeId] ?? []).filter(p => p._n?.baseId === baseId)
      : (state.groups[partKey]?.[baseId] ?? []);

    if (siblings.length > 1) {
      variantEl.style.display = "block";
      chipsEl.innerHTML = "";

      const expanded = state.variantExpanded[partKey];
      const shown    = expanded ? siblings : siblings.slice(0, VARIANT_SHOW);
      const overflow = siblings.length - VARIANT_SHOW;

      for (const sib of shown) {
        const chip = document.createElement("button");
        chip.className = "variant-chip" + (sib.part_num === selected.part_num ? " active" : "");
        chip.textContent = sib._n?.variantSuffix || sib._p?.decoration || sib.part_num;
        chip.title = sib.name;
        chip.addEventListener("click", () => selectPart(partKey, sib));
        chipsEl.appendChild(chip);
      }

      // Expand / collapse toggle
      if (!expanded && overflow > 0) {
        const more = document.createElement("button");
        more.className = "variant-expand-btn";
        more.textContent = `••• ${overflow} more`;
        more.title = "Show all variants";
        more.addEventListener("click", () => {
          state.variantExpanded[partKey] = true;
          renderSelector(partKey);
        });
        chipsEl.appendChild(more);
      } else if (expanded && siblings.length > VARIANT_SHOW) {
        const less = document.createElement("button");
        less.className = "variant-expand-btn variant-collapse-btn";
        less.textContent = "collapse ▲";
        less.title = "Show fewer variants";
        less.addEventListener("click", () => {
          state.variantExpanded[partKey] = false;
          renderSelector(partKey);
        });
        chipsEl.appendChild(less);
      }
    } else {
      variantEl.style.display = "none";
    }
  } else if (variantEl) {
    variantEl.style.display = "none";
  }
}

function updateLoadingUI(partKey) {
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip || state.parts[partKey].length > 0) return;
  strip.innerHTML = `<div class="loading-dot"><div class="spinner"></div></div>`;
}

function renderPreview() {
  for (const type of PART_TYPES) {
    const slot = document.getElementById(`preview-${type.key}`);
    if (!slot) continue;
    const part = state.selected[type.key];
    slot.innerHTML = part
      ? `<img src="${part.part_img_url}" alt="${escapeHtml(part.name)}">`
      : `<div class="preview-placeholder">?</div>`;
  }
}

function renderSummary() {
  const list = document.getElementById("summaryList");
  if (!list) return;
  list.innerHTML = "";
  for (const type of PART_TYPES) {
    const part   = state.selected[type.key];
    const subcat = part ? getSubcategoryLabel(type.key, part) : null;
    const fusion = part?._p?.fusion ?? [];
    const deco   = part?._p?.decoration;
    const name   = part
      ? (part.name.length > 32 ? part.name.slice(0, 32) + "…" : part.name)
      : `No ${type.label}`;
    const bp = subcat ? [subcat] : [];
    if (fusion.length)            bp.push("+" + fusion[0]);
    if (deco && deco !== "Plain") bp.push(deco);
    const item = document.createElement("div");
    item.className = "summary-item";
    item.innerHTML = `
      <span>${type.icon}</span>
      <span class="summary-text">${escapeHtml(name)}</span>
      ${bp.length ? `<span class="summary-badge">${escapeHtml(bp.join(" · "))}</span>` : ""}`;
    list.appendChild(item);
  }
}


// ──── Utility ─────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const d = document.createElement("div");
  d.textContent = text ?? "";
  return d.innerHTML;
}

document.addEventListener("DOMContentLoaded", init);
