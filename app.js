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

async function fetchStarWarsSetNums() {
  const url = `https://rebrickable.com/api/v3/lego/sets/?theme_id=${THEME_ID}&page_size=20&key=${API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.results.map(set => set.set_num);
}

async function fetchPartsFromSet(setNum) {
  const url = `https://rebrickable.com/api/v3/lego/sets/${setNum}/parts/?page_size=1000&inc_part_details=1&key=${API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  return data.results.filter(p =>
    p.part &&
    p.part.part_img_url &&
    Object.values(CATEGORIES).includes(p.part.part_cat_id)
  );
}

async function loadThemeParts() {
  const setNums = await fetchStarWarsSetNums();

  const categoryParts = {
    hair: [],
    head: [],
    torso: [],
    legs: []
  };

  for (const setNum of setNums) {
    const parts = await fetchPartsFromSet(setNum);

    for (const partObj of parts) {
      const part = partObj.part;
      const cat = part.part_cat_id;
      const img = part.part_img_url;

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
