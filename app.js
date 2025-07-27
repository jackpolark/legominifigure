const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 50;

const CATEGORIES = {
  hair: 63,
  head: 60,
  torso: 61,
  legs: 59
};

const selectedIndex = {
  hair: 0,
  head: 0,
  torso: 0,
  legs: 0
};

const partsCache = {
  hair: [],
  head: [],
  torso: [],
  legs: []
};

const nextUrl = {
  hair: null,
  head: null,
  torso: null,
  legs: null
};

const rateLimit = (() => {
  const MIN_MS = 1100;
  let last = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, MIN_MS - (now - last));
    if (wait) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
  };
})();

async function apiFetch(url, tries = 0) {
  await rateLimit();
  const res = await fetch(url, {
    headers: { Authorization: `key ${API_KEY}` }
  });

  if (res.status === 429) {
    const backoffMs = Math.min(5000, 500 * (tries + 1));
    console.warn(`429 throttled, retrying in ${backoffMs}ms...`);
    await new Promise(r => setTimeout(r, backoffMs));
    return apiFetch(url, tries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function loadFirstPage(partType) {
  const partCatId = CATEGORIES[partType];
  const url = `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${partCatId}&page_size=${PAGE_SIZE}&inc_color_details=0`;
  await loadPage(partType, url);
}

async function loadPage(partType, url) {
  const data = await apiFetch(url);
  const withImages = (data.results || []).filter(p => p.part_img_url);
  partsCache[partType].push(...withImages);
  nextUrl[partType] = data.next;

  if (partsCache[partType].length && selectedIndex[partType] === 0) {
    updatePartImage(partType);
  }
}

async function ensureLoaded(partType, index) {
  while (index >= partsCache[partType].length && nextUrl[partType]) {
    await loadPage(partType, nextUrl[partType]);
  }
}

async function nextPart(partType) {
  const current = selectedIndex[partType] + 1;
  await ensureLoaded(partType, current);

  selectedIndex[partType] = current >= partsCache[partType].length ? 0 : current;
  updatePartImage(partType);
}

async function prevPart(partType) {
  const current = selectedIndex[partType] - 1;
  selectedIndex[partType] = current < 0
    ? Math.max(0, partsCache[partType].length - 1)
    : current;
  updatePartImage(partType);
}

function updatePartImage(partType) {
  const part = partsCache[partType][selectedIndex[partType]];
  if (!part) return;

  // Update main preview stack
  const previewImg = document.getElementById(`preview-${partType}`);
  if (previewImg) previewImg.src = part.part_img_url;

  // Update the carousel view image
  const carouselImg = document.getElementById(`${partType}-view`);
  if (carouselImg) carouselImg.src = part.part_img_url;
}

async function init() {
  await Promise.all(Object.keys(CATEGORIES).map(loadFirstPage));
}

// Make functions available to buttons
window.nextPart = nextPart;
window.prevPart = prevPart;
window.init = init;

init().catch(console.error);
