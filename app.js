/* ============================================
   LEGO MINIFIG BUILDER — Application Logic
   ============================================

   PARSING MODEL
   ─────────────
   Every fetched part gets two extra fields:

   part._n  (part number parse)
   ────────────────────────────
   { baseId, variantType, variantSuffix }
   "02137pat0003" → { baseId:"02137", variantType:"pat", variantSuffix:"pat0003" }
   "10113"        → { baseId:"10113", variantType:null,  variantSuffix:null }

   part._p  (name parse)
   ──────────────────────
   { primary, fusion[], descriptors[], features[], decoration }
   "Hair and Helmet, Long with Red Helmet Pattern"
    → { primary:"Hair", fusion:["Helmet"], descriptors:["Long"],
        features:["Red Helmet"], decoration:"Pattern" }
   "Mask, Batman Cowl [Plain]"
    → { primary:"Mask", fusion:[], descriptors:["Batman Cowl"],
        features:[], decoration:"Plain" }

   SUBCATEGORY SYSTEM
   ──────────────────
   Tabs are driven by part._p.primary (parsed primary type), not raw
   regex on the name. This handles "Hair and Helmet" → Hair tab,
   "Costume / Mask" → Costume tab, etc. correctly.

   VARIANT GROUPS
   ──────────────
   state.groups[key][baseId] = [part, part, ...]
   When you select a part that has siblings (same baseId, different
   print/pattern), a chips row appears below the info bar.

   COMPATIBILITY
   ─────────────
   Standard geometry inferred from part_num prefix:
     Head → "3626"   Torso → "973"   Legs → "970"
   Mixing standard + special triggers a yellow warning in the preview.
   ============================================ */

// ──── Config ──────────────────────────────────────────────────────────────────
const API_KEY   = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 40;

const PART_TYPES = [
  { key: "hair",  catId: 65, label: "Headwear", icon: "👒" },
  { key: "head",  catId: 59, label: "Head",     icon: "🙂" },
  { key: "torso", catId: 60, label: "Torso",    icon: "👕" },
  { key: "legs",  catId: 61, label: "Legs",     icon: "👖" },
];

// Multi-word primaries that must NOT be split at first word
const MULTIWORD_PRIMARIES = ["Santa Hat", "Top Hat"];

// Part-num prefixes that identify "standard" minifig geometry per slot
const STANDARD_PREFIXES = {
  hair: null, head: "3626", torso: "973", legs: "970",
};

// ──── Subcategories ───────────────────────────────────────────────────────────
// Tests run against the fully-annotated part (with ._p and ._n added).
// "Other" is a catch-all; first non-Other match wins.
const SUBCATEGORIES = {
  hair: [
    { label: "Hair",     test: p => /^hair$/i.test(p._p.primary) },
    { label: "Helmet",   test: p => /^helmet$/i.test(p._p.primary) },
    { label: "Hat",      test: p => /^(hat|cap|santa hat|top hat)$/i.test(p._p.primary) },
    { label: "Mask",     test: p => /^mask$/i.test(p._p.primary) },
    { label: "Hood",     test: p => /^hood$/i.test(p._p.primary) },
    { label: "Crown",    test: p => /^crown$/i.test(p._p.primary) },
    { label: "Costume",  test: p => /^costume$/i.test(p._p.primary) },
    { label: "Other",    test: () => true },
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


// ──── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Parse a part_num into structural components.
 *
 * Strategy: match the last pr/pat/c block immediately before trailing digits.
 *
 * Examples:
 *   "02137pat0003"  → { baseId:"02137",  variantType:"pat", variantSuffix:"pat0003" }
 *   "10165c01"      → { baseId:"10165",  variantType:"c",   variantSuffix:"c01" }
 *   "10113pr9999"   → { baseId:"10113",  variantType:"pr",  variantSuffix:"pr9999" }
 *   "10113"         → { baseId:"10113",  variantType:null,  variantSuffix:null }
 */
function parsePartNum(num) {
  const m = num.match(/^(.+?)(pr\d+|pat\d+|c\d+)$/i);
  if (!m) return { baseId: num, variantType: null, variantSuffix: null };
  const vType = m[2].match(/^(pr|pat|c)/i)?.[1]?.toLowerCase() ?? null;
  return { baseId: m[1], variantType: vType, variantSuffix: m[2] };
}

/**
 * Parse a part name into semantic fields.
 *
 * LEGO naming grammar (reverse-engineered from the full cat 65 dataset):
 *
 *   [Primary [and/« / »Secondary]] [, Descriptor]* [with Features] [Decoration]
 *
 * Steps:
 *   1. Strip trailing decoration keyword  ([Plain] / Print / Pattern)
 *   2. Split on " with " → baseDesc + features
 *   3. Split baseDesc on ", " → primaryRaw + descriptors[]
 *   4. Strip "Minifig " prefix from primaryRaw
 *   5. Detect fusion  ("Hair and Helmet" → primary:"Hair", fusion:["Helmet"])
 *                     ("Costume / Mask"  → primary:"Costume", fusion:["Mask"])
 *   6. Handle multi-word primaries ("Santa Hat", "Top Hat")
 */
function parseName(rawName) {
  let s = rawName.trim();
  let decoration = null;

  // Step 1 — decoration suffix
  if (/\[plain\]$/i.test(s)) {
    decoration = "Plain";
    s = s.replace(/\s*\[plain\]$/i, "").trim();
  } else if (/ prints?$/i.test(s)) {
    decoration = "Print";
    s = s.replace(/ prints?$/i, "").trim();
  } else if (/ patterns?$/i.test(s)) {
    decoration = "Pattern";
    s = s.replace(/ patterns?$/i, "").trim();
  }

  // Step 2 — split on " with "
  const withIdx = s.toLowerCase().indexOf(" with ");
  const baseDesc = withIdx !== -1 ? s.slice(0, withIdx).trim() : s;
  const featStr  = withIdx !== -1 ? s.slice(withIdx + 6).trim() : "";

  // Step 3 — split base by ", "
  const tokens     = baseDesc.split(/,\s*/);
  let primaryRaw   = tokens[0].trim();
  const descriptors = tokens.slice(1).map(t => t.trim()).filter(Boolean);

  // Step 4 — strip "Minifig " prefix
  primaryRaw = primaryRaw.replace(/^Minifig\s+/i, "");

  // Step 5 — detect fusion
  let primaryType, fusion = [];

  const andMatch   = primaryRaw.match(/^(.+?)\s+and\s+(.+)$/i);
  const slashMatch = primaryRaw.match(/^(.+?)\s*\/\s*(.+)$/);

  if (andMatch) {
    primaryType = andMatch[1].trim();
    fusion      = [andMatch[2].trim()];
  } else if (slashMatch) {
    primaryType = slashMatch[1].trim();
    fusion      = [slashMatch[2].trim()];
  } else {
    // Step 6 — multi-word primaries or single-word
    const multi = MULTIWORD_PRIMARIES.find(
      t => primaryRaw.toLowerCase().startsWith(t.toLowerCase())
    );
    primaryType = multi ?? primaryRaw.split(/\s+/)[0];
  }

  return {
    primary:     primaryType,          // "Hair", "Helmet", "Mask" …
    fusion,                            // ["Helmet"] for "Hair and Helmet"
    descriptors,                       // ["Long"] from ", Long"
    features:    featStr ? featStr.split(/,\s*/) : [],
    decoration,                        // "Print" | "Pattern" | "Plain" | null
  };
}

/** Annotate a raw API part in-place with ._n and ._p fields. */
function annotatePart(part) {
  part._n = parsePartNum(part.part_num);
  part._p = parseName(part.name);
  return part;
}

/** Return the first matching subcategory label for a part. */
function getSubcategoryLabel(partKey, part) {
  const rules = SUBCATEGORIES[partKey] ?? [];
  for (const r of rules.filter(r => r.label !== "Other")) {
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
  groups:       { hair: {}, head: {}, torso: {}, legs: {} }, // baseId → [parts]
  selected:     { hair: null, head: null, torso: null, legs: null },
  nextUrl:      { hair: null, head: null, torso: null, legs: null },
  loading:      { hair: false, head: false, torso: false, legs: false },
  search:       { hair: "", head: "", torso: "", legs: "" },
  subcat:       { hair: "All", head: "All", torso: "All", legs: "All" },
  standardOnly: false,
};

const searchTimers = {};


// ──── Rate Limiter ────────────────────────────────────────────────────────────
const rateLimiter = (() => {
  let last = 0;
  return async () => {
    const wait = Math.max(0, 1100 - (Date.now() - last));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
})();


// ──── API ─────────────────────────────────────────────────────────────────────
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

async function fetchParts(partKey, search = "", append = false, url = null) {
  const type = PART_TYPES.find(t => t.key === partKey);
  if (!type) return;

  state.loading[partKey] = true;
  updateLoadingUI(partKey);

  try {
    const fetchUrl = url ||
      `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${type.catId}` +
      `&page_size=${PAGE_SIZE}&inc_color_details=0` +
      (search ? `&search=${encodeURIComponent(search)}` : "");

    const data    = await apiFetch(fetchUrl);
    const results = (data.results ?? []).filter(p => p.part_img_url).map(annotatePart);

    if (append) {
      state.parts[partKey].push(...results);
    } else {
      state.parts[partKey] = results;
    }

    // Rebuild variant groups
    state.groups[partKey] = {};
    for (const p of state.parts[partKey]) {
      const bid = p._n.baseId;
      if (!state.groups[partKey][bid]) state.groups[partKey][bid] = [];
      state.groups[partKey][bid].push(p);
    }

    state.nextUrl[partKey] = data.next;

    // Auto-select first visible on fresh load / search
    if (!append) {
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


// ──── Filtering ───────────────────────────────────────────────────────────────
function getVisibleParts(partKey, partsOverride) {
  let list = partsOverride ?? state.parts[partKey];

  if (state.standardOnly) {
    const prefix = STANDARD_PREFIXES[partKey];
    if (prefix) list = list.filter(p => p.part_num.startsWith(prefix));
  }

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
    const hs = isStandardPart("head",  head);
    const ts = isStandardPart("torso", torso);
    if (hs !== ts) warnings.push(
      hs ? "⚠️ Standard head may not fit this special torso."
         : "⚠️ Special head may not connect to this standard torso."
    );
  }
  if (torso && legs) {
    const ts = isStandardPart("torso", torso);
    const ls = isStandardPart("legs",  legs);
    if (ts !== ls) warnings.push(
      ts ? "⚠️ Standard torso may not attach to these special legs."
         : "⚠️ Special torso may not attach to standard legs."
    );
  }

  const el = document.getElementById("compatWarning");
  if (!el) return;
  el.innerHTML   = warnings.map(w => `<div>${escapeHtml(w)}</div>`).join("");
  el.style.display = warnings.length ? "block" : "none";
}


// ──── UI Bootstrap ────────────────────────────────────────────────────────────
async function init() {
  buildUI();
  for (const type of PART_TYPES) await fetchParts(type.key);
  document.getElementById("loadingScreen")?.remove();
}

function buildUI() {
  // Loading overlay
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

  // Compatibility warning + standard toggle (injected into preview card)
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
  const tabsHtml = subcatLabels.map(label => `
    <button class="subcat-tab${label === "All" ? " active" : ""}"
            data-key="${type.key}" data-subcat="${escapeHtml(label)}">
      ${escapeHtml(label)}
    </button>`).join("");

  card.innerHTML = `
    <div class="selector-header">
      <span class="selector-icon">${type.icon}</span>
      <span class="selector-label">${type.label}</span>
      <span class="part-count" id="count-${type.key}">Loading…</span>
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

  // Subcategory tab clicks
  card.querySelector(`#tabs-${type.key}`).addEventListener("click", e => {
    const btn = e.target.closest(".subcat-tab");
    if (!btn) return;
    const subcat = btn.dataset.subcat;
    state.subcat[type.key] = subcat;
    card.querySelectorAll(".subcat-tab")
        .forEach(b => b.classList.toggle("active", b.dataset.subcat === subcat));
    const visible = getVisibleParts(type.key);
    if (!visible.find(p => p.part_num === state.selected[type.key]?.part_num)) {
      state.selected[type.key] = visible[0] ?? null;
    }
    renderSelector(type.key);
    renderPreview(); renderSummary(); checkCompatibility();
  });

  // Debounced search
  const searchInput = card.querySelector(`#search-${type.key}`);
  searchInput.addEventListener("input", () => {
    const term = searchInput.value.trim();
    state.search[type.key] = term;
    clearTimeout(searchTimers[type.key]);
    searchTimers[type.key] = setTimeout(() => fetchParts(type.key, term), 600);
  });

  // Nav
  card.querySelector(`#prev-${type.key}`).addEventListener("click", () => navigatePart(type.key, -1));
  card.querySelector(`#next-${type.key}`).addEventListener("click", () => navigatePart(type.key,  1));

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
    if (state.nextUrl[partKey]) {
      fetchParts(partKey, state.search[partKey], true, state.nextUrl[partKey]);
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
  const allParts  = state.parts[partKey];
  const visible   = getVisibleParts(partKey);
  const selected  = state.selected[partKey];
  const isLoading = state.loading[partKey];
  const hasMore   = !!state.nextUrl[partKey];

  // Part count
  const countEl = document.getElementById(`count-${partKey}`);
  if (countEl) {
    const total    = allParts.length + (hasMore ? "+" : "");
    const filtered = state.subcat[partKey] !== "All" || state.standardOnly;
    countEl.textContent = filtered
      ? `${visible.length} / ${total} parts`
      : `${allParts.length}${hasMore ? "+" : ""} parts`;
  }

  // Nav button state
  const prevBtn = document.getElementById(`prev-${partKey}`);
  const nextBtn = document.getElementById(`next-${partKey}`);
  if (prevBtn) prevBtn.disabled = !visible.length;
  if (nextBtn) nextBtn.disabled = !visible.length;

  // Part strip
  const strip = document.getElementById(`strip-${partKey}`);
  if (!strip) return;
  strip.innerHTML = "";

  if (!visible.length && !isLoading) {
    strip.innerHTML = `<div class="empty-msg">No parts in this category</div>`;
  }

  for (const part of visible) {
    const isSelected = selected?.part_num === part.part_num;
    const isStd      = isStandardPart(partKey, part);
    const hasFusion  = (part._p?.fusion?.length ?? 0) > 0;

    const thumb = document.createElement("div");
    thumb.className = [
      "part-thumb",
      isSelected  ? "selected"     : "",
      !isStd      ? "special-part" : "",
    ].filter(Boolean).join(" ");
    thumb.title = part.name;

    // Small "+" badge on fused parts (Hair and Helmet, Costume / Mask, etc.)
    const fusionBadge = hasFusion
      ? `<span class="fusion-dot" title="${escapeHtml("+" + part._p.fusion.join(", "))}">+</span>`
      : "";

    thumb.innerHTML = `
      <img src="${part.part_img_url}" alt="${escapeHtml(part.name)}" loading="lazy">
      ${fusionBadge}`;

    thumb.addEventListener("click", () => {
      state.selected[partKey] = part;
      renderSelector(partKey);
      renderPreview(); renderSummary(); checkCompatibility();
    });
    thumb.querySelector("img").addEventListener("error", e => e.target.style.display = "none");
    strip.appendChild(thumb);
  }

  if (isLoading) {
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

    // Badge: "Hair · + Helmet · Pattern"
    const subcat  = getSubcategoryLabel(partKey, selected);
    const fusion  = selected._p?.fusion ?? [];
    const deco    = selected._p?.decoration;
    const badgeParts = [subcat];
    if (fusion.length)             badgeParts.push(`+ ${fusion.join(", ")}`);
    if (deco && deco !== "Plain")  badgeParts.push(deco);
    badgeEl.textContent = badgeParts.join(" · ");
    badgeEl.className   = isStandardPart(partKey, selected)
      ? "part-badge badge-std"
      : "part-badge badge-special";
  } else if (infoEl) {
    infoEl.style.display = "none";
  }

  // Variant row — show all prints/patterns sharing the same base mold
  const variantEl = document.getElementById(`variants-${partKey}`);
  const chipsEl   = document.getElementById(`variantChips-${partKey}`);

  if (selected && variantEl && chipsEl) {
    const baseId   = selected._n?.baseId;
    const siblings = baseId ? (state.groups[partKey]?.[baseId] ?? []) : [];

    if (siblings.length > 1) {
      variantEl.style.display = "block";
      chipsEl.innerHTML = "";

      for (const sib of siblings) {
        const chip = document.createElement("button");
        chip.className = "variant-chip" + (sib.part_num === selected.part_num ? " active" : "");
        // Label: variantSuffix (e.g. "pr0001") or decoration word or part_num
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

    const badgeParts = subcat ? [subcat] : [];
    if (fusion.length)             badgeParts.push("+" + fusion[0]);
    if (deco && deco !== "Plain")  badgeParts.push(deco);

    const item = document.createElement("div");
    item.className = "summary-item";
    item.innerHTML = `
      <span>${type.icon}</span>
      <span class="summary-text">${escapeHtml(name)}</span>
      ${badgeParts.length
        ? `<span class="summary-badge">${escapeHtml(badgeParts.join(" · "))}</span>`
        : ""}`;
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
