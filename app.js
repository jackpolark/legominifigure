const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const THEME_ID = 18; // Star Wars

const CATEGORIES = {
  hair: 63,   // Minifig Headgear
  head: 60,   // Minifig Heads
  torso: 61,  // Minifig Torso Assembly
  legs: 59    // Minifig Lower Body
};

const partsData = {
  hair: [],
  head: [],
  torso: [],
  legs: []
};

const selectedIndex = {
  hair: 0,
  head: 0,
  torso: 0,
  legs: 0
};

// ✅ Get minifigs under the Star Wars theme
async function fetchStarWarsMinifigs() {
  const url = `https://rebrickable.com/api/v3/lego/minifigs/?in_theme_id=${THEME_ID}&page_size=100&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.results.map(fig => fig.set_num); // like sw001
}

// ✅ Get the parts that make up each minifig
async function fetchPartsFromMinifig(minifigNum) {
  const url = `https://rebrickable.com/api/v3/lego/minifigs/${minifigNum}/parts/?page_size=1000&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.results.filter(p =>
    p.part.element_img_url && Object.values(CATEGORIES).includes(p.part.part_cat_id)
  );
}

// ✅ Main loader
async function loadThemeParts() {
  const minifigNums = await fetchStarWarsMinifigs();

  const categoryParts = {
    hair: [],
    head: [],
    torso: [],
    legs: []
  };

  for (const minifigNum of minifigNums) {
    const parts = await fetchPartsFromMinifig(minifigNum);

    for (const p of parts) {
      const cat = p.part.part_cat_id;
      const img = p.part.part_img_url;
      const part = p.part;

      if (!img) continue;

      if (cat === CATEGORIES.hair) categoryParts.hair.push(part);
      else if (cat === CATEGORIES.head) categoryParts.head.push(part);
      else if (cat === CATEGORIES.torso) categoryParts.torso.push(part);
      else if (cat === CATEGORIES.legs) categoryParts.legs.push(part);
    }
  }

  for (const type of Object.keys(categoryParts)) {
    partsData[type] = categoryParts[type];
    selectedIndex[type] = 0;
    updatePartImage(type);
  }
}

// ✅ UI rendering
function updatePartImage(type) {
  const part = partsData[type][selectedIndex[type]];
  if (part) {
    document.getElementById(`${type}-view`).src = part.part_img_url;
    const url = part.element_img_url || part.part_img_url;
    const preview = document.getElementById(`preview-${type}`);
    if (preview) preview.src = part.part_img_url;
  }
}

function prevPart(type) {
  if (partsData[type].length === 0) return;
  selectedIndex[type] = (selectedIndex[type] - 1 + partsData[type].length) % partsData[type].length;
  updatePartImage(type);
}

function nextPart(type) {
  if (partsData[type].length === 0) return;
  selectedIndex[type] = (selectedIndex[type] + 1) % partsData[type].length;
  updatePartImage(type);
}

function init() {
  loadThemeParts();
}

init();
const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const THEME_ID = 18; // Star Wars

const CATEGORIES = {
  hair: 63,   // Minifig Headgear
  head: 60,   // Minifig Heads
  torso: 61,  // Minifig Torso Assembly
  legs: 59    // Minifig Lower Body
};

const partsData = {
  hair: [],
  head: [],
  torso: [],
  legs: []
};

const selectedIndex = {
  hair: 0,
  head: 0,
  torso: 0,
  legs: 0
};

// ✅ Get minifigs under the Star Wars theme
async function fetchStarWarsMinifigs() {
  const url = `https://rebrickable.com/api/v3/lego/minifigs/?in_theme_id=${THEME_ID}&page_size=100&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.results.map(fig => fig.set_num); // like sw001
}

// ✅ Get the parts that make up each minifig
async function fetchPartsFromMinifig(minifigNum) {
  const url = `https://rebrickable.com/api/v3/lego/minifigs/${minifigNum}/parts/?page_size=1000&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.results.filter(p =>
    p.part &&
    p.part.part_img_url &&
    Object.values(CATEGORIES).includes(p.part.part_cat_id)
  );
}

// ✅ Main loader
async function loadThemeParts() {
  const minifigNums = await fetchStarWarsMinifigs();

  const categoryParts = {
    hair: [],
    head: [],
    torso: [],
    legs: []
  };

  for (const minifigNum of minifigNums) {
    const parts = await fetchPartsFromMinifig(minifigNum);

    for (const p of parts) {
      const cat = p.part.part_cat_id;
      const img = p.part.part_img_url;
      const part = p.part;

      if (!img) continue;

      if (cat === CATEGORIES.hair) categoryParts.hair.push(part);
      else if (cat === CATEGORIES.head) categoryParts.head.push(part);
      else if (cat === CATEGORIES.torso) categoryParts.torso.push(part);
      else if (cat === CATEGORIES.legs) categoryParts.legs.push(part);
    }
  }

  for (const type of Object.keys(categoryParts)) {
    partsData[type] = categoryParts[type];
    selectedIndex[type] = 0;
    updatePartImage(type);
  }
}

// ✅ UI rendering
function updatePartImage(type) {
  const part = partsData[type][selectedIndex[type]];
  if (part) {
    document.getElementById(`${type}-view`).src = part.part_img_url;
    const preview = document.getElementById(`preview-${type}`);
    if (preview) preview.src = part.part_img_url;
  }
}

function prevPart(type) {
  if (partsData[type].length === 0) return;
  selectedIndex[type] = (selectedIndex[type] - 1 + partsData[type].length) % partsData[type].length;
  updatePartImage(type);
}

function nextPart(type) {
  if (partsData[type].length === 0) return;
  selectedIndex[type] = (selectedIndex[type] + 1) % partsData[type].length;
  updatePartImage(type);
}

function init() {
  loadThemeParts();
}

init();

