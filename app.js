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

// ✅ Updated: Get Star Wars set numbers
async function fetchSetNumsByTheme(themeId) {
  const url = `https://rebrickable.com/api/v3/lego/sets/?theme_id=${themeId}&page_size=100&key=${API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.results.map(set => set.set_num);
}

// ✅ Clean: Fetch part details from a given set
async function fetchPartsFromSet(setNum) {
  const url = `https://rebrickable.com/api/v3/lego/sets/${setNum}/parts/?page_size=1000&key=${API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.results.filter(p => p.part?.part_img_url); // Filter for parts with images
}

// ✅ Main loader for Star Wars minifig parts only
async function loadThemeParts() {
  const setNums = await fetchSetNumsByTheme(THEME_ID);

  const categoryParts = {
    hair: [],
    head: [],
    torso: [],
    legs: []
  };

  for (const setNum of setNums) {
    const parts = await fetchPartsFromSet(setNum);

    for (const part of parts) {
      const cat = part.part.part_cat_id;
      const img = part.part.part_img_url;
      if (!img) continue;

      if (cat === CATEGORIES.hair) categoryParts.hair.push(part.part);
      else if (cat === CATEGORIES.head) categoryParts.head.push(part.part);
      else if (cat === CATEGORIES.torso) categoryParts.torso.push(part.part);
      else if (cat === CATEGORIES.legs) categoryParts.legs.push(part.part);
    }
  }

  for (const type of Object.keys(categoryParts)) {
    partsData[type] = categoryParts[type];
    selectedIndex[type] = 0;
    updatePartImage(type);
  }
}

// ✅ UI Rendering
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
