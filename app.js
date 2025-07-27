const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 50; // Tune this. 25–100 is a good range.

/**
 * Official Rebrickable category IDs for minifig parts
 * https://rebrickable.com/api/v3/
 */
const CATEGORIES = {
  hair: 63,   // Minifig Headgear
  head: 60,   // Minifig Heads
  torso: 61,  // Minifig Torso Assembly
  legs: 59    // Minifig Lower Body
};

// Holds currently selected index per part type
const selectedIndex = {
  hair: 0,
  head: 0,
  torso: 0,
  legs: 0
};

// In-memory cache of parts already fetched
const partsCache = {
  hair: [],
  head: [],
  torso: [],
  legs: []
};

// Keeps track of the Rebrickable "next" URL for each type
const nextUrl = {
  hair: null,
  head: null,
  torso: null,
  legs: null
};

// ---- polite rate limiter (1 req/sec) ----
const rateLimit = (() => {
  const MIN_MS = 1100; // just over 1s to be safe
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, MIN_MS - (now - last));
    if (wait) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
})();

// ---- generic fetch with auth header + simple 429 backoff ----
async function apiFetch(url, tries = 0) {
  await rateLimit();

  const res = await fetch(url, {
    headers: {
      Authorization: `key ${API_KEY}`
    }
  });

  if (res.status === 429) {
    // Too fast — backoff a little and retry
    const backoffMs = Math.min(5000, 500 * (tries + 1));
    console.warn(`429 throttled, backing off for ${backoffMs}ms...`);
    await new Promise(r => setTimeout(r, backoffMs));
    return apiFetch(url, tries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

// Load the first page for a given part type
async function loadFirstPage(partType) {
  const partCatId = CATEGORIES[partType];
  const url = `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${partCatId}&page_size=${PAGE_SIZE}&inc_color_details=0`;
  await loadPage(partType, url);
}

// Load (and cache) whatever `url` points to for that type
async function loadPage(partType, url) {
  const data = await apiFetch(url);

  const withImages = (data.results || []).filter(p => p.part_img_url);
  partsCache[partType].push(...withImages);

  // Rebrickable gives you the absolute URL for the next page (or null)
  nextUrl[partType] = data.next;

  // If this is the very first load for this type, display the first item
  if (partsCache[partType].length && selectedIndex[partType] === 0) {
    updatePartImage(partType);
  }
}

// Ensure we have at least `index+1` items cached for `partType`
async function ensureLoaded(partType, index) {
  while (index >= partsCache[partType].length && nextUrl[partType]) {
    await loadPage(partType, nextUrl[partType]);
  }
}

// Public UI actions
export async function nextPart(partType) {
  const current = selectedIndex[partType] + 1;
  await ensureLoaded(partType, current);

  // If we still don't have that index, wrap around
  if (current >= partsCache[partType].length) {
    selectedIndex[partType] = 0;
  } else {
    selectedIndex[partType] = current;
  }

  updatePartImage(partType);
}

export async function prevPart(partType) {
  const current = selectedIndex[partType] - 1;
  if (current < 0) {
    // Go to (loaded) last. We don't fetch previous pages; wrap within current cache.
    selectedIndex[partType] = Math.max(0, partsCache[partType].length - 1);
  } else {
    selectedIndex[partType] = current;
  }
  updatePartImage(partType);
}

// Replace this with your own DOM/image update logic
function updatePartImage(partType) {
  const part = partsCache[partType][selectedIndex[partType]];
  const imgEl = document.getElementById(`${partType}-img`);
  const nameEl = document.getElementById(`${partType}-name`);
  if (!part) return;

  if (imgEl) imgEl.src = part.part_img_url;
  if (nameEl) nameEl.textContent = `${part.part_num} — ${part.name}`;
}

// Initialize: load the first page for each part type,
// but don’t fetch anything else until the user asks for it.
export async function init() {
  await Promise.all(Object.keys(CATEGORIES).map(loadFirstPage));
}

init().catch(err => console.error(err));
