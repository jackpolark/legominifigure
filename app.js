const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";

const CATEGORIES = {
  head: 60,
  hair: 63,
  torso: 61,
  legs: 59
};

async function fetchPartsByCategory(categoryId, partType) {
  const url = `https://rebrickable.com/api/v3/lego/parts/?category_id=${categoryId}&page_size=100&key=${API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  displayParts(data.results, partType);
}

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

const selectedParts = {
  head: null,
  hair: null,
  torso: null,
  legs: null
};

function selectPart(type, imgUrl) {
  selectedParts[type] = imgUrl;
  document.getElementById(`${type}-view`).src = imgUrl;
}

function init() {
  for (const [type, id] of Object.entries(CATEGORIES)) {
    fetchPartsByCategory(id, type);
  }
}

init();
