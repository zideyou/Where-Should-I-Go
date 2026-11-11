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
