/* ============================================================
   OFFLINE PARTS CATALOG
   ============================================================
   Rebrickable publishes a full CSV dump of every LEGO part
   (updated daily), fetched through our Cloudflare Worker proxy
   rather than cdn.rebrickable.com directly — the CDN doesn't
   reliably grant this browser CORS, and routing it through the
   Worker also means Cloudflare's edge caches the (large, only
   changes once/day) file, so repeat visitors and dev reloads
   don't each pull a fresh copy from Rebrickable's origin.

   On first visit we download + decompress that file in the
   browser, filter it down to our 4 categories (headwear, head,
   torso, legs), and stash the result in IndexedDB. Every later
   visit reads instantly from IndexedDB — no API calls, no rate
   limit, no "0 parts" flash — while a fresh copy is pulled down
   quietly in the background once the local snapshot is a day old.

   Alongside it we download elements.csv — Rebrickable's dump of
   every part+color combination LEGO has actually produced (a
   part isn't itself colored; an "element" is a specific part
   molded in a specific color, same idea as BrickLink listing a
   part's known colors). That's what drives the color filter:
   without it, a part only shows up under a color if the color
   happens to be spelled out in its name, which most headwear/hair
   pieces never do.

   The CSV has no images, so part photos still come from the
   Rebrickable API — but now that's a *progressive enhancement*
   (skeleton → photo) instead of a blocker for showing parts at
   all. Image URLs are cached in IndexedDB too, once learned.

   If the CSV can't be fetched (e.g. offline, or an old browser
   without DecompressionStream), init() simply resolves with empty
   arrays and app.js falls back to the live-API pagination path
   for that category (capped — see MAX_BACKGROUND_PAGES in app.js).
   ============================================================ */

const Catalog = (() => {
  const DB_NAME    = "lmb_offline_db";
  const DB_VERSION = 1;
  const STORE_CATALOG = "catalog";
  const STORE_IMAGES  = "images";
  const STORE_META    = "meta";

  const CSV_URL          = "https://legominifigure-rebrickable-proxy.jackpolark.workers.dev/catalog/parts.csv.gz";
  const ELEMENTS_CSV_URL = "https://legominifigure-rebrickable-proxy.jackpolark.workers.dev/catalog/elements.csv.gz";
  const CATEGORY_IDS = { hair: 65, head: 59, torso: 60, legs: 61 };
  const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;      // re-download once a day
  const USE_STALE_UP_TO_MS = 7 * REFRESH_AFTER_MS;   // but keep using old data for a week if refresh fails

  // ── IndexedDB helpers (all failures degrade to "no persistence", never throw) ──
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CATALOG)) db.createObjectStore(STORE_CATALOG);
        if (!db.objectStoreNames.contains(STORE_IMAGES))  db.createObjectStore(STORE_IMAGES);
        if (!db.objectStoreNames.contains(STORE_META))    db.createObjectStore(STORE_META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(store, key) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx  = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    } catch { return undefined; }
  }

  async function idbSet(store, key, value) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } catch { /* best-effort only */ }
  }

  async function idbSetMany(store, entries) {
    if (!entries.length) return;
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        for (const [k, v] of entries) os.put(v, k);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } catch { /* best-effort only */ }
  }

  async function idbForEach(store, fn) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx  = db.transaction(store, "readonly");
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) { fn(cursor.key, cursor.value); cursor.continue(); }
          else resolve();
        };
        req.onerror = () => reject(req.error);
      });
    } catch { /* best-effort only */ }
  }

  // ── CSV parsing (RFC4180-ish: handles quoted fields, embedded commas/quotes) ──
  function parseCsv(text) {
    const rows = [];
    let field = "", row = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ""; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === '\r') { /* skip, \n follows */ }
      else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  async function fetchGunzipText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream unsupported in this browser");
    }
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  function buildCatalogFromCsvRows(rows) {
    if (!rows.length) return null;
    const header  = rows[0];
    const numCol  = header.indexOf("part_num");
    const nameCol = header.indexOf("name");
    const catCol  = header.indexOf("part_cat_id");
    if (numCol === -1 || nameCol === -1 || catCol === -1) return null;

    const catToKey = {};
    for (const [key, id] of Object.entries(CATEGORY_IDS)) catToKey[id] = key;

    const byKey = { hair: [], head: [], torso: [], legs: [] };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length <= catCol || !r[numCol]) continue;
      const key = catToKey[Number(r[catCol])];
      if (!key) continue;
      byKey[key].push({ part_num: r[numCol], name: r[nameCol], part_cat_id: Number(r[catCol]) });
    }
    return byKey;
  }

  // elements.csv rows are element_id,part_num,color_id,design_id — one row
  // per real-world mold+color combination LEGO has produced. Filtered down
  // to only the part_nums we actually track (the full file covers every
  // part LEGO has ever made, ~110k rows) and collapsed to part_num -> a
  // de-duped list of color_ids.
  function buildPartColorsFromCsvRows(rows, knownPartNums) {
    if (!rows.length) return null;
    const header  = rows[0];
    const numCol   = header.indexOf("part_num");
    const colorCol = header.indexOf("color_id");
    if (numCol === -1 || colorCol === -1) return null;

    const byPart = {};
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length <= colorCol || !r[numCol]) continue;
      const partNum = r[numCol];
      if (!knownPartNums.has(partNum)) continue;
      const colorId = Number(r[colorCol]);
      if (!Number.isFinite(colorId)) continue;
      (byPart[partNum] ??= []);
      if (!byPart[partNum].includes(colorId)) byPart[partNum].push(colorId);
    }
    return byPart;
  }

  async function downloadCatalog() {
    const text = await fetchGunzipText(CSV_URL);
    const rows = parseCsv(text);
    const byKey = buildCatalogFromCsvRows(rows);
    if (!byKey) throw new Error("Unexpected parts.csv format");

    const knownPartNums = new Set(Object.values(byKey).flat().map(p => p.part_num));
    let partColors = {};
    try {
      const elementsText = await fetchGunzipText(ELEMENTS_CSV_URL);
      const elementsRows = parseCsv(elementsText);
      partColors = buildPartColorsFromCsvRows(elementsRows, knownPartNums) ?? {};
    } catch (e) {
      // Non-fatal: the app still works, just without per-part color filtering
      // until a later refresh succeeds.
      console.warn("Could not load elements.csv (per-part colors unavailable):", e);
    }

    return { byKey, partColors };
  }

  // ── In-memory state, populated by init() ──
  const memCatalog     = { hair: [], head: [], torso: [], legs: [] };
  const memPartColors  = {}; // part_num -> [color_id, ...]
  const memImages      = new Map(); // part_num -> img url
  const updateListeners = new Set();
  const colorUpdateListeners = new Set();
  let colorsReady = false;

  function onUpdate(fn) { updateListeners.add(fn); }
  function notify(partKey, info) {
    for (const fn of updateListeners) { try { fn(partKey, info); } catch (e) { console.error(e); } }
  }

  // Fires once per-part color data first becomes available, and again on
  // every later refresh — so app.js can invalidate its color-dropdown cache
  // without needing to know or poll our internal load timing.
  function onColorsUpdate(fn) {
    colorUpdateListeners.add(fn);
    if (colorsReady) fn();
  }
  function notifyColors() {
    colorsReady = true;
    for (const fn of colorUpdateListeners) { try { fn(); } catch (e) { console.error(e); } }
  }

  async function persistCatalog({ byKey, partColors }) {
    for (const [key, list] of Object.entries(byKey)) await idbSet(STORE_CATALOG, key, list);
    await idbSet(STORE_META, "part_colors", partColors);
    await idbSet(STORE_META, "catalog_meta", { fetchedAt: Date.now() });
  }

  let refreshing = false;
  async function refreshInBackground() {
    if (refreshing) return;
    refreshing = true;
    try {
      const fresh = await downloadCatalog();
      for (const key of Object.keys(memCatalog)) {
        const knownNums = new Set(memCatalog[key].map(p => p.part_num));
        const added = fresh.byKey[key].filter(p => !knownNums.has(p.part_num));
        memCatalog[key] = fresh.byKey[key];
        if (added.length) notify(key, { added });
      }
      if (Object.keys(fresh.partColors).length) {
        Object.assign(memPartColors, fresh.partColors);
        notifyColors();
      }
      await persistCatalog(fresh);
    } catch (e) {
      console.warn("Background catalog refresh failed (keeping existing snapshot):", e);
    } finally {
      refreshing = false;
    }
  }

  async function init() {
    await idbForEach(STORE_IMAGES, (partNum, url) => memImages.set(partNum, url));

    const meta = await idbGet(STORE_META, "catalog_meta");
    const usableCache = meta && (Date.now() - meta.fetchedAt < USE_STALE_UP_TO_MS);

    if (usableCache) {
      for (const key of Object.keys(memCatalog)) {
        const cached = await idbGet(STORE_CATALOG, key);
        if (cached?.length) memCatalog[key] = cached;
      }
      const cachedColors = await idbGet(STORE_META, "part_colors");
      if (cachedColors && Object.keys(cachedColors).length) {
        Object.assign(memPartColors, cachedColors);
        notifyColors();
      }
    }

    const haveAny = Object.values(memCatalog).some(a => a.length);

    if (!haveAny) {
      // First-ever visit (or cache expired past the stale grace period): nothing
      // to seed synchronously, so kick off the download in the background rather
      // than blocking init() on it (the full CSV — every category, not just
      // ours — can take several seconds to fetch+decompress+parse). app.js falls
      // back to live-API paging for now and upgrades via onUpdate() once this
      // resolves.
      refreshInBackground();
    } else if (!meta || Date.now() - meta.fetchedAt > REFRESH_AFTER_MS) {
      refreshInBackground(); // don't block first paint
    }

    return memCatalog;
  }

  // ── Images ──
  function getImage(partNum) { return memImages.get(partNum); }

  function setImages(entries) { // [[part_num, url], ...]
    const toPersist = [];
    for (const [num, url] of entries) {
      if (!url || memImages.get(num) === url) continue;
      memImages.set(num, url);
      toPersist.push([num, url]);
    }
    idbSetMany(STORE_IMAGES, toPersist);
  }

  // ── New-part reconciliation ──
  // Folds any part_num from a live API response that isn't in the offline
  // snapshot yet (e.g. added to Rebrickable after our CSV was downloaded).
  // Returns the added entries directly — unlike refreshInBackground(), this
  // is always driven by an explicit caller (applyImageResults in app.js),
  // so it does NOT also fire onUpdate(); doing both would double-apply it.
  function reconcile(partKey, apiParts) {
    const known = memCatalog[partKey];
    const knownSet = new Set(known.map(p => p.part_num));
    const added = [];
    for (const p of apiParts) {
      if (!p.part_img_url || knownSet.has(p.part_num)) continue;
      knownSet.add(p.part_num);
      const entry = { part_num: p.part_num, name: p.name, part_cat_id: p.part_cat_id, _new: true };
      known.push(entry);
      added.push(entry);
    }
    if (added.length) idbSet(STORE_CATALOG, partKey, known);
    return added;
  }

  function getParts(partKey) { return memCatalog[partKey]; }

  // ── Colors ──
  // Real colors a part_num has actually been produced in (from elements.csv),
  // as Rebrickable color_ids. Empty/undefined means "unknown" — the part
  // hasn't shown up in an elements.csv row yet (e.g. added very recently) —
  // not "colorless"; callers should treat that as no data rather than zero.
  function getPartColorIds(partNum) { return memPartColors[partNum]; }

  return { init, onUpdate, getImage, setImages, reconcile, getParts, refreshInBackground, onColorsUpdate, getPartColorIds };
})();
