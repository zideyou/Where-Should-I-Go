// Pure distance / route-planning helpers. No Google Maps dependency,
// so they run in the browser and in Node tests alike.

const EARTH_RADIUS_KM = 6371;

/** Straight-line ("as the crow flies") distance in km between {lat, lng} points. */
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Full pairwise distance matrix (km). */
export function distanceMatrix(points) {
  return points.map((p) => points.map((q) => haversineKm(p, q)));
}

/** Length of a path that visits `order` (indices into matrix) in sequence. */
export function pathLength(order, matrix) {
  let total = 0;
  for (let i = 1; i < order.length; i++) total += matrix[order[i - 1]][order[i]];
  return total;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

/**
 * Shortest open path through all points.
 * @param {Array<{lat:number,lng:number}>} points
 * @param {{fixedStart?: boolean}} opts  fixedStart: points[0] must be visited first.
 * @returns {{order:number[], km:number}}
 */
export function bestRoute(points, { fixedStart = false } = {}) {
  const n = points.length;
  if (n === 0) return { order: [], km: 0 };
  if (n === 1) return { order: [0], km: 0 };
  const matrix = distanceMatrix(points);
  const all = [...Array(n).keys()];

  // Exact answer for small inputs (8! = 40320 permutations).
  if (n <= 8) {
    let best = null;
    const free = fixedStart ? all.slice(1) : all;
    for (const perm of permutations(free)) {
      const order = fixedStart ? [0, ...perm] : perm;
      const km = pathLength(order, matrix);
      if (!best || km < best.km) best = { order, km };
    }
    return best;
  }

  // Heuristic for larger inputs: nearest-neighbour from every allowed start, then 2-opt.
  const starts = fixedStart ? [0] : all;
  let best = null;
  for (const s of starts) {
    const order = twoOpt(nearestNeighbour(s, matrix), matrix, fixedStart);
    const km = pathLength(order, matrix);
    if (!best || km < best.km) best = { order, km };
  }
  return best;
}

function nearestNeighbour(start, matrix) {
  const n = matrix.length;
  const seen = new Set([start]);
  const order = [start];
  while (order.length < n) {
    const last = order[order.length - 1];
    let next = -1;
    for (let j = 0; j < n; j++) {
      if (!seen.has(j) && (next === -1 || matrix[last][j] < matrix[last][next])) next = j;
    }
    seen.add(next);
    order.push(next);
  }
  return order;
}

function twoOpt(order, matrix, fixedStart) {
  let improved = true;
  let route = order.slice();
  while (improved) {
    improved = false;
    for (let i = fixedStart ? 1 : 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const candidate = route
          .slice(0, i)
          .concat(route.slice(i, k + 1).reverse(), route.slice(k + 1));
        if (pathLength(candidate, matrix) + 1e-9 < pathLength(route, matrix)) {
          route = candidate;
          improved = true;
        }
      }
    }
  }
  return route;
}

/**
 * Given several groups of candidate places (e.g. results for "coffee", "bookstore",
 * "park"), pick one place from each group so the trip between them is as short as possible.
 *
 * @param {Array<Array<{lat:number,lng:number}>>} groups
 * @param {{start?: {lat:number,lng:number}, limit?: number}} opts
 *        start: optional fixed starting point (e.g. your hotel) included in the trip.
 *        limit: how many ranked combos to return.
 * @returns {Array<{picks:number[], order:number[], km:number}>}
 *        picks[g] = index chosen from groups[g]; order = visiting order of group indices.
 */
export function bestCombos(groups, { start = null, limit = 5 } = {}) {
  const nonEmpty = groups.every((g) => g.length > 0);
  if (!groups.length || !nonEmpty) return [];

  const evaluate = (picks) => {
    const pts = picks.map((p, g) => groups[g][p]);
    const route = start ? bestRoute([start, ...pts], { fixedStart: true }) : bestRoute(pts);
    const order = start ? route.order.slice(1).map((i) => i - 1) : route.order;
    return { picks, order, km: route.km };
  };

  const results = [];
  const seen = new Set();
  const push = (picks) => {
    const key = picks.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    results.push(evaluate(picks));
  };

  const combos = groups.reduce((acc, g) => acc * g.length, 1);
  if (combos <= 20000) {
    // Exhaustive search over every combination.
    const picks = new Array(groups.length).fill(0);
    const walk = (g) => {
      if (g === groups.length) return push(picks.slice());
      for (let i = 0; i < groups[g].length; i++) {
        picks[g] = i;
        walk(g + 1);
      }
    };
    walk(0);
  } else {
    // Too many combos: anchor on each candidate and take the nearest place from every other group.
    groups.forEach((group, g) => {
      group.forEach((anchor, i) => {
        const picks = groups.map((other, h) => {
          if (h === g) return i;
          let bestJ = 0;
          other.forEach((p, j) => {
            if (haversineKm(anchor, p) < haversineKm(anchor, other[bestJ])) bestJ = j;
          });
          return bestJ;
        });
        push(picks);
      });
    });
  }

  results.sort((a, b) => a.km - b.km);
  return results.slice(0, limit);
}

/** Human-friendly distance label. */
export function formatKm(km, units = "km") {
  if (units === "mi") {
    const mi = km * 0.621371;
    return mi < 0.2 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(1)} mi`;
  }
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

/** Google Maps directions URL that visits the points in order (no API key needed). */
export function directionsUrl(points, travelmode = "walking") {
  const ids = (p) => p.placeId || "";
  const origin = points[0];
  const dest = points[points.length - 1];
  const mid = points.slice(1, -1);
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: `${dest.lat},${dest.lng}`,
    travelmode,
  });
  if (origin.placeId) params.set("origin_place_id", ids(origin));
  if (dest.placeId) params.set("destination_place_id", ids(dest));
  if (mid.length) {
    params.set("waypoints", mid.map((p) => `${p.lat},${p.lng}`).join("|"));
    const midIds = mid.map(ids);
    if (midIds.every(Boolean)) params.set("waypoint_place_ids", midIds.join("|"));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Apply the user's place filters to candidate groups before combining.
 * Excluded places are dropped. If a group has pinned ("keep") places,
 * only those are used for that group. Places are matched by `placeId`.
 */
export function filterGroups(groups, { excluded = new Set(), pinned = new Set() } = {}) {
  return groups.map((g) => {
    const kept = g.filter((p) => !excluded.has(p.placeId));
    const pins = kept.filter((p) => pinned.has(p.placeId));
    return pins.length ? pins : kept;
  });
}

/**
 * Split the search results into distinct areas ("plans"). Each area is built
 * around one of the tightest one-of-each combos, and lists every nearby place
 * of each type so the user can choose among them. Area centres are kept apart,
 * so each plan is a different part of town, but areas that are close together may
 * list the same place: anything within an area's radius belongs to it, even if an
 * earlier area lists it too. A combo whose picks all sit inside one earlier area
 * adds nothing new, so it is skipped.
 *
 * @param {Array<Array<{lat:number,lng:number}>>} groups  candidate places per search
 * @param {{start?: object, limit?: number, perGroup?: number, minRadiusKm?: number}} opts
 * @returns {Array<{center:{lat:number,lng:number}, radiusKm:number, picks:number[],
 *   order:number[], km:number, members:number[][]}>}
 *   picks[g] = closest pick per group (index into groups[g]); order/km = route through picks;
 *   members[g] = indices of groups[g] in the area, nearest the centre first (picks[g] first).
 */
export function bestAreas(groups, { start = null, limit = 5, perGroup = 5, minRadiusKm = 0.4 } = {}) {
  const combos = bestCombos(groups, { start, limit: Infinity });
  if (groups.length === 1 && !start) {
    // Every single place is a zero-length "trip", so start from the busiest spots instead.
    const near = (p) => groups[0].filter((q) => haversineKm(p, q) <= minRadiusKm).length;
    const density = groups[0].map(near);
    combos.sort((a, b) => density[b.picks[0]] - density[a.picks[0]]);
  }
  const areas = [];

  for (const combo of combos) {
    if (areas.length >= limit) break;
    // Nothing new: every pick is already listed by one earlier area.
    if (areas.some((a) => combo.picks.every((p, g) => a.members[g].includes(p)))) continue;
    const pts = combo.picks.map((p, g) => groups[g][p]);
    const center = {
      lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
      lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
    };
    const spread = Math.max(0, ...pts.map((p) => haversineKm(center, p)));
    const radiusKm = Math.max(minRadiusKm, spread * 1.5);
    // Keep each area's centre outside every earlier area.
    if (areas.some((a) => haversineKm(a.center, center) < Math.max(a.radiusKm, radiusKm))) continue;

    const members = groups.map((group, g) => {
      const near = group
        .map((p, i) => ({ i, d: haversineKm(center, p) }))
        .filter(({ i, d }) => i !== combo.picks[g] && d <= radiusKm)
        .sort((a, b) => a.d - b.d)
        .slice(0, perGroup - 1)
        .map(({ i }) => i);
      return [combo.picks[g], ...near];
    });
    areas.push({ center, radiusKm, picks: combo.picks, order: combo.order, km: combo.km, members });
  }
  return areas;
}

/**
 * A short area name from Taiwanese street addresses, e.g.
 * "100台灣台北市中正區忠孝西路一段49號" → road "忠孝西路一段", district "中正區".
 * Returns the road most addresses share, else the most common district, else null.
 */
export function areaNameFromAddresses(addresses) {
  const count = (items) => {
    const tally = new Map();
    items.filter(Boolean).forEach((x) => tally.set(x, (tally.get(x) || 0) + 1));
    return [...tally].sort((a, b) => b[1] - a[1])[0];
  };
  const parts = addresses.map((a) => {
    const rest = String(a || "").replace(/^\d{3,6}/, "").replace(/^(台灣|臺灣)/, "");
    const district = rest.match(/^[^市縣]{1,3}[市縣]([^區鄉鎮市]{1,3}[區鄉鎮市])/)?.[1] || null;
    const afterDistrict = district ? rest.slice(rest.indexOf(district) + district.length) : rest;
    const road = afterDistrict.match(/^(?:[^\d路街道巷]{0,4}里)?(?:\d+鄰)?([^\d巷弄號]{1,8}?(?:路|街|大道)(?:[一二三四五六七八九十]+段)?)/)?.[1] || null;
    return { road, district };
  });
  const road = count(parts.map((p) => p.road));
  if (road && road[1] >= Math.max(2, Math.ceil(addresses.length / 2))) return `${road[0]}一帶`;
  const district = count(parts.map((p) => p.district));
  return district ? district[0] : road ? `${road[0]}一帶` : null;
}

/** "西門" / "捷運西門站" / "Ximen Station" → "捷運西門站" style label. */
export function stationLabel(name) {
  let n = String(name || "").trim().replace(/[(（].*?[)）]/g, "").trim();
  if (!n) return null;
  if (/車站$/.test(n)) return n;
  if (!/站$/.test(n)) n += "站";
  return /^捷運/.test(n) ? n : `捷運${n}`;
}
