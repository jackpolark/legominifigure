/* ============================================
   LEGO MINIFIG BUILDER — Application Logic
   ============================================
   
   Architecture Overview:
   ─────────────────────
   1. RATE LIMITER  — Ensures max 1 API request/sec to avoid 429 errors
   2. API LAYER     — Handles fetching, retries, and error recovery
   3. STATE         — partsCache, selectedParts, nextUrls per category
   4. UI RENDERING  — DOM generation for selectors, preview, and summary
   5. SEARCH        — Debounced search within each part category
   6. PAGINATION    — Lazy-loads more parts when user scrolls to the end
   
   Rebrickable API Endpoints Used:
   • GET /api/v3/lego/parts/?part_cat_id={id}  — List parts by category
   • Supports: &search=, &page_size=, &inc_color_details=0
   
   Part Category IDs:
   • 65 = Minifig Headwear (hair, hats, helmets)
   • 59 = Minifig Heads (printed faces)
   • 60 = Minifig Upper Body (torsos with arms)
   • 61 = Minifig Lower Body (legs, skirts, etc.)
   ============================================ */

// ──── Configuration ────
const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 40;

const PART_TYPES = [
  { key: "hair",  catId: 65, label: "Headwear", icon: "👒" },
  { key: "head",  catId: 59, label: "Head",     icon: "🙂" },
  { key: "torso", catId: 60, label: "Torso",    icon: "👕" },
  { key: "legs",  catId: 61, label: "Legs",     icon: "👖" },
];

// ──── State ────
const state = {
  parts:    { hair: [], head: [], torso: [], legs: [] },
  selected: { hair: null, head: null, torso: null, legs: null },
  nextUrl:  { hair: null, head: null, torso: null, legs: null },
  loading:  { hair: false, head: false, torso: false, legs: false },
  search:   { hair: "", head: "", torso: "", legs: "" },
};

const searchTimers = {};

// ──── Rate Limiter ────
// Rebrickable allows ~1 req/sec. This queues requests so we never exceed that.
const rateLimiter = (() => {
  let lastCall = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  };
})();

// ──── API Fetch with Retry ────
async function apiFetch(url, retries = 0) {
  await rateLimiter();
  
  const res = await fetch(url, {
    headers: { Authorization: `key ${API_KEY}` }
  });

  // Handle rate limiting (429) with exponential backoff
  if (res.status === 429) {
    const backoff = Math.min(8000, 1500 * (retries + 1));
    console.warn(`⏳ Rate limited. Retrying in ${backoff}ms...`);
    await new Promise(r => setTimeout(r, backoff));
    return apiFetch(url, retries + 1);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  return res.json();
}

// ──── Fetch Parts for a Category ────
async function fetchParts(partKey, search = "", append = false, url = null) {
  const type = PART_TYPES.find(t => t.key === partKey);
  if (!type) return;

  state.loading[partKey] = true;
  updateLoadingUI(partKey);

  try {
    const fetchUrl = url || buildPartsUrl(type.catId, search);
    const data = await apiFetch(fetchUrl);
    
    // Filter to parts that have images
    const results = (data.results || []).filter(p => p.part_img_url);

    if (append) {
      state.parts[partKey].push(...results);
    } else {
      state.parts[partKey] = results;
      // Auto-select first part on fresh load/search
      state.selected[partKey] = results.length > 0 ? results[0] : null;
    }

    state.nextUrl[partKey] = data.next;
  } catch (err) {
    console.error(`Error fetching ${partKey}:`, err);
  } finally {
    state.loading[partKey] = false;
    renderSelector(partKey);
    renderPreview();
    renderSummary();
  }
}

function buildPartsUrl(catId, search = "") {
  let url = `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${catId}&page_size=${PAGE_SIZE}&inc_color_details=0`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  return url;
}

// ──── Initialize ────
async function init() {
  buildUI();
  
  // Load parts sequentially to respect rate limits
  for (const type of PART_TYPES) {
    await fetchParts(type.key);
  }

  // Hide loading screen
  const loadingScreen = document.getElementById("loadingScreen");
  if (loadingScreen) loadingScreen.remove();
}

// ──── Build the DOM ────
function buildUI() {
  // Show loading screen
  const loadingScreen = document.createElement("div");
  loadingScreen.id = "loadingScreen";
  loadingScreen.className = "loading-screen";
  loadingScreen.innerHTML = `
    <div>
      <div class="spinner-lg"></div>
      <h2>Loading minifig parts...</h2>
      <p>Connecting to Rebrickable API</p>
    </div>
  `;
  document.body.prepend(loadingScreen);

  // Build preview slots
  const previewStack = document.getElementById("previewStack");
  previewStack.innerHTML = "";
  for (const type of PART_TYPES) {
    const slot = document.createElement("div");
    slot.className = "preview-slot";
    slot.id = `preview-${type.key}`;
    slot.innerHTML = `<div class="preview-placeholder">?</div>`;
    previewStack.appendChild(slot);
  }

  // Build selector cards
  const selectorsCol = document.getElementById("selectorsCol");
  selectorsCol.innerHTML = "";
  for (const type of PART_TYPES) {
    selectorsCol.appendChild(createSelectorCard(type));
  }

  // Randomize button
  document.getElementById("randomizeBtn").addEventListener("click", randomize);
}

function createSelectorCard(type) {
  const card = document.createElement("div");
  card.className = "selector-card";
  card.id = `card-${type.key}`;

  card.innerHTML = `
    <div class="selector-header">
      <span class="selector-icon">${type.icon}</span>
      <span class="selector-label">${type.label}</span>
      <span class="part-count" id="count-${type.key}">Loading...</span>
    </div>
    <input
      type="text"
      class="search-input"
      id="search-${type.key}"
      placeholder="Search ${type.label.toLowerCase()}..."
    >
    <div class="carousel-container">
      <button class="nav-btn" id="prev-${type.key}" disabled>‹</button>
      <div class="part-strip" id="strip-${type.key}">
        <div class="loading-dot"><div class="spinner"></div></div>
      </div>
      <button class="nav-btn" id="next-${type.key}" disabled>›</button>
    </div>
    <div class="part-info" id="info-${type.key}" style="display:none">
      <span class="part-name" id="infoName-${type.key}"></span>
      <span class="part-id" id="infoId-${type.key}"></span>
    </div>
  `;

  // Search handler with debounce
  const searchInput = card.querySelector(`#search-${type.key}`);
  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim();
    state.search[type.key] = term;
    clearTimeout(searchTimers[type.key]);
    searchTimers[type.key] = setTimeout(() => {
      fetchParts(type.key, term);
    }, 600);
  });

  // Nav button handlers
  card.querySelector(`#prev-${type.key}`).addEventListener("click", () => {
    navigatePart(type.key, -1);
  });
  card.querySelector(`#next-${type.key}`).addEventListener("click", () => {
    navigatePart(type.key, 1);
  });

  // Scroll-to-load-more
  const strip = card.querySelector(`#strip-${type.key}`);
  strip.addEventListener("scroll", () => {
    if (state.loading[type.key] || !state.nextUrl[type.key]) return;
    if (strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 200) {
      fetchParts(type.key, state.search[type.key], true, state.nextUrl[type.key]);
    }
  });

  return card;
}

// ──── Navigation ────
function navigatePart(partKey, direction) {
  const parts = state.parts[partKey];
  const current = state.selected[partKey];
  if (!parts.length) return;

  const currentIdx = current ? parts.findIndex(p => p.part_num === current.part_num) : -1;
  let newIdx = currentIdx + direction;

  if (newIdx < 0) newIdx = parts.length - 1;
  if (newIdx >= parts.length) {
    // Try to load more if at the end
    if (state.nextUrl[partKey]) {
      fetchParts(partKey, state.search[partKey], true, state.nextUrl[partKey]);
      return;
    }
    newIdx = 0;
  }

  state.selected[partKey] = parts[newIdx];
  renderSelector(partKey);
  renderPreview();
  renderSummary();

  // Scroll selected thumb into view
  const thumb = document.querySelector(`#strip-${partKey} .part-thumb.selected`);
  if (thumb) thumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
}

// ──── Randomize ────
function randomize() {
  for (const type of PART_TYPES) {
    const parts = state.parts[type.key];
    if (parts.length > 0) {
      state.selected[type.key] = parts[Math.floor(Math.random() * parts.length)];
    }
  }
  PART_TYPES.forEach(t => renderSelector(t.key));
  renderPreview();
  renderSummary();
}

// ──── Render Functions ────

function renderSelector(partKey) {
  const parts = state.parts[partKey];
  const selected = state.selected[partKey];
  const isLoading = state.loading[partKey];
  const hasMore = !!state.nextUrl[partKey];

  // Update count
  const countEl = document.getElementById(`count-${partKey}`);
  if (countEl) {
    countEl.textContent = `${parts.length} parts${hasMore ? "+" : ""}`;
  }

  // Update nav buttons
  const currentIdx = selected ? parts.findIndex(p => p.part_num === selected.part_num) : -1;
  const prevBtn = document.getElementById(`prev-${partKey}`);
  const nextBtn = document.getElementById(`next-${partKey}`);
  if (prevBtn) prevBtn.disabled = parts.length === 0;
  if (nextBtn) nextBtn.disabled = parts.length === 0;

  // Render part strip
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;

  strip.innerHTML = "";

  if (parts.length === 0 && !isLoading) {
    strip.innerHTML = `<div class="empty-msg">No parts found</div>`;
  }

  for (const part of parts) {
    const thumb = document.createElement("div");
    thumb.className = "part-thumb" + (selected?.part_num === part.part_num ? " selected" : "");
    thumb.innerHTML = `<img src="${part.part_img_url}" alt="${escapeHtml(part.name)}" loading="lazy">`;
    thumb.addEventListener("click", () => {
      state.selected[partKey] = part;
      renderSelector(partKey);
      renderPreview();
      renderSummary();
    });
    // Handle broken images
    thumb.querySelector("img").addEventListener("error", (e) => {
      e.target.style.display = "none";
    });
    strip.appendChild(thumb);
  }

  if (isLoading) {
    const dot = document.createElement("div");
    dot.className = "loading-dot";
    dot.innerHTML = `<div class="spinner"></div>`;
    strip.appendChild(dot);
  }

  // Update info bar
  const infoEl = document.getElementById(`info-${partKey}`);
  const nameEl = document.getElementById(`infoName-${partKey}`);
  const idEl = document.getElementById(`infoId-${partKey}`);
  if (selected && infoEl) {
    infoEl.style.display = "flex";
    nameEl.textContent = selected.name;
    idEl.textContent = `#${selected.part_num}`;
  } else if (infoEl) {
    infoEl.style.display = "none";
  }
}

function updateLoadingUI(partKey) {
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;
  // Only show spinner if strip is empty (initial load)
  if (state.parts[partKey].length === 0) {
    strip.innerHTML = `<div class="loading-dot"><div class="spinner"></div></div>`;
  }
}

function renderPreview() {
  for (const type of PART_TYPES) {
    const slot = document.getElementById(`preview-${type.key}`);
    if (!slot) continue;
    const part = state.selected[type.key];
    if (part) {
      slot.innerHTML = `<img src="${part.part_img_url}" alt="${escapeHtml(part.name)}">`;
    } else {
      slot.innerHTML = `<div class="preview-placeholder">?</div>`;
    }
  }
}

function renderSummary() {
  const list = document.getElementById("summaryList");
  if (!list) return;
  list.innerHTML = "";
  for (const type of PART_TYPES) {
    const part = state.selected[type.key];
    const item = document.createElement("div");
    item.className = "summary-item";
    const name = part
      ? (part.name.length > 28 ? part.name.substring(0, 28) + "…" : part.name)
      : `No ${type.label}`;
    item.innerHTML = `<span>${type.icon}</span><span class="summary-text">${escapeHtml(name)}</span>`;
    list.appendChild(item);
  }
}

// ──── Utility ────
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ──── Start ────
document.addEventListener("DOMContentLoaded", init);
