import { bestCombos, bestRoute, directionsUrl, formatKm, haversineKm } from "./geo.js";

const KEY_STORAGE = "wsig.mapsApiKey";
const GROUP_COLORS = ["#1a73e8", "#e8710a", "#188038", "#a142f4", "#d93025", "#12b5cb", "#f9ab00", "#e52592"];
// Language/region for map labels, autocomplete and place results.
// zh-TW = Traditional Chinese; TW biases results and formatting toward Taiwan.
const MAPS_LANGUAGE = "zh-TW";
const MAPS_REGION = "TW";
const PLACE_FIELDS = ["id", "displayName", "formattedAddress", "location", "rating", "googleMapsURI"];
const MAX_SEARCHES = 6;

const $ = (id) => document.getElementById(id);

const state = {
  start: null, // { name, address, lat, lng, placeId }
  searches: [], // { query, color, places: [...] }
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
    navigator.geolocation?.getCurrentPosition(
      (pos) => map.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
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
    map.panTo(place);
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
      clearMap();
      setStatus("");
    };
  });

  $("search-form").onsubmit = onAddSearch;
  $("find-combos").onclick = onFindCombos;
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
    const { places } = await lib.Place.searchText({
      textQuery: query,
      fields: PLACE_FIELDS,
      language: MAPS_LANGUAGE,
      region: MAPS_REGION,
      locationBias: map.getBounds(),
      maxResultCount: 20,
    });
    if (!places?.length) {
      setStatus(`這附近找不到「${query}」。請試著移動地圖或換個關鍵字。`, true);
      return;
    }
    const color = GROUP_COLORS[state.searches.length % GROUP_COLORS.length];
    state.searches.push({ query, color, places: places.map(toPlain) });
    $("search-input").value = "";
    setStatus(`找到 ${places.length} 個「${query}」。`);
    renderSearches();
    showSearchResults();
  } catch (err) {
    setStatus(`搜尋失敗：${err.message}`, true);
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
        state.searches.forEach((g, j) => (g.color = GROUP_COLORS[j % GROUP_COLORS.length]));
        $("combo-results").replaceChildren();
        renderSearches();
        showSearchResults();
      };
      return li;
    }),
  );
  $("find-combos").disabled = state.searches.length < 2 && !(state.searches.length === 1 && state.start);
}

function showSearchResults() {
  clearMap();
  const all = [];
  state.searches.forEach((s) =>
    s.places.forEach((p) => {
      addMarker(p, { color: s.color, scale: 0.8, title: `${s.query}: ${p.name}` });
      all.push(p);
    }),
  );
  if (state.start) addStartMarker();
  fitTo(state.start ? [state.start, ...all] : all);
}

function onFindCombos() {
  const groups = state.searches.map((s) => s.places);
  const combos = bestCombos(groups, { start: state.start, limit: 5 });
  if (!combos.length) {
    setStatus("找不到任何組合。", true);
    return;
  }
  state.lastCombos = combos;
  renderCombos(0);
  setStatus(`顯示距離最近的 ${combos.length} 個組合。`);
}

function renderCombos(selected) {
  const combos = state.lastCombos;
  const box = $("combo-results");
  box.replaceChildren(
    ...combos.map((c, idx) => {
      const stops = c.order.map((g) => ({ ...state.searches[g].places[c.picks[g]], group: state.searches[g] }));
      const card = resultCard(`方案 ${idx + 1}`, c.km, stops, idx === selected);
      card.onclick = (e) => {
        if (e.target.tagName !== "A") renderCombos(idx);
      };
      return card;
    }),
  );
  const c = combos[selected];
  const stops = c.order.map((g) => ({ ...state.searches[g].places[c.picks[g]], group: state.searches[g] }));
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
    map.panTo({ lat: points[0].lat, lng: points[0].lng });
    return;
  }
  const b = new lib.LatLngBounds();
  points.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
  map.fitBounds(b, 60);
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}
