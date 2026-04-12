import { useState, useEffect, useCallback, useRef } from "react";

const API_KEY = "34e4c4ff2ec36a7a20f30f484a11f0af";
const PAGE_SIZE = 40;

const PART_TYPES = [
  { key: "hair", catId: 65, label: "Headwear", icon: "👒" },
  { key: "head", catId: 59, label: "Head", icon: "🙂" },
  { key: "torso", catId: 60, label: "Torso", icon: "👕" },
  { key: "legs", catId: 61, label: "Legs", icon: "👖" },
];

// Rate limiter: 1 req/sec with burst protection
function createRateLimiter() {
  let lastCall = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  };
}

const rateLimiter = createRateLimiter();

async function apiFetch(url, retries = 0) {
  await rateLimiter();
  const res = await fetch(url, {
    headers: { Authorization: `key ${API_KEY}` },
  });
  if (res.status === 429) {
    const backoff = Math.min(8000, 1500 * (retries + 1));
    await new Promise((r) => setTimeout(r, backoff));
    return apiFetch(url, retries + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function PartSelector({ type, selected, onSelect, parts, loading, onLoadMore, hasMore, searchTerm, onSearch }) {
  const scrollRef = useRef(null);
  const selectedRef = useRef(null);

  useEffect(() => {
    if (selectedRef.current) {
      selectedRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [selected]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 200) {
      onLoadMore();
    }
  }, [loading, hasMore, onLoadMore]);

  return (
    <div style={styles.selectorCard}>
      <div style={styles.selectorHeader}>
        <span style={styles.selectorIcon}>{type.icon}</span>
        <span style={styles.selectorLabel}>{type.label}</span>
        <span style={styles.partCount}>
          {parts.length} parts{hasMore ? "+" : ""}
        </span>
      </div>

      <div style={styles.searchRow}>
        <input
          type="text"
          placeholder={`Search ${type.label.toLowerCase()}...`}
          value={searchTerm}
          onChange={(e) => onSearch(e.target.value)}
          style={styles.searchInput}
        />
      </div>

      <div style={styles.carouselContainer}>
        <button
          style={styles.navBtn}
          onClick={() => {
            const idx = parts.findIndex((p) => p.part_num === selected?.part_num);
            if (idx > 0) onSelect(parts[idx - 1]);
          }}
          disabled={!selected || parts.findIndex((p) => p.part_num === selected?.part_num) <= 0}
        >
          ‹
        </button>

        <div ref={scrollRef} onScroll={handleScroll} style={styles.partStrip}>
          {parts.map((part) => {
            const isSelected = selected?.part_num === part.part_num;
            return (
              <div
                key={part.part_num}
                ref={isSelected ? selectedRef : null}
                onClick={() => onSelect(part)}
                style={{
                  ...styles.partThumb,
                  ...(isSelected ? styles.partThumbSelected : {}),
                }}
              >
                <img
                  src={part.part_img_url}
                  alt={part.name}
                  style={styles.partThumbImg}
                  loading="lazy"
                  onError={(e) => {
                    e.target.style.display = "none";
                  }}
                />
              </div>
            );
          })}
          {loading && (
            <div style={styles.loadingDot}>
              <div style={styles.spinner} />
            </div>
          )}
          {parts.length === 0 && !loading && (
            <div style={styles.emptyMsg}>No parts found</div>
          )}
        </div>

        <button
          style={styles.navBtn}
          onClick={() => {
            const idx = parts.findIndex((p) => p.part_num === selected?.part_num);
            if (idx < parts.length - 1) onSelect(parts[idx + 1]);
            else if (hasMore) onLoadMore();
          }}
          disabled={!selected || (!hasMore && parts.findIndex((p) => p.part_num === selected?.part_num) >= parts.length - 1)}
        >
          ›
        </button>
      </div>

      {selected && (
        <div style={styles.partInfo}>
          <span style={styles.partName}>{selected.name}</span>
          <span style={styles.partId}>#{selected.part_num}</span>
        </div>
      )}
    </div>
  );
}

export default function MinifigCustomizer() {
  const [partsData, setPartsData] = useState({
    hair: [], head: [], torso: [], legs: [],
  });
  const [selectedParts, setSelectedParts] = useState({
    hair: null, head: null, torso: null, legs: null,
  });
  const [loading, setLoading] = useState({
    hair: false, head: false, torso: false, legs: false,
  });
  const [searchTerms, setSearchTerms] = useState({
    hair: "", head: "", torso: "", legs: "",
  });
  const [nextUrls, setNextUrls] = useState({
    hair: null, head: null, torso: null, legs: null,
  });
  const [initState, setInitState] = useState("loading"); // loading, ready, error
  const [errorMsg, setErrorMsg] = useState("");
  const searchTimers = useRef({});
  const abortControllers = useRef({});

  const fetchParts = useCallback(async (partKey, catId, search = "", append = false, url = null) => {
    // Cancel previous fetch for this part type
    if (abortControllers.current[partKey]) {
      abortControllers.current[partKey].abort();
    }
    const controller = new AbortController();
    abortControllers.current[partKey] = controller;

    setLoading((prev) => ({ ...prev, [partKey]: true }));

    try {
      const fetchUrl =
        url ||
        `https://rebrickable.com/api/v3/lego/parts/?part_cat_id=${catId}&page_size=${PAGE_SIZE}&inc_color_details=0${search ? `&search=${encodeURIComponent(search)}` : ""}`;

      const data = await apiFetch(fetchUrl);

      if (controller.signal.aborted) return;

      const results = (data.results || []).filter((p) => p.part_img_url);

      setPartsData((prev) => ({
        ...prev,
        [partKey]: append ? [...prev[partKey], ...results] : results,
      }));

      setNextUrls((prev) => ({ ...prev, [partKey]: data.next }));

      // Auto-select first part if none selected or fresh search
      if (!append && results.length > 0) {
        setSelectedParts((prev) => ({ ...prev, [partKey]: results[0] }));
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`Error fetching ${partKey}:`, err);
      }
    } finally {
      if (!controller.signal.aborted) {
        setLoading((prev) => ({ ...prev, [partKey]: false }));
      }
    }
  }, []);

  // Initial load — sequential to respect rate limit
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        for (const type of PART_TYPES) {
          if (cancelled) return;
          await fetchParts(type.key, type.catId);
        }
        if (!cancelled) setInitState("ready");
      } catch (err) {
        if (!cancelled) {
          setInitState("error");
          setErrorMsg(err.message);
        }
      }
    }
    init();
    return () => { cancelled = true; };
  }, [fetchParts]);

  const handleSearch = useCallback(
    (partKey, term) => {
      setSearchTerms((prev) => ({ ...prev, [partKey]: term }));
      clearTimeout(searchTimers.current[partKey]);
      searchTimers.current[partKey] = setTimeout(() => {
        const type = PART_TYPES.find((t) => t.key === partKey);
        fetchParts(partKey, type.catId, term);
      }, 600);
    },
    [fetchParts]
  );

  const handleLoadMore = useCallback(
    (partKey) => {
      const url = nextUrls[partKey];
      if (!url || loading[partKey]) return;
      const type = PART_TYPES.find((t) => t.key === partKey);
      fetchParts(partKey, type.catId, searchTerms[partKey], true, url);
    },
    [nextUrls, loading, searchTerms, fetchParts]
  );

  const randomize = useCallback(() => {
    PART_TYPES.forEach(({ key }) => {
      const parts = partsData[key];
      if (parts.length > 0) {
        const rand = parts[Math.floor(Math.random() * parts.length)];
        setSelectedParts((prev) => ({ ...prev, [key]: rand }));
      }
    });
  }, [partsData]);

  if (initState === "loading") {
    return (
      <div style={styles.loadingScreen}>
        <style>{fontImport}{spinnerKeyframes}</style>
        <div style={styles.loadingBrick}>
          <div style={styles.loadingSpinner} />
          <p style={styles.loadingText}>Loading minifig parts...</p>
          <p style={styles.loadingSubtext}>Connecting to Rebrickable API</p>
        </div>
      </div>
    );
  }

  if (initState === "error") {
    return (
      <div style={styles.loadingScreen}>
        <style>{fontImport}</style>
        <div style={styles.loadingBrick}>
          <p style={{ fontSize: 32 }}>⚠️</p>
          <p style={styles.loadingText}>Connection Error</p>
          <p style={styles.loadingSubtext}>{errorMsg}</p>
          <button
            style={{ ...styles.randomBtn, marginTop: 16 }}
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <style>{fontImport}{spinnerKeyframes}</style>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logoRow}>
            <div style={styles.stud} />
            <div style={styles.stud} />
            <h1 style={styles.title}>Minifig Builder</h1>
            <div style={styles.stud} />
            <div style={styles.stud} />
          </div>
          <p style={styles.subtitle}>
            Mix & match from thousands of official LEGO parts
          </p>
        </div>
      </header>

      <div style={styles.main}>
        {/* Preview Column */}
        <div style={styles.previewCol}>
          <div style={styles.previewCard}>
            <h3 style={styles.previewTitle}>Your Minifig</h3>
            <div style={styles.previewStack}>
              {PART_TYPES.map(({ key, label }) => (
                <div key={key} style={styles.previewSlot}>
                  {selectedParts[key] ? (
                    <img
                      src={selectedParts[key].part_img_url}
                      alt={label}
                      style={styles.previewImg}
                    />
                  ) : (
                    <div style={styles.previewPlaceholder}>
                      <span style={styles.placeholderText}>?</span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <button onClick={randomize} style={styles.randomBtn}>
              🎲 Randomize
            </button>

            {/* Selected parts summary */}
            <div style={styles.summaryList}>
              {PART_TYPES.map(({ key, label, icon }) => (
                <div key={key} style={styles.summaryItem}>
                  <span>{icon}</span>
                  <span style={styles.summaryText}>
                    {selectedParts[key]
                      ? selectedParts[key].name.length > 28
                        ? selectedParts[key].name.substring(0, 28) + "…"
                        : selectedParts[key].name
                      : `No ${label}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Selectors Column */}
        <div style={styles.selectorsCol}>
          {PART_TYPES.map((type) => (
            <PartSelector
              key={type.key}
              type={type}
              selected={selectedParts[type.key]}
              onSelect={(part) =>
                setSelectedParts((prev) => ({ ...prev, [type.key]: part }))
              }
              parts={partsData[type.key]}
              loading={loading[type.key]}
              onLoadMore={() => handleLoadMore(type.key)}
              hasMore={!!nextUrls[type.key]}
              searchTerm={searchTerms[type.key]}
              onSearch={(term) => handleSearch(type.key, term)}
            />
          ))}
        </div>
      </div>

      <footer style={styles.footer}>
        Powered by{" "}
        <a href="https://rebrickable.com" target="_blank" rel="noreferrer" style={styles.footerLink}>
          Rebrickable API
        </a>{" "}
        — LEGO® is a trademark of the LEGO Group
      </footer>
    </div>
  );
}

const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap');
`;

const spinnerKeyframes = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  /* Custom scrollbar for part strips */
  .part-strip::-webkit-scrollbar {
    height: 6px;
  }
  .part-strip::-webkit-scrollbar-track {
    background: transparent;
  }
  .part-strip::-webkit-scrollbar-thumb {
    background: #d4d4d4;
    border-radius: 3px;
  }
`;

const C = {
  yellow: "#FDD835",
  yellowDark: "#F9C80E",
  red: "#E3000B",
  redDark: "#C50009",
  blue: "#006CB7",
  white: "#FFFFFF",
  offWhite: "#FFF8E1",
  gray100: "#F5F5F5",
  gray200: "#EEEEEE",
  gray300: "#E0E0E0",
  gray500: "#9E9E9E",
  gray700: "#616161",
  gray900: "#212121",
  shadow: "0 2px 12px rgba(0,0,0,0.08)",
  shadowHover: "0 4px 20px rgba(0,0,0,0.12)",
};

const styles = {
  container: {
    fontFamily: "'Fredoka', 'Nunito', sans-serif",
    background: `linear-gradient(135deg, ${C.offWhite} 0%, #FFF3C4 50%, ${C.offWhite} 100%)`,
    minHeight: "100vh",
    color: C.gray900,
  },
  header: {
    background: C.red,
    padding: "20px 24px",
    color: C.white,
    boxShadow: "0 4px 16px rgba(227, 0, 11, 0.3)",
  },
  headerInner: {
    maxWidth: 1100,
    margin: "0 auto",
    textAlign: "center",
  },
  logoRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  stud: {
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.25)",
    border: "2px solid rgba(255,255,255,0.4)",
    flexShrink: 0,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    margin: 0,
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.85,
    margin: "6px 0 0",
    fontWeight: 400,
  },
  main: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "24px 16px",
    display: "flex",
    gap: 24,
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  previewCol: {
    flex: "0 0 220px",
    position: "sticky",
    top: 24,
  },
  previewCard: {
    background: C.white,
    borderRadius: 16,
    padding: 20,
    boxShadow: C.shadow,
    textAlign: "center",
    border: `3px solid ${C.yellow}`,
  },
  previewTitle: {
    margin: "0 0 16px",
    fontSize: 16,
    fontWeight: 600,
    color: C.gray700,
    textTransform: "uppercase",
    letterSpacing: "1px",
  },
  previewStack: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    marginBottom: 16,
  },
  previewSlot: {
    width: 100,
    height: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  previewImg: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.15))",
  },
  previewPlaceholder: {
    width: 70,
    height: 70,
    borderRadius: 12,
    background: C.gray200,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `2px dashed ${C.gray300}`,
  },
  placeholderText: {
    fontSize: 24,
    color: C.gray500,
    fontWeight: 600,
  },
  randomBtn: {
    background: C.blue,
    color: C.white,
    border: "none",
    borderRadius: 10,
    padding: "10px 20px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "'Fredoka', sans-serif",
    width: "100%",
    transition: "transform 0.15s, box-shadow 0.15s",
    boxShadow: "0 3px 0 #004E8A",
  },
  summaryList: {
    marginTop: 16,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  summaryItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 11,
    color: C.gray700,
    textAlign: "left",
    padding: "4px 8px",
    background: C.gray100,
    borderRadius: 6,
  },
  summaryText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
  },
  selectorsCol: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  selectorCard: {
    background: C.white,
    borderRadius: 16,
    padding: "16px 20px",
    boxShadow: C.shadow,
  },
  selectorHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  selectorIcon: {
    fontSize: 20,
  },
  selectorLabel: {
    fontSize: 17,
    fontWeight: 600,
    flex: 1,
  },
  partCount: {
    fontSize: 12,
    color: C.gray500,
    fontWeight: 500,
  },
  searchRow: {
    marginBottom: 12,
  },
  searchInput: {
    width: "100%",
    padding: "8px 14px",
    borderRadius: 10,
    border: `2px solid ${C.gray200}`,
    fontSize: 13,
    fontFamily: "'Fredoka', sans-serif",
    outline: "none",
    transition: "border-color 0.2s",
    boxSizing: "border-box",
    background: C.gray100,
  },
  carouselContainer: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    border: `2px solid ${C.gray200}`,
    background: C.white,
    fontSize: 20,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    color: C.gray700,
    transition: "all 0.15s",
    fontFamily: "sans-serif",
    padding: 0,
    lineHeight: 1,
  },
  partStrip: {
    display: "flex",
    gap: 8,
    overflowX: "auto",
    overflowY: "hidden",
    padding: "4px 2px",
    flex: 1,
    minHeight: 76,
    alignItems: "center",
    scrollBehavior: "smooth",
    className: "part-strip",
  },
  partThumb: {
    width: 68,
    height: 68,
    flexShrink: 0,
    borderRadius: 10,
    border: `2px solid ${C.gray200}`,
    background: C.white,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "all 0.15s",
    padding: 4,
    boxSizing: "border-box",
  },
  partThumbSelected: {
    border: `3px solid ${C.red}`,
    boxShadow: `0 0 0 2px rgba(227, 0, 11, 0.2)`,
    transform: "scale(1.05)",
  },
  partThumbImg: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
  },
  loadingDot: {
    width: 68,
    height: 68,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    width: 24,
    height: 24,
    border: `3px solid ${C.gray200}`,
    borderTopColor: C.red,
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  emptyMsg: {
    color: C.gray500,
    fontSize: 13,
    padding: "20px 0",
    textAlign: "center",
    width: "100%",
  },
  partInfo: {
    marginTop: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: C.offWhite,
    borderRadius: 8,
    fontSize: 12,
  },
  partName: {
    flex: 1,
    fontWeight: 500,
    color: C.gray900,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  partId: {
    color: C.gray500,
    fontWeight: 400,
    flexShrink: 0,
  },
  footer: {
    textAlign: "center",
    padding: "20px 16px",
    fontSize: 12,
    color: C.gray500,
  },
  footerLink: {
    color: C.blue,
    textDecoration: "none",
    fontWeight: 500,
  },
  loadingScreen: {
    fontFamily: "'Fredoka', sans-serif",
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: `linear-gradient(135deg, ${C.offWhite} 0%, #FFF3C4 100%)`,
  },
  loadingBrick: {
    textAlign: "center",
    padding: 40,
  },
  loadingSpinner: {
    width: 48,
    height: 48,
    border: `4px solid ${C.gray200}`,
    borderTopColor: C.red,
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
    margin: "0 auto 20px",
  },
  loadingText: {
    fontSize: 20,
    fontWeight: 600,
    color: C.gray900,
    margin: "0 0 6px",
  },
  loadingSubtext: {
    fontSize: 14,
    color: C.gray500,
    margin: 0,
  },
};
