import { bestAreas, bestRoute, directionsUrl, filterGroups, formatKm, haversineKm } from "./geo.js";

const KEY_STORAGE = "wsig.mapsApiKey";
const GROUP_COLORS = ["#1a73e8", "#e8710a", "#188038", "#a142f4", "#d93025", "#12b5cb", "#f9ab00", "#e52592"];
// Language/region for map labels, autocomplete and place results.
// zh-TW = Traditional Chinese; TW biases results and formatting toward Taiwan.
const MAPS_LANGUAGE = "zh-TW";
const MAPS_REGION = "TW";
// Extra Google Maps details, fetched only for the places chosen in the selected plan.
const DETAIL_FIELDS = [
  "photos",
  "rating",
  "userRatingCount",
  "priceLevel",
  "primaryTypeDisplayName",
  "editorialSummary",
  "businessStatus",
  "regularOpeningHours",
  "utcOffsetMinutes",
  "nationalPhoneNumber",
  "websiteURI",
  "googleMapsURI",
];
const PRICE_LEVELS = { FREE: "免費", INEXPENSIVE: "$", MODERATE: "$$", EXPENSIVE: "$$$", VERY_EXPENSIVE: "$$$$" };
const PLACE_FIELDS = ["id", "displayName", "formattedAddress", "location", "rating", "googleMapsURI"];
const MAX_SEARCHES = 6;
const MAX_AREAS = 5;
const PLACES_PER_TYPE = 5;
// One-tap category chips shown under the search bar.
const SUGGESTIONS = ["餐廳", "咖啡廳", "甜點", "拉麵", "便利商店", "書店", "公園", "景點", "酒吧"];

const ICONS = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V4h1V2H7v2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3"/></svg>',
  block: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2M4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.9 7.9 0 0 1 4 12m8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.9 7.9 0 0 1 20 12c0 4.42-3.58 8-8 8"/></svg>',
  directions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.71 11.29l-9-9a1 1 0 0 0-1.42 0l-9 9a1 1 0 0 0 0 1.42l9 9a1 1 0 0 0 1.42 0l9-9a1 1 0 0 0 0-1.42M14 14.5V12h-4v3H8v-4c0-.55.45-1 1-1h5V7.5l3.5 3.5z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2m0 15-5-2.18L7 18V5h10z"/></svg>',
  bookmarked: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>',
};

const $ = (id) => document.getElementById(id);

const state = {
  start: null, // { name, address, lat, lng, placeId }
  searches: [], // { query, color, places: [...] }
  excluded: new Map(), // placeId -> place: never use in plans
  pinned: new Map(), // placeId -> place: only use these for their search
  stops: [], // [{ name, address, lat, lng, placeId }]
  areas: null, // results of bestAreas(), plus `choice` (chosen index per group)
  groups: null, // filtered groups the areas index into
  areaSel: 0,
  popupOpen: false, // the selected area's popup is showing over the map
  lastRoute: null,
  markers: [],
  overlays: [],
};

let map;
let lib = {};
const isPhone = () => matchMedia("(max-width: 760px)").matches;
const segValue = (id) => $(id).dataset.value;
const unitsValue = () => segValue("units");

// ---------- storage (wrapped: may be blocked in private mode) ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- boot ----------
function showKeySetup() {
  $("key-setup").hidden = false;
  $("app").hidden = true;
  $("key-form").onsubmit = (e) => {
    e.preventDefault();
    const value = $("key-input").value.trim();
    if (!value) return;
    store.set(KEY_STORAGE, value);
    location.reload();
  };
}

function loadMapsScript(apiKey) {
  return new Promise((resolve, reject) => {
    window.__wsigMapsReady = resolve;
    window.gm_authFailure = () => {
      setStatus("Google 拒絕了這組 API 金鑰。請確認金鑰正確，且已啟用所需的 API。", true);
    };
    const s = document.createElement("script");
    s.src =
      "https://maps.googleapis.com/maps/api/js?" +
      new URLSearchParams({
        key: apiKey,
        v: "weekly",
        loading: "async",
        language: MAPS_LANGUAGE,
        region: MAPS_REGION,
        callback: "__wsigMapsReady",
      });
    s.async = true;
    s.onerror = () => reject(new Error("無法載入 Google 地圖。"));
    document.head.append(s);
  });
}

async function boot(apiKey) {
  $("app").hidden = false;
  setupChrome();

  try {
    await loadMapsScript(apiKey);
    const [{ Map, Polyline, Circle }, { Place, PlaceAutocompleteElement }, { AdvancedMarkerElement, PinElement }, { LatLngBounds, ColorScheme }] =
      await Promise.all([
        google.maps.importLibrary("maps"),
        google.maps.importLibrary("places"),
        google.maps.importLibrary("marker"),
        google.maps.importLibrary("core"),
      ]);
    lib = { Map, Polyline, Circle, Place, PlaceAutocompleteElement, AdvancedMarkerElement, PinElement, LatLngBounds, ColorScheme };
    createMap({ lat: 25.0478, lng: 121.517 }, 14); // 台北車站
    navigator.geolocation?.getCurrentPosition(
      (pos) => moveMap(() => map.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude })),
      () => {},
      { timeout: 5000 },
    );
  } catch (err) {
    setStatus(err.message, true);
    return;
  }

  setupAutocomplete($("start-slot"), (place) => {
    state.start = place;
    afterStartChange();
    moveMap(() => map.panTo(place));
  });
  setupAutocomplete($("stop-slot"), (place) => {
    if (state.stops.some((s) => s.placeId === place.placeId)) return;
    state.stops.push(place);
    renderStops();
  });
}

/** Wire up everything that doesn't need the Maps library. */
function setupChrome() {
  $("change-key").onclick = () => {
    store.del(KEY_STORAGE);
    location.href = location.pathname;
  };
  $("search-form").onsubmit = (e) => {
    e.preventDefault();
    addSearch($("search-input").value.trim());
  };
  $("search-here").onclick = onSearchHere;
  $("clear-filters").onclick = () => {
    state.excluded.clear();
    state.pinned.clear();
    afterFilterChange();
  };
  $("plan-route").onclick = onPlanRoute;

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => selectTab(tab.dataset.tab);
  });

  // Segmented controls in the menu drawer (travel mode, units, theme).
  $("theme").dataset.value = themeSetting();
  darkQuery.addEventListener?.("change", () => themeSetting() === "auto" && applyTheme());
  applyTheme();
  for (const id of ["travel-mode", "units", "theme"]) {
    const seg = $(id);
    const sync = () => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === seg.dataset.value)));
    seg.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        seg.dataset.value = b.dataset.value;
        sync();
        if (id === "theme") setTheme(b.dataset.value);
        else rerender();
      };
    });
    sync();
  }

  // Menu drawer
  const drawer = $("drawer");
  const setDrawer = (open) => {
    drawer.hidden = !open;
    $("menu-btn").setAttribute("aria-expanded", String(open));
  };
  $("menu-btn").onclick = () => setDrawer(true);
  drawer.querySelectorAll("[data-close]").forEach((el) => (el.onclick = () => setDrawer(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!drawer.hidden) setDrawer(false);
    else if (state.popupOpen) closePopup();
  });

  // Desktop: collapse the side panel. Phone: draggable bottom sheet.
  $("panel-toggle").onclick = () => {
    const closed = $("app").classList.toggle("panel-closed");
    $("panel-toggle").setAttribute("aria-expanded", String(!closed));
    $("panel-toggle").setAttribute("aria-label", closed ? "展開側邊面板" : "收合側邊面板");
  };
  setupSheet();
  renderChips();
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
    t.setAttribute("aria-selected", String(t.dataset.tab === name));
  });
  $("tab-combo").hidden = name !== "combo";
  $("tab-stops").hidden = name !== "stops";
  $("tab-saved").hidden = name !== "saved";
  $("search-here").hidden = true;
  closePopup();
  setStatus("");
  if (name === "combo") showAreasOrSearches();
  else if (name === "saved") {
    clearMap();
    renderSaved();
  } else renderStops();
}

// ---------- map + theme ----------
const THEME_STORAGE = "wsig.theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
/** "auto" (follow the system), "light" or "dark". */
const themeSetting = () => document.documentElement.dataset.theme || "auto";
const isDark = () => (themeSetting() === "auto" ? darkQuery.matches : themeSetting() === "dark");
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Create (or re-create) the map. The map's colour scheme can only be set when it is
 * created, so switching between light and dark builds a new map in the same place.
 */
function createMap(center, zoom) {
  const scheme = isDark() ? "DARK" : "LIGHT";
  if (map && map.__scheme === scheme) return;
  $("map").replaceChildren();
  map = new lib.Map($("map"), {
    center,
    zoom,
    mapId: "DEMO_MAP_ID",
    colorScheme: lib.ColorScheme?.[scheme] ?? scheme,
    disableDefaultUI: true,
    zoomControl: !isPhone(),
    zoomControlOptions: { position: google.maps.ControlPosition?.RIGHT_BOTTOM },
    gestureHandling: "greedy",
  });
  map.__scheme = scheme;
  // Offer "search this area" when the user (not the app) moves the map.
  map.addListener("dragend", onUserMovedMap);
  map.addListener("zoom_changed", () => {
    if (!programmaticMove) onUserMovedMap();
  });
  map.addListener("idle", () => (programmaticMove = false));
  // Clicking empty map closes the area popup (clicks on circles don't reach the map).
  map.addListener("click", () => state.popupOpen && closePopup());
}

/** Apply a theme change to the page and, if needed, rebuild the map and redraw it. */
function applyTheme() {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isDark() ? "#202124" : "#ffffff");
  if (!map) return;
  const before = map.__scheme;
  const c = map.getCenter();
  createMap({ lat: c.lat(), lng: c.lng() }, map.getZoom());
  if (map.__scheme === before) return;
  // Markers and shapes belong to the old map: draw them again on the new one.
  state.markers = [];
  state.overlays = [];
  if (!$("tab-combo").hidden) {
    if (state.areas?.length) drawAreas({ fit: false });
    else if (state.searches.length) showSearchResults({ fit: false });
    else if (state.start) addStartMarker();
  } else if (state.lastRoute && $("route-results").childElementCount) {
    drawRoute(state.lastRoute.visit, { fit: false });
  } else if ($("tab-saved").hidden) {
    renderStops({ fit: false });
  }
}

function setTheme(value) {
  if (value === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  if (value === "auto") store.del(THEME_STORAGE);
  else store.set(THEME_STORAGE, value);
  applyTheme();
}

// ---------- bottom sheet (phones) ----------
const SHEET_STOPS = { peek: 0.18, half: 0.45, full: 1 };

function sheetHeights() {
  const app = $("app").clientHeight;
  // Full height stops just under the chips row, so the handle stays reachable.
  const top = $("chips").getBoundingClientRect().bottom - $("app").getBoundingClientRect().top + 8;
  return { peek: Math.max(132, app * SHEET_STOPS.peek), half: app * SHEET_STOPS.half, full: app - top };
}

function setSheet(name) {
  const sheet = $("sheet");
  sheet.dataset.state = name;
  sheet.style.setProperty("--sheet-h", `${sheetHeights()[name]}px`);
}

function setupSheet() {
  const sheet = $("sheet");
  const grips = [$("sheet-handle"), sheet.querySelector(".tabs")];
  let drag = null;

  const onDown = (e) => {
    if (!isPhone()) return;
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection while dragging
    drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false, target: e.currentTarget, id: e.pointerId };
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) {
      drag.moved = true;
      sheet.classList.add("dragging");
    }
    const { peek, full } = sheetHeights();
    sheet.style.setProperty("--sheet-h", `${Math.min(full, Math.max(peek * 0.8, drag.h - dy))}px`);
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, target } = drag;
    drag = null;
    // Let the click that ends a drag see the "dragging" class, then clear it.
    setTimeout(() => sheet.classList.remove("dragging"), 0);
    if (!moved) {
      // A tap on the handle cycles the sheet; taps on the tabs just switch tabs.
      if (target.id === "sheet-handle") setSheet({ peek: "half", half: "full", full: "peek" }[sheet.dataset.state] || "half");
      return;
    }
    // Snap to the nearest stop.
    const h = sheet.getBoundingClientRect().height;
    const stops = sheetHeights();
    const nearest = Object.keys(stops).reduce((a, b) => (Math.abs(stops[a] - h) <= Math.abs(stops[b] - h) ? a : b));
    setSheet(nearest);
  };
  grips.forEach((g) => g.addEventListener("pointerdown", onDown));
  // Track the drag on the window so it continues once the finger leaves the handle.
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onUp);
  // Swallow the click that follows a drag on the tabs.
  sheet.querySelector(".tabs").addEventListener("click", (e) => sheet.classList.contains("dragging") && e.stopPropagation(), true);
  $("sheet-handle").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSheet({ peek: "half", half: "full", full: "peek" }[sheet.dataset.state] || "half");
    }
  });
  addEventListener("resize", () => isPhone() && setSheet(sheet.dataset.state || "half"));
  if (isPhone()) setSheet("half");
}

// ---------- autocomplete ----------
function setupAutocomplete(slot, onPick) {
  const el = new lib.PlaceAutocompleteElement();
  slot.append(el);

  const handle = async (place) => {
    try {
      await place.fetchFields({ fields: PLACE_FIELDS });
      onPick(toPlain(place));
    } catch (err) {
      setStatus(`無法載入這個地點：${err.message}`, true);
    }
  };
  // Current event name, plus the older one for compatibility.
  el.addEventListener("gmp-select", (e) => handle(e.placePrediction.toPlace()));
  el.addEventListener("gmp-placeselect", (e) => handle(e.place));
}

function toPlain(place) {
  return {
    placeId: place.id,
    name: place.displayName || place.formattedAddress || "未命名地點",
    address: place.formattedAddress || "",
    lat: place.location.lat(),
    lng: place.location.lng(),
    rating: place.rating ?? null,
    url: place.googleMapsURI || null,
  };
}

// ---------- chips under the search bar ----------
function renderChips() {
  const box = $("chips");
  const chips = [];
  if (state.start) {
    const c = document.createElement("span");
    c.className = "chip start";
    c.innerHTML = `${ICONS.home}<span class="label"></span><button class="x" type="button" aria-label="移除起點">${ICONS.close}</button>`;
    c.querySelector(".label").textContent = state.start.name;
    c.querySelector(".x").onclick = () => {
      state.start = null;
      afterStartChange();
    };
    chips.push(c);
  }
  state.searches.forEach((s, i) => {
    const c = document.createElement("span");
    c.className = "chip active";
    c.innerHTML = `<span class="dot"></span><span class="label"></span><span class="count"></span><button class="x" type="button">${ICONS.close}</button>`;
    c.querySelector(".dot").style.background = s.color;
    c.querySelector(".label").textContent = s.query;
    c.querySelector(".count").textContent = s.places.length;
    c.querySelector(".x").setAttribute("aria-label", `移除「${s.query}」`);
    c.querySelector(".x").onclick = () => removeSearch(i);
    chips.push(c);
  });
  const taken = new Set(state.searches.map((s) => s.query));
  if (state.searches.length < MAX_SEARCHES) {
    SUGGESTIONS.filter((q) => !taken.has(q)).forEach((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = q;
      b.onclick = () => addSearch(q);
      chips.push(b);
    });
  }
  box.replaceChildren(...chips);
}

// ---------- mode 1: nearby areas ----------
/**
 * Text search. `area` is { locationBias } to prefer the visible map, or
 * { locationRestriction } to only return places inside it.
 */
async function searchPlaces(query, area) {
  // Newer Maps JS versions renamed Place.searchText to Place.searchByText.
  const search = lib.Place.searchByText ?? lib.Place.searchText;
  const { places } = await search.call(lib.Place, {
    textQuery: query,
    fields: PLACE_FIELDS,
    language: MAPS_LANGUAGE,
    region: MAPS_REGION,
    maxResultCount: 20,
    ...area,
  });
  return (places || []).map(toPlain);
}

async function addSearch(query) {
  if (!query || !map) return;
  selectTab("combo");
  if (state.searches.some((s) => s.query === query)) {
    setStatus(`已經加入「${query}」了。`);
    return;
  }
  if (state.searches.length >= MAX_SEARCHES) {
    setStatus(`最多只能組合 ${MAX_SEARCHES} 種地點。`, true);
    return;
  }
  setStatus(`正在搜尋「${query}」…`);
  try {
    const places = await searchPlaces(query, { locationBias: map.getBounds() });
    if (!places.length) {
      setStatus(`這附近找不到「${query}」。請試著移動地圖或換個關鍵字。`, true);
      return;
    }
    const color = GROUP_COLORS[state.searches.length % GROUP_COLORS.length];
    state.searches.push({ query, color, places });
    $("search-input").value = "";
    $("search-input").blur();
    afterSearchesChange(`找到 ${places.length} 個「${query}」。`);
  } catch (err) {
    setStatus(`搜尋失敗：${err.message}`, true);
  }
}

function removeSearch(i) {
  state.searches.splice(i, 1);
  state.searches.forEach((g, j) => (g.color = GROUP_COLORS[j % GROUP_COLORS.length]));
  afterSearchesChange("");
}

function afterSearchesChange(msg) {
  renderChips();
  if (!state.searches.length) $("search-here").hidden = true;
  computeAreas({ msg, fit: true });
}

// ---------- "search this area" ----------
let programmaticMove = false;

/** Run a map move made by the app, so it doesn't show the "search this area" button. */
function moveMap(fn) {
  programmaticMove = true;
  // Fallback in case the move doesn't change the view and no "idle" event follows.
  setTimeout(() => (programmaticMove = false), 1500);
  fn();
}

function onUserMovedMap() {
  $("search-here").hidden = $("tab-combo").hidden || !state.searches.length;
}

/** Re-run every current search, limited to the visible map area. */
async function onSearchHere() {
  const btn = $("search-here");
  btn.disabled = true;
  setStatus("正在此區域重新搜尋…");
  try {
    const bounds = map.getBounds();
    const results = await Promise.all(
      state.searches.map((s) => searchPlaces(s.query, { locationRestriction: bounds })),
    );
    state.searches.forEach((s, i) => (s.places = results[i]));
    btn.hidden = true;
    renderChips();
    const empty = state.searches.filter((s) => !s.places.length).map((s) => `「${s.query}」`);
    computeAreas({
      fit: false,
      msg: empty.length
        ? `此區域找不到 ${empty.join("、")}。請移動地圖或縮小地圖再試一次。`
        : `已更新此區域的結果：${state.searches.map((s) => `${s.query} ${s.places.length} 個`).join("、")}。`,
      error: empty.length > 0,
    });
  } catch (err) {
    setStatus(`搜尋失敗：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

/** Group the current search results into area plans and show them. */
function computeAreas({ msg = "", fit = true, error = false, keepSelection = false } = {}) {
  $("combo-intro").hidden = state.searches.length > 0;
  if (!state.searches.length) {
    state.areas = null;
    $("combo-results").replaceChildren();
    clearMap();
    if (state.start) addStartMarker();
    setStatus(msg, error);
    return;
  }
  const groups = filterGroups(
    state.searches.map((s) => s.places),
    { excluded: new Set(state.excluded.keys()), pinned: new Set(state.pinned.keys()) },
  );
  const empty = state.searches.filter((_, i) => !groups[i].length).map((s) => `「${s.query}」`);
  if (empty.length) {
    state.areas = null;
    $("combo-results").replaceChildren();
    showSearchResults({ fit });
    setStatus(error ? msg : `${empty.join("、")} 沒有可用的地點，請移除一些篩選或移動地圖。`, true);
    return;
  }
  const prevSel = state.areaSel;
  state.groups = groups;
  state.areas = bestAreas(groups, { start: state.start, limit: MAX_AREAS, perGroup: PLACES_PER_TYPE });
  state.areas.forEach((a) => (a.choice = a.picks.slice()));
  state.areaSel = keepSelection ? Math.min(prevSel, state.areas.length - 1) : 0;
  if (!keepSelection || !state.areas.length) closePopup();
  if (!state.areas.length) {
    $("combo-results").replaceChildren();
    showSearchResults({ fit });
    setStatus("找不到可以組成區域的地點。", true);
    return;
  }
  renderAreas({ fit: fit ? "all" : false });
  const summary = `找到 ${state.areas.length} 個區域，每個方案列出區域內相近的同類型地點。`;
  setStatus(msg ? (error ? msg : `${msg}${summary}`) : summary, error);
}

function showAreasOrSearches() {
  if (state.areas?.length) renderAreas({ fit: false });
  else if (state.searches.length) showSearchResults({ fit: false });
  else clearMap();
}

function showSearchResults({ fit = true } = {}) {
  clearMap();
  const all = [];
  state.searches.forEach((s) =>
    s.places.forEach((p) => {
      addMarker(p, { color: s.color, scale: 0.8, title: `${s.query}: ${p.name}` });
      all.push(p);
    }),
  );
  if (state.start) addStartMarker();
  if (fit) fitTo(state.start ? [state.start, ...all] : all);
}

/** Route through the currently chosen place of each type in an area. */
function areaRoute(area) {
  const pts = area.choice.map((i, g) => ({ ...state.groups[g][i], group: state.searches[g] }));
  const all = state.start ? [state.start, ...pts] : pts;
  const { order, km } = bestRoute(all, { fixedStart: Boolean(state.start) });
  const visit = (state.start ? order.slice(1).map((i) => i - 1) : order).map((i) => pts[i]);
  return { visit, km };
}

/**
 * Show the plans: cards in the panel, every area's circle on the map, and the
 * selected area's places and route. `fit`: "all" (every area), "selected", or false.
 */
function renderAreas({ fit = "selected" } = {}) {
  const box = $("combo-results");
  box.replaceChildren(...state.areas.map((a, idx) => areaCard(a, idx, idx === state.areaSel)));
  drawAreas({ fit });
  if (state.popupOpen) renderPopup();
}

/** Select an area; from the map this also opens its popup with the filter options. */
function selectArea(idx, { popup = false, fit = "selected" } = {}) {
  state.areaSel = idx;
  if (popup) state.popupOpen = true;
  renderAreas({ fit });
  $("combo-results").children[idx]?.scrollIntoView?.({ block: "nearest" });
}

// ---------- area popup (opened from the map) ----------
function renderPopup() {
  const area = state.areas?.[state.areaSel];
  if (!area || $("tab-combo").hidden) return closePopup();
  const pop = $("area-popup");
  const route = areaRoute(area);
  const head = areaHead(area, state.areaSel, route);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn";
  close.setAttribute("aria-label", "關閉");
  close.innerHTML = ICONS.close;
  close.onclick = closePopup;
  head.append(close);
  const body = document.createElement("div");
  body.className = "popup-body";
  body.append(...areaGroups(area));
  const actions = actionsRow(route.visit, area);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "btn";
  more.textContent = "查看地點詳情";
  more.onclick = () => {
    closePopup();
    if (isPhone()) setSheet("full");
    else if ($("app").classList.contains("panel-closed")) $("panel-toggle").click();
    $("combo-results").children[state.areaSel]?.scrollIntoView?.({ block: "start" });
  };
  actions.append(more);
  pop.replaceChildren(head, body, actions);
  pop.setAttribute("aria-label", `方案 ${state.areaSel + 1} 的篩選選項`);
  const wasHidden = pop.hidden;
  pop.hidden = false;
  if (wasHidden) {
    if (isPhone()) setSheet("peek");
    pop.tabIndex = -1;
    pop.focus({ preventScroll: true }); // keyboard users land in the popup; Esc closes it
  }
  keepAreaClearOfPopup(area);
}

/**
 * Pan the map if the popup covers the selected area's circle: sideways on desktop
 * (popup on the right), upwards on phones (popup docked above the bottom sheet).
 */
function keepAreaClearOfPopup(area) {
  if (!map?.getBounds || !map.panBy) return;
  const b = map.getBounds();
  if (!b) return;
  const ne = b.getNorthEast?.();
  const sw = b.getSouthWest?.();
  const [north, east] = ne ? [ne.lat(), ne.lng()] : [b.north, b.east];
  const [south, west] = sw ? [sw.lat(), sw.lng()] : [b.south, b.west];
  const mapRect = $("map").getBoundingClientRect();
  const pop = $("area-popup").getBoundingClientRect();
  const rLat = area.radiusKm / 111.32;
  const rLng = rLat / Math.cos((area.center.lat * Math.PI) / 180);
  // Screen box of the circle plus its label (~36px above the top edge).
  const x = (lng) => mapRect.left + ((lng - west) / (east - west)) * mapRect.width;
  const y = (lat) => mapRect.top + ((north - lat) / (north - south)) * mapRect.height;
  const box = { left: x(area.center.lng - rLng), right: x(area.center.lng + rLng), top: y(area.center.lat + rLat) - 36, bottom: y(area.center.lat - rLat) };
  if (isPhone()) {
    const roomTop = $("chips").getBoundingClientRect().bottom + 8;
    const overlap = box.bottom - (pop.top - 12);
    // Move the map up (content up = positive dy), but not so far that the label hides under the chips.
    if (overlap > 0) moveMap(() => map.panBy(0, Math.min(overlap, Math.max(0, box.top - roomTop))));
  } else {
    const overlap = box.right - (pop.left - 16);
    if (overlap > 0) moveMap(() => map.panBy(overlap, 0));
  }
}

function closePopup() {
  state.popupOpen = false;
  $("area-popup").hidden = true;
}


/** Badge, title and distance summary for an area. */
function areaHead(area, idx, route = areaRoute(area)) {
  const units = unitsValue();
  const first = state.groups[0][area.choice[0]];
  const count = area.members.reduce((s, m) => s + m.length, 0);
  const head = document.createElement("div");
  head.className = "area-head";
  head.innerHTML = `
      <span class="area-badge">${idx + 1}</span>
      <div class="grow">
        <div class="area-title"></div>
        <div class="area-sub"></div>
      </div>`;
  head.querySelector(".area-title").textContent = `方案 ${idx + 1}・${first.name} 一帶`;
  const sub = head.querySelector(".area-sub");
  const km = document.createElement("span");
  km.className = "km";
  km.textContent = `路程 ${formatKm(route.km, units)}`;
  if (route.visit.length > 1 || state.start) sub.append(km, " · ");
  sub.append(`半徑約 ${formatKm(area.radiusKm, units)} · ${count} 個地點`);
  return head;
}

function areaCard(area, idx, selected) {
  const units = unitsValue();
  const route = areaRoute(area);
  const card = document.createElement("article");
  card.className = "area-card" + (selected ? " selected" : "");
  card.append(areaHead(area, idx, route));

  if (!selected) {
    const summary = document.createElement("div");
    summary.className = "area-summary";
    area.members.forEach((m, g) => {
      const chip = document.createElement("span");
      chip.className = "mini-chip";
      chip.innerHTML = `<span class="dot"></span><span></span>`;
      chip.querySelector(".dot").style.background = state.searches[g].color;
      chip.lastChild.textContent = `${state.searches[g].query} ${m.length}`;
      summary.append(chip);
    });
    card.append(summary);
    card.onclick = () => selectArea(idx);
    return card;
  }

  // Selected: list every nearby place of each type; tap one to choose it for the route.
  card.append(...areaGroups(area, { details: true }));

  // Visiting order of the chosen places.
  const legs = document.createElement("div");
  legs.className = "route-legs";
  let prev = state.start;
  legs.textContent = (state.start ? `起點 ${state.start.name} → ` : "") +
    route.visit
      .map((p, i) => {
        const d = prev ? `（${formatKm(haversineKm(prev, p), units)}）` : "";
        prev = p;
        return `${i + 1}. ${p.name}${d}`;
      })
      .join(" → ");
  card.append(legs, actionsRow(route.visit, area));
  return card;
}

/**
 * One section per searched type, listing the area's nearby places of that type.
 * Tap a place to choose it for the route; pin / block buttons keep or exclude it.
 * `details` adds the Google Maps details under each chosen place.
 */
function areaGroups(area, { details = false } = {}) {
  const units = unitsValue();
  return area.members.map((members, g) => {
    const s = state.searches[g];
    const sec = document.createElement("section");
    sec.className = "group";
    sec.innerHTML = `<div class="group-head"><span class="dot"></span><span></span><span class="muted"></span></div><ul class="place-list"></ul>`;
    sec.querySelector(".dot").style.background = s.color;
    sec.querySelector(".group-head span:nth-child(2)").textContent = s.query;
    sec.querySelector(".group-head .muted").textContent = `· 附近 ${members.length} 間，點選要去的那一間`;
    const ul = sec.querySelector("ul");
    members.forEach((i) => {
      const p = state.groups[g][i];
      const chosen = area.choice[g] === i;
      const li = document.createElement("li");
      li.className = "place" + (chosen ? " chosen" : "");
      li.setAttribute("role", "radio");
      li.setAttribute("aria-checked", String(chosen));
      li.tabIndex = 0;
      li.innerHTML = `<span class="radio"></span><span class="place-name"></span><span class="place-meta"></span>`;
      li.querySelector(".place-name").textContent = p.name;
      const meta = li.querySelector(".place-meta");
      if (p.rating) {
        const r = document.createElement("span");
        r.className = "rating";
        r.innerHTML = `<span></span> <span class="stars"></span>`;
        r.firstChild.textContent = p.rating.toFixed(1);
        r.lastChild.textContent = "★".repeat(Math.round(p.rating));
        meta.append(r, "·");
      }
      meta.append(`距中心 ${formatKm(haversineKm(area.center, p), units)}`);
      li.append(filterButtons(p, s));
      if (chosen && details) li.append(placeDetails(p.placeId));
      const choose = () => {
        if (area.choice[g] === i) return;
        area.choice[g] = i;
        renderAreas({ fit: false });
      };
      li.onclick = (e) => {
        if (!e.target.closest(".details, .filter-btns")) choose();
      };
      li.onkeydown = (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === li) {
          e.preventDefault();
          choose();
        }
      };
      ul.append(li);
    });
    return sec;
  });

}

/** Directions link, plus a save / unsave button when `area` is a plan. */
function actionsRow(stops, area = null) {
  const row = document.createElement("div");
  row.className = "area-actions";
  const go = document.createElement("a");
  go.className = "btn filled";
  go.href = directionsUrl(state.start ? [state.start, ...stops] : stops, segValue("travel-mode"));
  go.target = "_blank";
  go.rel = "noopener";
  go.innerHTML = `${ICONS.directions}<span>路線</span>`;
  row.append(go);
  if (area) {
    const saved = findSaved(area);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn" + (saved ? " on" : "");
    b.setAttribute("aria-pressed", String(Boolean(saved)));
    b.innerHTML = `${saved ? ICONS.bookmarked : ICONS.bookmark}<span>${saved ? "已儲存" : "儲存"}</span>`;
    b.title = saved ? "從「已儲存」移除" : "儲存這個方案，之後可在「已儲存」查看";
    b.onclick = (e) => {
      e.stopPropagation();
      if (saved) {
        writeSaved(loadSaved().filter((p) => p.id !== saved.id));
        setStatus("已從「已儲存」移除這個方案。");
      } else saveArea(area);
      renderAreas({ fit: false });
    };
    row.append(b);
  }
  return row;
}

// ---------- saved plans (localStorage) ----------
const SAVED_STORAGE = "wsig.savedPlans";

function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_STORAGE) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeSaved(list) {
  try {
    localStorage.setItem(SAVED_STORAGE, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Identifies a plan by the places chosen for it. */
const areaKey = (area) => area.choice.map((i, g) => state.groups[g][i].placeId).join("|");
const findSaved = (area) => loadSaved().find((p) => p.key === areaKey(area));

function saveArea(area) {
  const first = state.groups[0][area.choice[0]];
  const plan = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    key: areaKey(area),
    savedAt: Date.now(),
    title: `${first.name} 一帶`,
    searches: state.searches.map((s) => ({ query: s.query, color: s.color })),
    // The places listed for each type, and which one was chosen.
    members: area.members.map((m, g) => m.map((i) => state.groups[g][i])),
    choice: area.choice.map((i, g) => area.members[g].indexOf(i)),
    center: area.center,
    radiusKm: area.radiusKm,
    start: state.start,
    travelMode: segValue("travel-mode"),
  };
  if (writeSaved([plan, ...loadSaved()])) setStatus(`已儲存「${plan.title}」，可在「已儲存」分頁隨時查看。`);
  else setStatus("無法儲存：這個瀏覽器不允許儲存資料（可能是私密瀏覽模式）。", true);
}

function renderSaved() {
  const list = loadSaved();
  $("saved-empty").hidden = list.length > 0;
  $("saved-list").replaceChildren(
    ...list.map((plan) => {
      const card = document.createElement("article");
      card.className = "area-card saved-card";
      const head = document.createElement("div");
      head.className = "area-head";
      head.innerHTML = `<span class="area-badge">${ICONS.bookmarked}</span><div class="grow"><div class="area-title"></div><div class="area-sub"></div></div>`;
      head.querySelector(".area-title").textContent = plan.title;
      const when = new Date(plan.savedAt).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });
      head.querySelector(".area-sub").textContent = `儲存於 ${when}` + (plan.start ? ` · 起點 ${plan.start.name}` : "");
      const summary = document.createElement("div");
      summary.className = "area-summary";
      plan.searches.forEach((s, g) => {
        const chip = document.createElement("span");
        chip.className = "mini-chip";
        chip.innerHTML = `<span class="dot"></span><span></span>`;
        chip.querySelector(".dot").style.background = s.color;
        chip.lastChild.textContent = `${s.query}：${plan.members[g][plan.choice[g]]?.name ?? ""}`;
        summary.append(chip);
      });
      const actions = document.createElement("div");
      actions.className = "area-actions";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn filled";
      open.textContent = "開啟";
      open.onclick = (e) => {
        e.stopPropagation();
        openSaved(plan);
      };
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn";
      del.textContent = "刪除";
      del.onclick = (e) => {
        e.stopPropagation();
        writeSaved(loadSaved().filter((p) => p.id !== plan.id));
        renderSaved();
        setStatus(`已刪除「${plan.title}」。`);
      };
      actions.append(open, del);
      card.append(head, summary, actions);
      card.onclick = () => openSaved(plan);
      return card;
    }),
  );
}

/** Load a saved plan back into the 附近區域 tab, exactly as it was saved. */
function openSaved(plan) {
  if (!map) return;
  state.searches = plan.searches.map((s, g) => ({ ...s, places: plan.members[g] }));
  state.groups = plan.members;
  state.start = plan.start || null;
  state.excluded.clear();
  state.pinned.clear();
  renderFilters();
  const members = plan.members.map((m) => m.map((_, i) => i));
  const choice = plan.choice.map((c) => Math.max(0, c));
  state.areas = [{ center: plan.center, radiusKm: plan.radiusKm, members, picks: choice.slice(), choice, order: [], km: 0 }];
  state.areaSel = 0;
  const mode = $("travel-mode");
  if (plan.travelMode) {
    mode.dataset.value = plan.travelMode;
    mode.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === plan.travelMode)));
  }
  renderChips();
  selectTab("combo");
  $("combo-intro").hidden = true;
  renderAreas({ fit: "selected" });
  setStatus(`已開啟儲存的方案「${plan.title}」。按「在此區域搜尋」可以重新搜尋這一帶。`);
}

// ---------- mode 2: plan my stops ----------
function renderStops({ fit = true } = {}) {
  const list = $("stop-list");
  list.replaceChildren(
    ...state.stops.map((s, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="num"></span><span class="grow"></span><button class="icon-btn" type="button" aria-label="移除">${ICONS.close}</button>`;
      li.querySelector(".num").textContent = i + 1;
      li.querySelector(".grow").textContent = s.name;
      li.querySelector(".grow").title = s.address;
      li.querySelector("button").onclick = () => {
        state.stops.splice(i, 1);
        state.lastRoute = null;
        $("route-results").replaceChildren();
        renderStops();
      };
      return li;
    }),
  );
  $("plan-route").disabled = state.stops.length + (state.start ? 1 : 0) < 2;
  if (!map) return;
  if (state.lastRoute && $("route-results").childElementCount) return renderRoute();
  clearMap();
  state.stops.forEach((s) => addMarker(s, { color: GROUP_COLORS[0], title: s.name }));
  if (state.start) addStartMarker();
  if (fit) fitTo(state.start ? [state.start, ...state.stops] : state.stops);
}

function onPlanRoute() {
  const pts = state.start ? [state.start, ...state.stops] : state.stops;
  const { order, km } = bestRoute(pts, { fixedStart: Boolean(state.start) });
  const visit = (state.start ? order.slice(1) : order).map((i) => pts[i]);
  state.lastRoute = { visit, km };
  renderRoute();
  setStatus(state.stops.length > 8 ? "地點較多：此路線為接近最佳的估算。" : "這是最短的順序。");
}

function renderRoute() {
  const { visit, km } = state.lastRoute;
  const units = unitsValue();
  const card = document.createElement("article");
  card.className = "area-card selected";
  card.innerHTML = `<div class="area-head"><span class="area-badge">✓</span><div><div class="area-title">最佳順序</div><div class="area-sub"><span class="km"></span></div></div></div>`;
  card.querySelector(".km").textContent = `總路程 ${formatKm(km, units)}`;
  let prev = state.start;
  visit.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "route-stop";
    row.innerHTML = `<span class="num"></span><span class="grow place-name"></span><span class="addr"></span>`;
    row.querySelector(".num").textContent = i + 1;
    row.querySelector(".grow").textContent = s.name;
    row.querySelector(".addr").textContent = s.address;
    if (prev) {
      const leg = document.createElement("span");
      leg.className = "leg";
      leg.textContent = `距上一站 ${formatKm(haversineKm(prev, s), units)}`;
      row.append(leg);
    }
    row.append(placeDetails(s.placeId));
    prev = s;
    card.append(row);
  });
  card.append(actionsRow(visit));
  $("route-results").replaceChildren(card);
  drawRoute(visit);
}

// ---------- filters (exclude / keep places) ----------
function filterButtons(place, search) {
  const row = document.createElement("div");
  row.className = "filter-btns";
  const make = (cls, icon, title, on, toggle) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `filter-btn ${cls}` + (on ? " on" : "");
    b.innerHTML = icon;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.setAttribute("aria-pressed", String(on));
    b.onclick = (e) => {
      e.stopPropagation();
      toggle();
    };
    return b;
  };
  const { placeId } = place;
  const plain = { ...place, query: search.query };
  row.append(
    make("keep", ICONS.pin, `保留：「${search.query}」只用這個地點`, state.pinned.has(placeId), () => {
      if (state.pinned.delete(placeId)) return afterFilterChange();
      state.excluded.delete(placeId);
      state.pinned.set(placeId, plain);
      afterFilterChange();
    }),
    make("drop", ICONS.block, "排除：不要用這個地點", state.excluded.has(placeId), () => {
      if (state.excluded.delete(placeId)) return afterFilterChange();
      state.pinned.delete(placeId);
      state.excluded.set(placeId, plain);
      afterFilterChange();
    }),
  );
  return row;
}

function renderFilters() {
  const items = [
    ...[...state.pinned.values()].map((p) => ({ p, kind: "keep", icon: ICONS.pin, label: "保留" })),
    ...[...state.excluded.values()].map((p) => ({ p, kind: "drop", icon: ICONS.block, label: "排除" })),
  ];
  $("filter-box").hidden = !items.length;
  $("filter-list").replaceChildren(
    ...items.map(({ p, kind, icon, label }) => {
      const c = document.createElement("span");
      c.className = `chip ${kind}`;
      c.innerHTML = `${icon}<span></span><button class="x" type="button" aria-label="移除篩選">${ICONS.close}</button>`;
      c.querySelector("span").textContent = `${label}・${p.name}（${p.query}）`;
      c.querySelector(".x").onclick = () => {
        (kind === "keep" ? state.pinned : state.excluded).delete(p.placeId);
        afterFilterChange();
      };
      return c;
    }),
  );
}

/** Re-render the filter list and recompute the area plans. */
function afterFilterChange() {
  renderFilters();
  computeAreas({ fit: false, keepSelection: true });
}

// ---------- Google Maps place details ----------
const detailsCache = new Map(); // placeId -> Promise<Place>

function fetchDetails(placeId) {
  if (!detailsCache.has(placeId)) {
    const place = new lib.Place({ id: placeId });
    const p = place.fetchFields({ fields: DETAIL_FIELDS }).then(() => place);
    p.catch(() => detailsCache.delete(placeId)); // allow a retry next time
    detailsCache.set(placeId, p);
  }
  return detailsCache.get(placeId);
}

/** A details block that fills itself in once the place's details arrive. */
function placeDetails(placeId) {
  const box = document.createElement("div");
  box.className = "details";
  box.textContent = "正在載入地點資訊…";
  fetchDetails(placeId)
    .then((place) => renderDetails(box, place))
    .catch((err) => {
      box.textContent = `無法載入地點資訊：${err.message}`;
    });
  return box;
}

async function renderDetails(box, place) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const link = (href, text) => {
    const a = el("a", "", text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };
  const parts = [];

  const photo = place.photos?.[0];
  if (photo) {
    const img = el("img", "photo");
    img.src = photo.getURI({ maxWidth: 720, maxHeight: 405 });
    img.alt = place.displayName || "";
    img.loading = "lazy";
    parts.push(img);
    const author = photo.authorAttributions?.[0];
    if (author?.displayName) {
      const credit = el("span", "credit", "相片：");
      credit.append(author.uri ? link(author.uri, author.displayName) : author.displayName);
      parts.push(credit);
    }
  }

  const meta = el("div", "meta");
  if (place.userRatingCount) meta.append(`${place.userRatingCount.toLocaleString("zh-TW")} 則評論`);
  const extra = [PRICE_LEVELS[place.priceLevel], place.primaryTypeDisplayName].filter(Boolean);
  if (extra.length) meta.append(`${meta.childNodes.length ? " · " : ""}${extra.join(" · ")}`);
  if (meta.childNodes.length) parts.push(meta);

  const hours = place.regularOpeningHours;
  const status = el("div");
  if (place.businessStatus === "CLOSED_PERMANENTLY") status.append(el("span", "closed", "已永久停業"));
  else if (place.businessStatus === "CLOSED_TEMPORARILY") status.append(el("span", "closed", "暫停營業"));
  else if (hours) {
    let open;
    try {
      open = await place.isOpen();
    } catch {
      open = undefined;
    }
    if (open === true) status.append(el("span", "open", "營業中"));
    else if (open === false) status.append(el("span", "closed", "休息中"));
  }
  const days = hours?.weekdayDescriptions || [];
  if (days.length) {
    const today = (new Date().getDay() + 6) % 7; // weekdayDescriptions start on Monday
    if (status.childNodes.length) status.append(" · ");
    status.append(days[today] || "");
    parts.push(status);
    const all = el("details");
    all.append(el("summary", "", "所有營業時間"));
    const ul = el("ul");
    days.forEach((d, i) => ul.append(el("li", i === today ? "today" : "", d)));
    all.append(ul);
    parts.push(all);
  } else if (status.childNodes.length) {
    parts.push(status);
  }

  if (place.editorialSummary) parts.push(el("p", "summary", place.editorialSummary));

  const links = el("div", "links");
  if (place.nationalPhoneNumber) links.append(link(`tel:${place.nationalPhoneNumber.replace(/\s+/g, "")}`, `致電 ${place.nationalPhoneNumber}`));
  if (place.websiteURI) {
    let host = place.websiteURI;
    try {
      host = new URL(place.websiteURI).hostname.replace(/^www\./, "");
    } catch {}
    links.append(link(place.websiteURI, host));
  }
  if (place.googleMapsURI) links.append(link(place.googleMapsURI, "在 Google 地圖查看"));
  if (links.childNodes.length) parts.push(links);

  box.replaceChildren(...parts);
  if (!parts.length) box.hidden = true;
}

// ---------- map drawing ----------
function drawAreas({ fit = "selected" } = {}) {
  clearMap();
  const sel = state.areas[state.areaSel];
  const blue = cssVar("--blue");
  // Every area's circle, with a numbered label on its top edge. Click either to open that plan.
  state.areas.forEach((a, idx) => {
    const selected = a === sel;
    const circle = new lib.Circle({
      map,
      center: a.center,
      radius: a.radiusKm * 1000,
      strokeColor: blue,
      strokeOpacity: selected ? 0.9 : 0.6,
      strokeWeight: selected ? 3 : 2,
      fillColor: blue,
      fillOpacity: selected ? 0.12 : 0.05,
      clickable: true,
      zIndex: selected ? 2 : 1,
    });
    circle.addListener("click", () => selectArea(idx, { popup: true, fit: false }));
    state.overlays.push(circle);

    const label = document.createElement("button");
    label.type = "button";
    label.className = "area-pin" + (selected ? " selected" : "");
    label.textContent = `方案 ${idx + 1}`;
    label.setAttribute("aria-label", `開啟方案 ${idx + 1} 的篩選選項`);
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      selectArea(idx, { popup: true, fit: false });
    });
    const top = { lat: a.center.lat + a.radiusKm / 111.32, lng: a.center.lng };
    const marker = new lib.AdvancedMarkerElement({ map, position: top, content: label, gmpClickable: true, zIndex: selected ? 1000 : 900 });
    state.markers.push(marker);
  });

  // The selected area's places (small), then the chosen ones numbered in visiting order.
  sel.members.forEach((m, g) =>
    m.forEach((i) => {
      if (sel.choice[g] !== i) addMarker(state.groups[g][i], { color: state.searches[g].color, scale: 0.7, title: state.groups[g][i].name });
    }),
  );
  const { visit } = areaRoute(sel);
  const path = state.start ? [state.start, ...visit] : visit;
  if (state.start) addStartMarker();
  visit.forEach((s, i) => addMarker(s, { color: s.group.color, label: String(i + 1), title: s.name }));
  addLine(path);

  const edges = (a) => {
    const r = a.radiusKm / 111.32; // degrees of latitude
    const rl = r / Math.cos((a.center.lat * Math.PI) / 180);
    return [
      { lat: a.center.lat + r, lng: a.center.lng },
      { lat: a.center.lat - r, lng: a.center.lng },
      { lat: a.center.lat, lng: a.center.lng + rl },
      { lat: a.center.lat, lng: a.center.lng - rl },
    ];
  };
  if (fit === "all") fitTo([...state.areas.flatMap(edges), ...(state.start ? [state.start] : [])]);
  else if (fit) fitTo([...edges(sel), ...path]);
}

function drawRoute(stops, { fit = true } = {}) {
  clearMap();
  const path = state.start ? [state.start, ...stops] : stops;
  if (state.start) addStartMarker();
  stops.forEach((s, i) => addMarker(s, { color: GROUP_COLORS[0], label: String(i + 1), title: s.name }));
  addLine(path);
  if (fit) fitTo(path);
}

function addLine(path) {
  state.overlays.push(
    new lib.Polyline({
      map,
      path: path.map(({ lat, lng }) => ({ lat, lng })),
      strokeColor: cssVar("--blue"),
      strokeOpacity: 0.9,
      strokeWeight: 5,
    }),
  );
}

function rerender() {
  if (!$("tab-combo").hidden && state.areas?.length) renderAreas({ fit: false });
  else if (!$("tab-stops").hidden && state.lastRoute && $("route-results").childElementCount) renderRoute();
}

function afterStartChange() {
  renderChips();
  $("plan-route").disabled = state.stops.length + (state.start ? 1 : 0) < 2;
  state.lastRoute = null;
  $("route-results").replaceChildren();
  if (!$("tab-combo").hidden) computeAreas({ fit: true });
  else renderStops();
}

function addMarker(p, { color, label, title, scale = 1 }) {
  const pin = new lib.PinElement({
    background: color,
    borderColor: "#ffffff",
    glyphColor: "#ffffff",
    glyph: label || "",
    scale,
  });
  const marker = new lib.AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, title, content: pin.element });
  state.markers.push(marker);
  return marker;
}

function addStartMarker() {
  addMarker(state.start, { color: "#202124", label: "S", title: `起點：${state.start.name}` });
}

function clearMap() {
  state.markers.forEach((m) => (m.map = null));
  state.markers = [];
  state.overlays.forEach((o) => o.setMap(null));
  state.overlays = [];
}

/** Map padding that keeps fitted points clear of the floating search bar, chips and results panel. */
function mapPadding() {
  const app = $("app").getBoundingClientRect();
  // Extra room above for the "方案 N" labels drawn on top of each area circle.
  const top = $("chips").getBoundingClientRect().bottom - app.top + 44;
  if (isPhone()) {
    return { top, left: 32, right: 32, bottom: $("sheet").getBoundingClientRect().height + 24 };
  }
  const closed = $("app").classList.contains("panel-closed");
  const left = closed ? 48 : $("sheet").getBoundingClientRect().right - app.left + 48;
  return { top: Math.max(top, 48), left, right: 64, bottom: 48 };
}

function fitTo(points) {
  if (!points.length) return;
  if (points.length === 1) {
    moveMap(() => map.panTo({ lat: points[0].lat, lng: points[0].lng }));
    return;
  }
  const b = new lib.LatLngBounds();
  points.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
  moveMap(() => map.fitBounds(b, mapPadding()));
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

// Start once every declaration above is initialised.
const key = new URLSearchParams(location.search).get("key") || store.get(KEY_STORAGE);
if (key) boot(key);
else showKeySetup();
