const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 50;

const CATEGORIES = {
  hair: 64,
  head: 65,
  torso: 60,
  legs: 61
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

function logDebug(partType, message) {
  const debugEl = document.getElementById(`${partType}-debug`);
  if (debugEl) {
    debugEl.textContent += message + "\n";
  }
  console.log(message);
}

async function apiFetch(url, tries = 0) {
  await rateLimit();
  console.log(`🔄 Fetching URL: ${url}`);
  const res = await fetch(url, {
    headers: { Authorization: `key ${API_KEY}` }
  });

  if (res.status === 429) {
    const backoffMs = Math.min(5000, 500 * (tries + 1));
    console.warn(`🚫 429 Too Many Requests. Retrying in ${backoffMs}ms...`);
    await new Promise(r => setTimeout(r, backoffMs));
    return apiFetch(url, tries + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ HTTP Error: ${res.status} - ${text}`);
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function loadFirstPage(partType) {
  const partCatId = CATEGORIES[partType];
  const url = `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${partCatId}&page_size=${PAGE_SIZE}&inc_color_details=0`;
  logDebug(partType, `📦 Loading first page (cat_id=${partCatId})`);
  await loadPage(partType, url);
}

async function loadPage(partType, url) {
  const data = await apiFetch(url);
  const raw = data.results || [];
  logDebug(partType, `📥 Received ${raw.length} parts`);

  raw.forEach(p => {
    logDebug(partType, `  🧩 ${p.part_num} | ${p.name} | cat_id: ${p.part_cat_id}`);
  });

  const withImages = raw.filter(p => {
    const nm = p.name.toLowerCase();
    if (!p.part_img_url) return false;
    if (partType === 'hair' && nm.includes('arm')) return false;
    if (partType === 'head' && nm.includes('arm')) return false;
    if (partType === 'torso' && (nm.includes('leg') || nm.includes('skirt'))) return false;
    if (partType === 'legs' && nm.includes('torso')) return false;
    return true;
  });

  const filteredOut = raw.length - withImages.length;
  withImages.forEach(p => {
    logDebug(partType, `✅ Included: ${p.part_num} | ${p.name}`);
  });

  if (filteredOut > 0) {
    logDebug(partType, `⚠️ Filtered OUT ${filteredOut} parts`);
  }

  logDebug(partType, `✅ Filtered ${withImages.length}/${raw.length} valid images`);
  partsCache[partType].push(...withImages);
  nextUrl[partType] = data.next;

  if (partsCache[partType].length && selectedIndex[partType] === 0) {
    logDebug(partType, `🎯 Displaying first part`);
    updatePartImage(partType);
  } else if (partsCache[partType].length === 0) {
    logDebug(partType, `⚠️ No valid parts loaded`);
  }
}

async function ensureLoaded(partType, index) {
  while (index >= partsCache[partType].length && nextUrl[partType]) {
    logDebug(partType, `🔄 Loading more parts...`);
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
  if (!part) {
    logDebug(partType, `⚠️ No part at index ${selectedIndex[partType]}`);
    return;
  }

  logDebug(partType, `🖼️ Displaying: ${part.part_num} | ${part.name}`);

  const previewImg = document.getElementById(`preview-${partType}`);
  if (previewImg) previewImg.src = part.part_img_url;

  const carouselImg = document.getElementById(`${partType}-view`);
  if (carouselImg) carouselImg.src = part.part_img_url;

  const infoEl = document.getElementById(`${partType}-info`);
  if (infoEl) {
    infoEl.textContent = `ID: ${part.part_num} | ${part.name} | cat_id: ${part.part_cat_id || "?"}`;
  }
}

async function init() {
  const orderedKeys = ['hair', 'head', 'torso', 'legs'];
  console.log(`🚀 Starting initialization...`);
  for (const partType of orderedKeys) {
    await loadFirstPage(partType);
  }
  console.log(`✅ Initialization complete.`);
}

window.nextPart = nextPart;
window.prevPart = prevPart;
window.init = init;

init().catch(err => console.error(`💥 Init error: ${err.message}`));
