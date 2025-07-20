const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";

// Correct category IDs for each body part
const CATEGORIES = {
  hair: 63,   // Headgear
  head: 60,   // Heads
  torso: 61,  // Torsos
  legs: 59    // Legs
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

// Fetch parts for a given category
async function fetchPartsByCategory(categoryId, partType) {
  const url = `https://rebrickable.com/api/v3/lego/parts/?category_id=${categoryId}&page_size=100&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();

    // Only use parts with images
    const partsWithImages = data.results.filter(part => part.part_img_url);
    partsData[partType] = partsWithImages;

    // Display the first part by default
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
  for (const [type, categoryId] of Object.entries(CATEGORIES)) {
    fetchPartsByCategory(categoryId, type);
  }
}

init();
