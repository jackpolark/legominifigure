const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";

// These are the correct Rebrickable category IDs:
const CATEGORIES = {
  hair: 63,   // Minifig Headgear
  head: 60,   // Minifig Heads
  torso: 61,  // Minifig Torso Assembly
  legs: 59    // Minifig Lower Body
};

// Fetch all parts from a given category and display them
async function fetchPartsByCategory(categoryId, partType) {
  const url = `https://rebrickable.com/api/v3/lego/parts/?category_id=${categoryId}&page_size=100&key=${API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    displayParts(data.results, partType);
  } catch (error) {
    console.error(`Error fetching ${partType} parts:`, error);
  }
}

// Display parts in the corresponding scrollable selector
function displayParts(parts, partType) {
  const container = document.getElementById(`${partType}-selector`);
  container.innerHTML = "";

  parts.forEach(part => {
    if (!part.part_img_url) return;

    const img = document.createElement("img");
    img.src = part.part_img_url;
    img.alt = part.name;
    img.className = "part-img";

    img.onclick = () => selectPart(partType, part.part_img_url);
    container.appendChild(img);
  });
}

// Save and display selected parts on the minifigure preview
const selectedParts = {
  hair: null,
  head: null,
  torso: null,
  legs: null
};

function selectPart(type, imgUrl) {
  selectedParts[type] = imgUrl;
  document.getElementById(`${type}-view`).src = imgUrl;
}

// Load all categories when the page starts
function init() {
  for (const [type, id] of Object.entries(CATEGORIES)) {
    fetchPartsByCategory(id, type);
  }
}

init();
