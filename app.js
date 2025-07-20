const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";

// Official Rebrickable category IDs for minifig parts
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

// ✅ CORRECTED: use part_cat_id instead of category_id
async function fetchPartsByCategory(partCatId, partType) {
  const url = `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${partCatId}&page_size=100&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();

    // Only use parts that have images
    const partsWithImages = data.results.filter(part => part.part_img_url);
    partsData[partType] = partsWithImages;

    // Initialize with the first part
    selectedIndex[partType] = 0;
    updatePartImage(partType);
  } catch (err) {
    console.error(`Error loading ${partType}:`, err);
  }
}

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
  for (const [type, partCatId] of Object.entries(CATEGORIES)) {
    fetchPartsByCategory(partCatId, type);
  }
}

init();
