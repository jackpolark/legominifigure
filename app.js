/* ============================================================
   LEGO MINIFIG BUILDER — Application Logic v3
   ============================================================

   LOADING STRATEGY
   ──────────────────────────────────────────────────────────
   Three-layer approach to ensure full data is available:

   1. INITIAL LOAD (fast, blocking)
      - Fetches first page at PAGE_SIZE = 100 per category
      - Applies default subcategory filter immediately on arrival
      - UI is interactive after ~4 seconds (4 sequential calls × 1s rate limit)

   2. BACKGROUND EAGER LOADING (automatic, non-blocking)
      - After initial render, continues fetching remaining pages silently
      - Renders incrementally as pages arrive; strip updates in-place
      - Stops if user triggers a search (avoids stale results)
      - Progress shown via count label: "240 / 1000+ parts"

   3. LOCALSTORAGE CACHE (12-hour TTL)
      - Full part lists saved after background load completes
      - On next visit, cache is restored instantly (no API calls needed)
      - Theme part lists are also cached by themeId+catId key
      - Cache version-stamped so stale schemas auto-invalidate

   THEME LOADING CHAIN
   ──────────────────────────────────────────────────────────
   Themes are not a native filter in the /parts/ API. We resolve them
   by following: theme → recent sets → set parts → filter by cat_id.

   Steps (per-slot, on demand):
     1. GET /api/v3/lego/themes/?page_size=1000  (once, cached)
     2. GET /api/v3/lego/sets/?theme_id=X&page_size=20&ordering=-year
     3. For each set: GET /api/v3/lego/sets/{set_num}/parts/?page_size=500
     4. Filter results to the slot's part_cat_id client-side
     5. Deduplicate by part_num, annotate, display
   Results cached per (themeId, catId) with 12h TTL.

   PARSING MODEL
   ──────────────────────────────────────────────────────────
   part._n = parsePartNum(part_num)
     { baseId, variantType, variantSuffix }

   part._p = parseName(name)
     { primary, fusion[], descriptors[], features[], decoration }

   SUBCATEGORY DEFAULTS
   ──────────────────────────────────────────────────────────
   hair  → "All"      (full variety by default)
   head  → "Standard" (3626-prefix, connects to any standard torso)
   torso → "Standard" (973-prefix, connects to any standard head/legs)
   legs  → "Legs"     (Hips and Legs, the most common piece)
   ============================================================ */

// ──── Config ──────────────────────────────────────────────────────────────────
const API_KEY   = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 100;  // Max practical; Rebrickable allows up to 1000
const THEME_MAX_SETS = 20; // Sets to scan per theme (more = slower, more results)

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


// ──── LocalStorage Cache ──────────────────────────────────────────────────────
const CACHE_VERSION = 3;
const CACHE_TTL     = 12 * 60 * 60 * 1000; // 12 hours

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(`lmb_${key}`);
    if (!raw) return null;
    const { v, t, d } = JSON.parse(raw);
    if (v !== CACHE_VERSION || Date.now() - t > CACHE_TTL) { localStorage.removeItem(`lmb_${key}`); return null; }
    return d;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(`lmb_${key}`, JSON.stringify({ v: CACHE_VERSION, t: Date.now(), d: data }));
  } catch {
    // Quota exceeded — clear all our cached entries and retry once
    for (const k of Object.keys(localStorage)) { if (k.startsWith("lmb_")) localStorage.removeItem(k); }
    try { localStorage.setItem(`lmb_${key}`, JSON.stringify({ v: CACHE_VERSION, t: Date.now(), d: data })); } catch {}
  }
}


// ──── Parsers ─────────────────────────────────────────────────────────────────
function parsePartNum(num) {
  const m = num.match(/^(.+?)(pr\d+|pat\d+|c\d+)$/i);
  if (!m) return { baseId: num, variantType: null, variantSuffix: null };
  return {
    baseId:        m[1],
    variantType:   m[2].match(/^(pr|pat|c)/i)?.[1]?.toLowerCase() ?? null,
    variantSuffix: m[2],
  };
}

function parseName(rawName) {
  let s = rawName.trim();
  let decoration = null;

  if (/\[plain\]$/i.test(s))    { decoration = "Plain";   s = s.replace(/\s*\[plain\]$/i,  "").trim(); }
  else if (/ prints?$/i.test(s)){ decoration = "Print";   s = s.replace(/ prints?$/i,      "").trim(); }
  else if (/ patterns?$/i.test(s)){ decoration = "Pattern"; s = s.replace(/ patterns?$/i,  "").trim(); }

  const withIdx = s.toLowerCase().indexOf(" with ");
  const baseDesc = withIdx !== -1 ? s.slice(0, withIdx).trim() : s;
  const featStr  = withIdx !== -1 ? s.slice(withIdx + 6).trim() : "";

  const tokens      = baseDesc.split(/,\s*/);
  let primaryRaw    = tokens[0].trim().replace(/^Minifig\s+/i, "");
  const descriptors = tokens.slice(1).map(t => t.trim()).filter(Boolean);

  let primaryType, fusion = [];
  const andM   = primaryRaw.match(/^(.+?)\s+and\s+(.+)$/i);
  const slashM = primaryRaw.match(/^(.+?)\s*\/\s*(.+)$/);
  if (andM)         { primaryType = andM[1].trim();   fusion = [andM[2].trim()]; }
  else if (slashM)  { primaryType = slashM[1].trim(); fusion = [slashM[2].trim()]; }
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
  parts:        { hair: [], head: [], torso: [], legs: [] },
  groups:       { hair: {}, head: {}, torso: {}, legs: {} },
  selected:     { hair: null, head: null, torso: null, legs: null },
  nextUrl:      { hair: null, head: null, torso: null, legs: null },
  loading:      { hair: false, head: false, torso: false, legs: false },
  bgLoading:    { hair: false, head: false, torso: false, legs: false },
  search:       { hair: "", head: "", torso: "", legs: "" },

  // Defaults: All / Standard / Standard / Legs
  subcat:       { hair: "All", head: "Standard", torso: "Standard", legs: "Legs" },
  standardOnly: false,

  // Theme state
  allThemes:     [],       // all top-level themes from API
  themeId:      { hair: null, head: null, torso: null, legs: null },
  themeParts:   { hair: {}, head: {}, torso: {}, legs: {} },  // themeId → [parts]
  themeLoading: { hair: false, head: false, torso: false, legs: false },
};

const searchTimers = {};


// ──── Rate Limiter ────────────────────────────────────────────────────────────
// Queues all requests to fire at most once per 1100ms.
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
  const res = await fetch(url, { headers: { Authorization: `key ${API_KEY}` } });
  if (res.status === 429) {
    const backoff = Math.min(8000, 1500 * (retries + 1));
    console.warn(`⏳ Rate limited. Retrying in ${backoff}ms…`);
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
      `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${type.catId}&page_size=${PAGE_SIZE}&inc_color_details=0` +
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
      // Auto-select first visible part on fresh load
      const visible = getVisibleParts(partKey);
      state.selected[partKey] = visible[0] ?? null;
    }
  } catch (err) {
    console.error(`Error fetching ${partKey}:`, err);
  } finally {
    state.loading[partKey] = false;
    renderSelector(partKey);
    renderPreview();
    renderSummary();
    checkCompatibility();
  }
}

// Rebuild baseId → [parts] groups map
function rebuildGroups(partKey) {
  state.groups[partKey] = {};
  for (const p of state.parts[partKey]) {
    const bid = p._n.baseId;
    if (!state.groups[partKey][bid]) state.groups[partKey][bid] = [];
    state.groups[partKey][bid].push(p);
  }
}


// ──── Background Eager Loading ────────────────────────────────────────────────
// After the initial page renders, this silently loads remaining pages.
// Stops if the user starts a search (would corrupt search results).
// When complete, saves the full list to localStorage.
async function startBackgroundLoad(partKey) {
  if (state.bgLoading[partKey]) return;
  state.bgLoading[partKey] = true;

  const type = PART_TYPES.find(t => t.key === partKey);

  try {
    while (state.nextUrl[partKey]) {
      // Abort if user started a search — their fresh fetch will restart this
      if (state.search[partKey]) break;

      await fetchParts(partKey, "", true, state.nextUrl[partKey]);
    }

    // Full load complete — cache to localStorage
    if (!state.search[partKey] && !state.nextUrl[partKey]) {
      // Store only the fields we need (keep storage small)
      const toCache = state.parts[partKey].map(p => ({
        part_num: p.part_num, name: p.name,
        part_img_url: p.part_img_url, part_cat_id: p.part_cat_id,
      }));
      cacheSet(`parts_${type.catId}`, toCache);
      updateCountLabel(partKey); // remove the "bg loading" indicator
    }
  } finally {
    state.bgLoading[partKey] = false;
  }
}

function updateCountLabel(partKey) {
  const countEl = document.getElementById(`count-${partKey}`);
  if (!countEl) return;
  const total    = state.parts[partKey].length;
  const visible  = getVisibleParts(partKey).length;
  const filtered = state.subcat[partKey] !== "All" || state.standardOnly || state.themeId[partKey];
  const bg       = state.bgLoading[partKey];
  countEl.textContent = filtered
    ? `${visible} / ${total}${bg ? "…" : ""} parts`
    : `${total}${bg ? "…" : ""} parts`;
}


// ──── Theme Loading ───────────────────────────────────────────────────────────
async function loadThemesList() {
  const cached = cacheGet("themes");
  if (cached && cached.length) { state.allThemes = cached; return; }

  try {
    // Rebrickable returns ~600 themes including nested sub-themes
    // We load all pages and filter to top-level (parent_id === null)
    let url = `https://rebrickable.com/api/v3/lego/themes/?page_size=1000`;
    const allThemes = [];
    while (url) {
      const data = await apiFetch(url);
      allThemes.push(...(data.results ?? []));
      url = data.next;
    }
    state.allThemes = allThemes
      .filter(t => t.parent_id === null)
      .sort((a, b) => a.name.localeCompare(b.name));

    cacheSet("themes", state.allThemes);
    populateThemeDropdowns();
  } catch (e) {
    console.warn("Could not load themes:", e);
  }
}

function populateThemeDropdowns() {
  for (const type of PART_TYPES) {
    const sel = document.getElementById(`theme-${type.key}`);
    if (!sel) continue;
    // Clear all but the first "All themes" option
    while (sel.options.length > 1) sel.remove(1);
    for (const t of state.allThemes) {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  }
}

async function loadThemeParts(partKey, themeId) {
  const type      = PART_TYPES.find(t => t.key === partKey);
  const cacheKey  = `theme_${themeId}_${type.catId}`;

  // Return cached result if available
  const cached = cacheGet(cacheKey);
  if (cached) {
    state.themeParts[partKey][themeId] = cached.map(p => annotatePart({ ...p }));
    renderSelector(partKey);
    renderPreview(); renderSummary(); checkCompatibility();
    return;
  }

  state.themeLoading[partKey] = true;
  renderThemeLoadingState(partKey, "Fetching sets…");

  try {
    // Step 1: get recent sets for this theme
    const setsData = await apiFetch(
      `https://rebrickable.com/api/v3/lego/sets/?theme_id=${themeId}&page_size=${THEME_MAX_SETS}&ordering=-year`
    );
    const setNums = (setsData.results ?? []).map(s => s.set_num);

    if (!setNums.length) {
      state.themeParts[partKey][themeId] = [];
      return;
    }

    // Step 2: fetch all parts from each set, filter by catId client-side
    // (The set parts endpoint doesn't support part_cat_id filtering)
    const partsMap = new Map(); // part_num → part object
    let done = 0;

    for (const setNum of setNums) {
      done++;
      renderThemeLoadingState(partKey, `Scanning set ${done}/${setNums.length}…`);
      try {
        // Some sets are large; fetch first page (page_size=500 covers most)
        const partsData = await apiFetch(
          `https://rebrickable.com/api/v3/lego/sets/${setNum}/parts/?page_size=500`
        );
        for (const item of (partsData.results ?? [])) {
          const p = item.part;
          // Filter to our target category, require an image
          if (p && p.part_img_url && p.part_cat_id === type.catId && !partsMap.has(p.part_num)) {
            partsMap.set(p.part_num, p);
          }
        }
      } catch {
        // Skip a set that errors (404 for retired sets is common)
      }
    }

    const rawParts = Array.from(partsMap.values());
    const parts    = rawParts.map(p => annotatePart({ ...p }));
    state.themeParts[partKey][themeId] = parts;

    // Cache raw (un-annotated) list
    cacheSet(cacheKey, rawParts);

  } catch (e) {
    console.error(`Theme load error (${partKey}, theme ${themeId}):`, e);
    state.themeParts[partKey][themeId] = [];
  } finally {
    state.themeLoading[partKey] = false;
    renderSelector(partKey);
    renderPreview(); renderSummary(); checkCompatibility();
  }
}

function renderThemeLoadingState(partKey, msg) {
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;
  const existing = strip.querySelector(".theme-load-msg");
  if (existing) { existing.textContent = msg; return; }

  strip.innerHTML = "";
  const div = document.createElement("div");
  div.className = "theme-load-msg";
  div.textContent = msg;
  strip.appendChild(div);
}


// ──── Filtering ───────────────────────────────────────────────────────────────
function getVisibleParts(partKey) {
  // Theme mode: use theme-specific parts list if a theme is selected
  const themeId = state.themeId[partKey];
  let list = themeId !== null
    ? (state.themeParts[partKey][themeId] ?? [])
    : state.parts[partKey];

  // Standard-only filter
  if (state.standardOnly) {
    const prefix = STANDARD_PREFIXES[partKey];
    if (prefix) list = list.filter(p => p.part_num.startsWith(prefix));
  }

  // Subcategory filter
  const subcat = state.subcat[partKey];
  if (subcat !== "All") {
    const rule = (SUBCATEGORIES[partKey] ?? []).find(r => r.label === subcat);
    if (rule) list = list.filter(rule.test);
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
      : "⚠️ Special head may not connect to this standard torso.");
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

  // Load from localStorage cache first for instant render, then validate with API
  let anyCached = false;
  for (const type of PART_TYPES) {
    const cached = cacheGet(`parts_${type.catId}`);
    if (cached && cached.length > 0) {
      state.parts[type.key] = cached.map(p => annotatePart({ ...p }));
      rebuildGroups(type.key);
      state.nextUrl[type.key] = null; // assume full list cached
      const visible = getVisibleParts(type.key);
      state.selected[type.key] = visible[0] ?? null;
      renderSelector(type.key);
      renderPreview(); renderSummary();
      anyCached = true;
    }
  }

  if (anyCached) {
    document.getElementById("loadingScreen")?.remove();
  }

  // Always fetch fresh first pages to catch new parts / validate cache
  for (const type of PART_TYPES) {
    await fetchParts(type.key); // sequential to respect rate limit
  }

  document.getElementById("loadingScreen")?.remove();

  // Start background loading for all categories in parallel (they self-rate-limit)
  for (const type of PART_TYPES) {
    startBackgroundLoad(type.key); // intentionally NOT awaited
  }

  // Load themes list in background after everything else
  loadThemesList(); // intentionally NOT awaited
}


// ──── UI Build ────────────────────────────────────────────────────────────────
function buildUI() {
  // Loading screen (only shown if no cache)
  const ls = document.createElement("div");
  ls.id = "loadingScreen"; ls.className = "loading-screen";
  ls.innerHTML = `
    <div class="loading-brick">
      <div class="spinner-lg"></div>
      <h2>Loading minifig parts…</h2>
      <p>Connecting to Rebrickable API</p>
    </div>`;
  document.body.prepend(ls);

  // Preview slots
  const previewStack = document.getElementById("previewStack");
  previewStack.innerHTML = "";
  for (const type of PART_TYPES) {
    const slot = document.createElement("div");
    slot.className = "preview-slot"; slot.id = `preview-${type.key}`;
    slot.innerHTML = `<div class="preview-placeholder">?</div>`;
    previewStack.appendChild(slot);
  }

  // Compat warning + standard toggle in preview card
  const previewCard = document.querySelector(".preview-card");
  if (previewCard) {
    const warn = document.createElement("div");
    warn.id = "compatWarning"; warn.className = "compat-warning"; warn.style.display = "none";
    previewCard.insertBefore(warn, document.getElementById("summaryList"));

    const toggle = document.createElement("label");
    toggle.className = "standard-toggle";
    toggle.innerHTML = `
      <input type="checkbox" id="standardToggle">
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="toggle-label">Standard minifig only</span>`;
    previewCard.insertBefore(toggle, previewCard.querySelector(".btn-randomize"));

    document.getElementById("standardToggle").addEventListener("change", e => {
      state.standardOnly = e.target.checked;
      PART_TYPES.forEach(t => {
        state.subcat[t.key] = "All";
        const visible = getVisibleParts(t.key);
        if (!visible.find(p => p.part_num === state.selected[t.key]?.part_num)) {
          state.selected[t.key] = visible[0] ?? null;
        }
        renderSelector(t.key);
      });
      renderPreview(); renderSummary(); checkCompatibility();
    });
  }

  // Selector cards
  const col = document.getElementById("selectorsCol");
  col.innerHTML = "";
  for (const type of PART_TYPES) col.appendChild(createSelectorCard(type));

  document.getElementById("randomizeBtn").addEventListener("click", randomize);
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
      <label class="theme-row-label">🎨 Theme</label>
      <select class="theme-select" id="theme-${type.key}">
        <option value="">All themes</option>
        <!-- Populated after themes API call -->
      </select>
      <span class="theme-loading-badge" id="themeLoading-${type.key}" style="display:none">⏳</span>
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

  // ── Theme dropdown ──
  const themeSelect = card.querySelector(`#theme-${type.key}`);
  themeSelect.addEventListener("change", async () => {
    const themeId = themeSelect.value ? parseInt(themeSelect.value) : null;
    state.themeId[type.key] = themeId;
    state.subcat[type.key] = "All";
    card.querySelectorAll(".subcat-tab").forEach(b => b.classList.toggle("active", b.dataset.subcat === "All"));

    if (themeId !== null) {
      // Show loading badge on the dropdown row
      const badge = document.getElementById(`themeLoading-${type.key}`);
      if (badge) badge.style.display = "inline";

      await loadThemeParts(type.key, themeId);

      if (badge) badge.style.display = "none";
    }

    // Auto-select first visible part in new theme
    const visible = getVisibleParts(type.key);
    state.selected[type.key] = visible[0] ?? null;
    renderSelector(type.key);
    renderPreview(); renderSummary(); checkCompatibility();
  });

  // ── Subcategory tabs ──
  card.querySelector(`#tabs-${type.key}`).addEventListener("click", e => {
    const btn = e.target.closest(".subcat-tab");
    if (!btn) return;
    const subcat = btn.dataset.subcat;
    state.subcat[type.key] = subcat;
    card.querySelectorAll(".subcat-tab").forEach(b => b.classList.toggle("active", b.dataset.subcat === subcat));
    const visible = getVisibleParts(type.key);
    if (!visible.find(p => p.part_num === state.selected[type.key]?.part_num)) {
      state.selected[type.key] = visible[0] ?? null;
    }
    renderSelector(type.key);
    renderPreview(); renderSummary(); checkCompatibility();
  });

  // ── Search ──
  const searchInput = card.querySelector(`#search-${type.key}`);
  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim();
    state.search[type.key] = term;
    clearTimeout(searchTimers[type.key]);
    searchTimers[type.key] = setTimeout(async () => {
      // Clear theme filter when searching
      state.themeId[type.key] = null;
      const sel = document.getElementById(`theme-${type.key}`);
      if (sel) sel.value = "";
      await fetchParts(type.key, term);
    }, 600);
  });

  // ── Nav buttons ──
  card.querySelector(`#prev-${type.key}`).addEventListener("click", () => navigatePart(type.key, -1));
  card.querySelector(`#next-${type.key}`).addEventListener("click", () => navigatePart(type.key,  1));

  // ── Scroll-to-load-more (for non-cached sessions) ──
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
    // Try to fetch more if not in theme mode
    if (!state.themeId[partKey] && state.nextUrl[partKey]) {
      startBackgroundLoad(partKey);
      return;
    }
    newIdx = 0;
  }

  state.selected[partKey] = parts[newIdx];
  renderSelector(partKey);
  renderPreview(); renderSummary(); checkCompatibility();
  document.querySelector(`#strip-${partKey} .part-thumb.selected`)
    ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}


// ──── Randomize ───────────────────────────────────────────────────────────────
function randomize() {
  for (const type of PART_TYPES) {
    const parts = getVisibleParts(type.key);
    if (parts.length) state.selected[type.key] = parts[Math.floor(Math.random() * parts.length)];
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
  const isBg      = state.bgLoading[partKey];

  // Count label
  const countEl = document.getElementById(`count-${partKey}`);
  if (countEl) {
    const filtered = state.subcat[partKey] !== "All" || state.standardOnly || themeId !== null;
    const hasMore  = !!state.nextUrl[partKey];
    countEl.textContent = filtered
      ? `${visible.length} / ${allParts.length}${hasMore || isBg ? "…" : ""} parts`
      : `${allParts.length}${hasMore || isBg ? "…" : ""} parts`;
  }

  // Theme loading indicator on badge
  const themeBadge = document.getElementById(`themeLoading-${partKey}`);
  if (themeBadge) themeBadge.style.display = state.themeLoading[partKey] ? "inline" : "none";

  // Nav buttons
  const prevBtn = document.getElementById(`prev-${partKey}`);
  const nextBtn = document.getElementById(`next-${partKey}`);
  if (prevBtn) prevBtn.disabled = !visible.length;
  if (nextBtn) nextBtn.disabled = !visible.length;

  // Part strip
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;
  strip.innerHTML = "";

  if (!visible.length && !isLoading && !state.themeLoading[partKey]) {
    strip.innerHTML = `<div class="empty-msg">No parts found</div>`;
  }

  for (const part of visible) {
    const isSelected = selected?.part_num === part.part_num;
    const isStd      = isStandardPart(partKey, part);
    const hasFusion  = (part._p?.fusion?.length ?? 0) > 0;

    const thumb = document.createElement("div");
    thumb.className = ["part-thumb", isSelected ? "selected" : "", !isStd ? "special-part" : ""]
      .filter(Boolean).join(" ");
    thumb.title = part.name;
    thumb.innerHTML = `
      <img src="${part.part_img_url}" alt="${escapeHtml(part.name)}" loading="lazy">
      ${hasFusion ? `<span class="fusion-dot" title="${escapeHtml("+" + part._p.fusion.join(", "))}">+</span>` : ""}`;
    thumb.addEventListener("click", () => {
      state.selected[partKey] = part;
      renderSelector(partKey);
      renderPreview(); renderSummary(); checkCompatibility();
    });
    thumb.querySelector("img").addEventListener("error", e => e.target.style.display = "none");
    strip.appendChild(thumb);
  }

  if (isLoading || state.themeLoading[partKey]) {
    const dot = document.createElement("div");
    dot.className = "loading-dot";
    dot.innerHTML = `<div class="spinner"></div>`;
    strip.appendChild(dot);
  }

  // Background loading indicator in count (already handled above)
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

  // Variant chips row
  const variantEl = document.getElementById(`variants-${partKey}`);
  const chipsEl   = document.getElementById(`variantChips-${partKey}`);
  if (selected && variantEl && chipsEl) {
    const baseId   = selected._n?.baseId;
    // In theme mode, siblings come from theme parts; otherwise from global groups
    const siblings = themeId !== null
      ? (state.themeParts[partKey][themeId] ?? []).filter(p => p._n?.baseId === baseId)
      : (state.groups[partKey]?.[baseId] ?? []);

    if (siblings.length > 1) {
      variantEl.style.display = "block";
      chipsEl.innerHTML = "";
      for (const sib of siblings) {
        const chip = document.createElement("button");
        chip.className = "variant-chip" + (sib.part_num === selected.part_num ? " active" : "");
        chip.textContent = sib._n?.variantSuffix || sib._p?.decoration || sib.part_num;
        chip.title = sib.name;
        chip.addEventListener("click", () => {
          state.selected[partKey] = sib;
          renderSelector(partKey);
          renderPreview(); renderSummary(); checkCompatibility();
        });
        chipsEl.appendChild(chip);
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
    const part  = state.selected[type.key];
    const subcat = part ? getSubcategoryLabel(type.key, part) : null;
    const fusion = part?._p?.fusion ?? [];
    const deco   = part?._p?.decoration;
    const name   = part
      ? (part.name.length > 32 ? part.name.slice(0, 32) + "…" : part.name)
      : `No ${type.label}`;
    const bp = subcat ? [subcat] : [];
    if (fusion.length) bp.push("+" + fusion[0]);
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
