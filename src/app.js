import { bestCombos, bestRoute, directionsUrl, formatKm, haversineKm } from "./geo.js";

const KEY_STORAGE = "wsig.mapsApiKey";
const GROUP_COLORS = ["#1a73e8", "#e8710a", "#188038", "#a142f4", "#d93025", "#12b5cb", "#f9ab00", "#e52592"];
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
      setStatus("Google rejected the API key. Check that it is valid and the APIs are enabled.", true);
    };
    const s = document.createElement("script");
    s.src =
      "https://maps.googleapis.com/maps/api/js?" +
      new URLSearchParams({ key: apiKey, v: "weekly", loading: "async", callback: "__wsigMapsReady" });
    s.async = true;
    s.onerror = () => reject(new Error("Could not load Google Maps."));
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
      center: { lat: 40.758, lng: -73.9855 },
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
      setStatus(`Could not load that place: ${err.message}`, true);
    }
  };
  // Current event name, plus the older one for compatibility.
  el.addEventListener("gmp-select", (e) => handle(e.placePrediction.toPlace()));
  el.addEventListener("gmp-placeselect", (e) => handle(e.place));
}

function toPlain(place) {
  return {
    placeId: place.id,
    name: place.displayName || place.formattedAddress || "Unnamed place",
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
    setStatus(`You can combine up to ${MAX_SEARCHES} searches.`, true);
    return;
  }
  setStatus(`Searching for "${query}"…`);
  try {
    const { places } = await lib.Place.searchText({
      textQuery: query,
      fields: PLACE_FIELDS,
      locationBias: map.getBounds(),
      maxResultCount: 20,
    });
    if (!places?.length) {
      setStatus(`No results for "${query}" near here. Try moving the map or another search.`, true);
      return;
    }
    const color = GROUP_COLORS[state.searches.length % GROUP_COLORS.length];
    state.searches.push({ query, color, places: places.map(toPlain) });
    $("search-input").value = "";
    setStatus(`Found ${places.length} places for "${query}".`);
    renderSearches();
    showSearchResults();
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
  }
}

function renderSearches() {
  const list = $("search-list");
  list.replaceChildren(
    ...state.searches.map((s, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="swatch"></span><span class="grow"></span><span class="muted"></span><button class="x" title="Remove">✕</button>`;
      li.querySelector(".swatch").style.background = s.color;
      li.querySelector(".grow").textContent = s.query;
      li.querySelector(".muted").textContent = `${s.places.length} found`;
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
    setStatus("No combinations found.", true);
    return;
  }
  state.lastCombos = combos;
  renderCombos(0);
  setStatus(`Showing the ${combos.length} tightest combinations.`);
}

function renderCombos(selected) {
  const combos = state.lastCombos;
  const box = $("combo-results");
  box.replaceChildren(
    ...combos.map((c, idx) => {
      const stops = c.order.map((g) => ({ ...state.searches[g].places[c.picks[g]], group: state.searches[g] }));
      const card = resultCard(`Option ${idx + 1}`, c.km, stops, idx === selected);
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
      li.innerHTML = `<span class="grow"></span><button class="x" title="Remove">✕</button>`;
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
  setStatus(state.stops.length > 8 ? "Large list: route is a close-to-optimal estimate." : "This is the shortest order.");
}

function renderRoute() {
  const { visit, km } = state.lastRoute;
  $("route-results").replaceChildren(resultCard("Best order", km, visit, true));
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
  head.children[1].textContent = `${formatKm(km, units)} total`;
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
      leg.textContent = `↳ ${formatKm(haversineKm(prev, s), units)} from previous`;
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
  link.textContent = "Open in Google Maps →";
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
  chip.innerHTML = `<span class="swatch" style="background:#202124"></span><span class="grow"></span><button class="x" title="Remove">✕</button>`;
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
  addMarker(state.start, { color: "#202124", label: "S", title: `Start: ${state.start.name}` });
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
