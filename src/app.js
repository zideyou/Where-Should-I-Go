import { bestCombos, bestRoute, directionsUrl, filterGroups, formatKm, haversineKm } from "./geo.js";

const KEY_STORAGE = "wsig.mapsApiKey";
const GROUP_COLORS = ["#1a73e8", "#e8710a", "#188038", "#a142f4", "#d93025", "#12b5cb", "#f9ab00", "#e52592"];
// Language/region for map labels, autocomplete and place results.
// zh-TW = Traditional Chinese; TW biases results and formatting toward Taiwan.
const MAPS_LANGUAGE = "zh-TW";
const MAPS_REGION = "TW";
// Extra Google Maps details, fetched only for places shown in the selected result.
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

const $ = (id) => document.getElementById(id);

const state = {
  start: null, // { name, address, lat, lng, placeId }
  searches: [], // { query, color, places: [...] }
  excluded: new Map(), // placeId -> place: never use in combos
  pinned: new Map(), // placeId -> place: only use these for their search
  stops: [], // [{ name, address, lat, lng, placeId }]
  markers: [],
  line: null,
};

let map;
let lib = {};

// ---------- storage (wrapped: may be blocked in private mode) ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------- boot ----------
const key = new URLSearchParams(location.search).get("key") || store.get(KEY_STORAGE);
if (key) boot(key);
else showKeySetup();

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
  $("change-key").onclick = () => {
    store.del(KEY_STORAGE);
    location.href = location.pathname;
  };

  try {
    await loadMapsScript(apiKey);
    const [{ Map, Polyline }, { Place, PlaceAutocompleteElement }, { AdvancedMarkerElement, PinElement }, { LatLngBounds }] =
      await Promise.all([
        google.maps.importLibrary("maps"),
        google.maps.importLibrary("places"),
        google.maps.importLibrary("marker"),
        google.maps.importLibrary("core"),
      ]);
    lib = { Polyline, Place, PlaceAutocompleteElement, AdvancedMarkerElement, PinElement, LatLngBounds };

    map = new Map($("map"), {
      center: { lat: 25.0478, lng: 121.517 }, // 台北車站
      zoom: 13,
      mapId: "DEMO_MAP_ID",
      mapTypeControl: false,
      streetViewControl: false,
    });
    // Offer "search this area" when the user (not the app) moves the map.
    map.addListener("dragend", onUserMovedMap);
    map.addListener("zoom_changed", () => {
      if (!programmaticMove) onUserMovedMap();
    });
    map.addListener("idle", () => (programmaticMove = false));
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
    renderStart();
    moveMap(() => map.panTo(place));
  });
  setupAutocomplete($("stop-slot"), (place) => {
    if (state.stops.some((s) => s.placeId === place.placeId)) return;
    state.stops.push(place);
    renderStops();
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("tab-combo").hidden = tab.dataset.tab !== "combo";
      $("tab-stops").hidden = tab.dataset.tab !== "stops";
      $("search-here").hidden = true;
      clearMap();
      setStatus("");
    };
  });

  $("panel-toggle").onclick = () => setPanelOpen($("panel").classList.contains("collapsed"));
  $("search-form").onsubmit = onAddSearch;
  $("search-here").onclick = onSearchHere;
  $("find-combos").onclick = onFindCombos;
  $("clear-filters").onclick = () => {
    state.excluded.clear();
    state.pinned.clear();
    afterFilterChange();
  };
  $("plan-route").onclick = onPlanRoute;
  $("units").onchange = () => rerender();
  $("travel-mode").onchange = () => rerender();
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

// ---------- mode 1: nearby combos ----------
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

async function onAddSearch(e) {
  e.preventDefault();
  const query = $("search-input").value.trim();
  if (!query) return;
  if (state.searches.length >= MAX_SEARCHES) {
    setStatus(`最多只能組合 ${MAX_SEARCHES} 個搜尋。`, true);
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
    setStatus(`找到 ${places.length} 個「${query}」。`);
    renderSearches();
    showSearchResults();
  } catch (err) {
    setStatus(`搜尋失敗：${err.message}`, true);
  }
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
    state.lastCombos = null;
    state.combosRequested = false;
    $("combo-results").replaceChildren();
    renderSearches();
    showSearchResults({ fit: false });
    btn.hidden = true;
    const empty = state.searches.filter((s) => !s.places.length).map((s) => `「${s.query}」`);
    if (empty.length) setStatus(`此區域找不到 ${empty.join("、")}。請移動地圖或縮小地圖再試一次。`, true);
    else setStatus(`已更新此區域的結果：${state.searches.map((s) => `${s.query} ${s.places.length} 個`).join("、")}。`);
  } catch (err) {
    setStatus(`搜尋失敗：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderSearches() {
  const list = $("search-list");
  list.replaceChildren(
    ...state.searches.map((s, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch"></span><span class="grow"></span><span class="muted"></span><button class="x" title="移除">✕</button>`;
      li.querySelector(".swatch").style.background = s.color;
      li.querySelector(".grow").textContent = s.query;
      li.querySelector(".muted").textContent = `${s.places.length} 個結果`;
      li.querySelector(".x").onclick = () => {
        state.searches.splice(i, 1);
        state.combosRequested = false;
        state.lastCombos = null;
        state.searches.forEach((g, j) => (g.color = GROUP_COLORS[j % GROUP_COLORS.length]));
        $("combo-results").replaceChildren();
        renderSearches();
        showSearchResults();
      };
      return li;
    }),
  );
  $("find-combos").disabled = state.searches.length < 2 && !(state.searches.length === 1 && state.start);
  if (!state.searches.length) $("search-here").hidden = true;
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

function onFindCombos() {
  state.combosRequested = true;
  const groups = filterGroups(
    state.searches.map((s) => s.places),
    { excluded: new Set(state.excluded.keys()), pinned: new Set(state.pinned.keys()) },
  );
  const empty = state.searches.filter((_, i) => !groups[i].length).map((s) => `「${s.query}」`);
  if (empty.length) {
    state.lastCombos = null;
    $("combo-results").replaceChildren();
    setStatus(`${empty.join("、")} 的地點都被排除了，請移除一些篩選。`, true);
    return;
  }
  const combos = bestCombos(groups, { start: state.start, limit: 5 });
  if (!combos.length) {
    setStatus("找不到任何組合。", true);
    return;
  }
  state.lastGroups = groups;
  state.lastCombos = combos;
  renderCombos(0);
  setStatus(`顯示距離最近的 ${combos.length} 個組合。`);
}

function renderCombos(selected) {
  const combos = state.lastCombos;
  const box = $("combo-results");
  box.replaceChildren(
    ...combos.map((c, idx) => {
      const stops = c.order.map((g) => ({ ...state.lastGroups[g][c.picks[g]], group: state.searches[g] }));
      const card = resultCard(`方案 ${idx + 1}`, c.km, stops, idx === selected);
      card.onclick = (e) => {
        if (e.target.tagName !== "A") renderCombos(idx);
      };
      return card;
    }),
  );
  const c = combos[selected];
  const stops = c.order.map((g) => ({ ...state.lastGroups[g][c.picks[g]], group: state.searches[g] }));
  drawRoute(stops);
}

// ---------- mode 2: plan my stops ----------
function renderStops() {
  const list = $("stop-list");
  list.replaceChildren(
    ...state.stops.map((s, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="grow"></span><button class="x" title="移除">✕</button>`;
      li.querySelector(".grow").textContent = s.name;
      li.querySelector(".grow").title = s.address;
      li.querySelector(".x").onclick = () => {
        state.stops.splice(i, 1);
        $("route-results").replaceChildren();
        renderStops();
      };
      return li;
    }),
  );
  $("plan-route").disabled = state.stops.length + (state.start ? 1 : 0) < 2;
  clearMap();
  state.stops.forEach((s) => addMarker(s, { color: GROUP_COLORS[0], title: s.name }));
  if (state.start) addStartMarker();
  fitTo(state.start ? [state.start, ...state.stops] : state.stops);
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
  $("route-results").replaceChildren(resultCard("最佳順序", km, visit, true));
  drawRoute(visit);
}

// ---------- shared rendering ----------
function resultCard(title, km, stops, selected) {
  const units = $("units").value;
  const card = document.createElement("div");
  card.className = "result" + (selected ? " selected" : "");
  const head = document.createElement("div");
  head.className = "result-head";
  head.innerHTML = `<span></span><span class="km"></span>`;
  head.children[0].textContent = title;
  head.children[1].textContent = `總計 ${formatKm(km, units)}`;
  card.append(head);

  const ol = document.createElement("ol");
  let prev = state.start;
  stops.forEach((s) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = s.group ? `${s.name} (${s.group.query})` : s.name;
    if (s.rating) name.textContent += ` ★${s.rating}`;
    li.append(name);
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = s.address;
    li.append(addr);
    if (selected && s.group) li.append(filterButtons(s));
    if (selected) li.append(placeDetails(s.placeId));
    if (prev) {
      const leg = document.createElement("span");
      leg.className = "leg";
      leg.textContent = `↳ 距上一站 ${formatKm(haversineKm(prev, s), units)}`;
      li.append(leg);
    }
    prev = s;
    ol.append(li);
  });
  card.append(ol);

  const link = document.createElement("a");
  link.href = directionsUrl(state.start ? [state.start, ...stops] : stops, $("travel-mode").value);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "在 Google 地圖中開啟 →";
  card.append(link);
  return card;
}

// ---------- combo filters (exclude / keep places) ----------
function filterButtons(place) {
  const row = document.createElement("div");
  row.className = "filter-btns";
  row.onclick = (e) => e.stopPropagation();
  const make = (label, title, on, toggle) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "filter-btn" + (on ? " on" : "");
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-pressed", String(on));
    b.onclick = toggle;
    return b;
  };
  const { placeId } = place;
  const plain = { ...place };
  delete plain.group;
  plain.query = place.group.query;
  row.append(
    make("📌 保留", "組合時這個搜尋只用這個地點", state.pinned.has(placeId), () => {
      if (state.pinned.delete(placeId)) return afterFilterChange();
      state.excluded.delete(placeId);
      state.pinned.set(placeId, plain);
      afterFilterChange();
    }),
    make("🚫 排除", "組合時不要用這個地點", state.excluded.has(placeId), () => {
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
    ...[...state.pinned.values()].map((p) => ({ p, kind: "pinned", label: "📌 保留" })),
    ...[...state.excluded.values()].map((p) => ({ p, kind: "excluded", label: "🚫 排除" })),
  ];
  $("filter-box").hidden = !items.length;
  $("filter-list").replaceChildren(
    ...items.map(({ p, kind, label }) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="tag"></span><span class="grow"></span><button class="x" title="移除">✕</button>`;
      li.querySelector(".tag").textContent = label;
      li.querySelector(".grow").textContent = `${p.name}（${p.query}）`;
      li.querySelector(".x").onclick = () => {
        (kind === "pinned" ? state.pinned : state.excluded).delete(p.placeId);
        afterFilterChange();
      };
      return li;
    }),
  );
}

/** Re-render the filter list and, if combos are showing, recompute them. */
function afterFilterChange() {
  renderFilters();
  if (state.combosRequested) onFindCombos();
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
  box.onclick = (e) => e.stopPropagation(); // don't re-select the card when using the details
  box.textContent = "正在載入地點資訊…";
  fetchDetails(placeId)
    .then((place) => renderDetails(box, place))
    .catch((err) => {
      box.textContent = `無法載入地點資訊：${err.message}`;
      box.classList.add("meta");
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
  if (place.rating != null) {
    meta.append(el("span", "stars", `★ ${place.rating.toFixed(1)}`));
    if (place.userRatingCount) meta.append(` (${place.userRatingCount.toLocaleString("zh-TW")} 則評論)`);
  }
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
  if (place.nationalPhoneNumber) links.append(link(`tel:${place.nationalPhoneNumber.replace(/\s+/g, "")}`, `☎ ${place.nationalPhoneNumber}`));
  if (place.websiteURI) {
    let host = place.websiteURI;
    try {
      host = new URL(place.websiteURI).hostname.replace(/^www\./, "");
    } catch {}
    links.append(link(place.websiteURI, `🌐 ${host}`));
  }
  if (place.googleMapsURI) links.append(link(place.googleMapsURI, "在 Google 地圖查看"));
  if (links.childNodes.length) parts.push(links);

  box.replaceChildren(...parts);
  if (!parts.length) box.hidden = true;
}

function drawRoute(stops) {
  clearMap();
  const path = state.start ? [state.start, ...stops] : stops;
  if (state.start) addStartMarker();
  stops.forEach((s, i) =>
    addMarker(s, { color: s.group?.color || GROUP_COLORS[0], label: String(i + 1), title: s.name }),
  );
  state.line = new lib.Polyline({
    map,
    path: path.map(({ lat, lng }) => ({ lat, lng })),
    strokeColor: "#1a73e8",
    strokeOpacity: 0.8,
    strokeWeight: 4,
  });
  fitTo(path);
}

function rerender() {
  if (!$("tab-combo").hidden && state.lastCombos && $("combo-results").childElementCount) {
    const idx = [...$("combo-results").children].findIndex((c) => c.classList.contains("selected"));
    renderCombos(Math.max(0, idx));
  } else if (!$("tab-stops").hidden && state.lastRoute && $("route-results").childElementCount) {
    renderRoute();
  }
}

function renderStart() {
  const chip = $("start-chip");
  chip.hidden = false;
  chip.innerHTML = `<span class="swatch" style="background:#202124"></span><span class="grow"></span><button class="x" title="移除">✕</button>`;
  chip.querySelector(".grow").textContent = state.start.name;
  chip.querySelector(".x").onclick = () => {
    state.start = null;
    chip.hidden = true;
    afterStartChange();
  };
  afterStartChange();
}

function afterStartChange() {
  $("plan-route").disabled = state.stops.length + (state.start ? 1 : 0) < 2;
  $("find-combos").disabled = state.searches.length < 2 && !(state.searches.length === 1 && state.start);
  $("combo-results").replaceChildren();
  $("route-results").replaceChildren();
  if (!$("tab-combo").hidden) showSearchResults();
  else renderStops();
}

// ---------- map helpers ----------
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
  state.line?.setMap(null);
  state.line = null;
}

function fitTo(points) {
  if (!points.length) return;
  if (points.length === 1) {
    moveMap(() => map.panTo({ lat: points[0].lat, lng: points[0].lng }));
    return;
  }
  const b = new lib.LatLngBounds();
  points.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
  moveMap(() => map.fitBounds(b, 60));
}

function setPanelOpen(open) {
  $("panel").classList.toggle("collapsed", !open);
  $("panel-toggle").setAttribute("aria-expanded", String(open));
  $("panel-toggle-label").textContent = open ? "收起 ▾" : "展開 ▴";
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}
