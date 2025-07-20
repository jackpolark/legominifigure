const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";

const CATEGORIES = {
  hair: 63,
  head: 60,
  torso: 61,
  legs: 59
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

async function fetchPartsByCategory(categoryId, partType) {
  const url = `https://rebrickable.com/api/v3/lego/parts/?category_id=${categoryId}&page_size=100&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();

    // Filter to only parts with images and typical size
    const cleanParts = data.results.filter(p => p.part_img_url && !p.part_img_url.includes('blank') && p.name.length > 0);

    partsData[partType] = cleanParts;
    updatePartImage(partType);
  } catch (error) {
    console.error(`Failed to load ${partType} parts`, error);
  }
}

function updatePartImage(type) {
  const view = document.getElementById(`${type}-view`);
  const part = partsData[type][selectedIndex[type]];
  if (part && view) {
    view.src = part.part_img_url;
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
  for (const [type, id] of Object.entries(CATEGORIES)) {
    fetchPartsByCategory(id, type);
  }
}

init();
