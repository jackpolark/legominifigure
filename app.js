const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";

// Correct category IDs for each body part
const CATEGORIES = {
  hair: 63,   // Minifig Headgear
  head: 60,   // Minifig Heads
  torso: 61,  // Minifig Torso Assembly
  legs: 59    // Minifig Lower Body
};

// Store current data and page index
const partsData = {
  hair: [],
  head: [],
  torso: [],
  legs: []
};

const currentPage = {
  hair: 1,
  head: 1,
  torso: 1,
  legs: 1
};

const selectedIndex = {
  hair: 0,
  head: 0,
  torso: 0,
  legs: 0
};

// Fetch a single part for a given category (by page)
async function fetchSinglePartByCategory(partCatId, partType, page = 1) {
  const url = `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${partCatId}&page=${page}&page_size=1&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.results.length > 0) {
      const part = data.results[0];
      if (part.part_img_url) {
        partsData[partType] = [part]; // Keep only the single fetched part
        selectedIndex[partType] = 0;
        updatePartImage(partType);
      } else {
        // If no image, skip to next page
        currentPage[partType]++;
        fetchSinglePartByCategory(partCatId, partType, currentPage[partType]);
      }
    }
  } catch (err) {
    console.error(`Failed to fetch ${partType} part:`, err);
  }
}

// Go to next part
function nextPart(partType) {
  currentPage[partType]++;
  fetchSinglePartByCategory(CATEGORIES[partType], partType, currentPage[partType]);
}

// Display function
function updatePartImage(partType) {
  const part = partsData[partType][selectedIndex[partType]];
  const imgElement = document.getElementById(`${partType}-image`);
  if (imgElement && part) {
    imgElement.src = part.part_img_url;
  }
}

// Initialize (fetch first part for each category)
function init() {
  for (const [type, partCatId] of Object.entries(CATEGORIES)) {
    fetchSinglePartByCategory(partCatId, type);
  }
}

init();
