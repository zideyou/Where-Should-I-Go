import { test } from "node:test";
import assert from "node:assert/strict";
import { bestCombos, bestRoute, directionsUrl, filterGroups, formatKm, haversineKm } from "../src/geo.js";

test("haversine: known distance (Times Square -> Central Park south ~1.3 km)", () => {
  const km = haversineKm({ lat: 40.758, lng: -73.9855 }, { lat: 40.7681, lng: -73.9819 });
  assert.ok(km > 1.1 && km < 1.3, `got ${km}`);
});

test("bestRoute orders points along a line", () => {
  const pts = [0, 3, 1, 4, 2].map((x) => ({ lat: 0, lng: x * 0.01 }));
  const { order } = bestRoute(pts);
  const xs = order.map((i) => pts[i].lng);
  const sorted = [...xs].sort((a, b) => a - b);
  assert.ok(
    JSON.stringify(xs) === JSON.stringify(sorted) || JSON.stringify(xs) === JSON.stringify(sorted.reverse()),
  );
});

test("bestRoute with fixedStart keeps index 0 first", () => {
  const pts = [{ lat: 0, lng: 0.02 }, { lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }, { lat: 0, lng: 0.03 }];
  const { order } = bestRoute(pts, { fixedStart: true });
  assert.equal(order[0], 0);
  assert.equal(order.length, 4);
});

test("bestRoute heuristic handles many points", () => {
  const pts = Array.from({ length: 15 }, (_, i) => ({ lat: 0, lng: ((i * 7) % 15) * 0.01 }));
  const { order, km } = bestRoute(pts);
  assert.equal(new Set(order).size, 15);
  // Optimal is walking the line end to end: 14 * ~1.11 km
  assert.ok(km < 14 * 1.12 + 0.01, `got ${km}`);
});

test("bestCombos picks the cluster of places that are together", () => {
  const near = { lat: 40, lng: -74 };
  const off = (d) => ({ lat: near.lat + d, lng: near.lng });
  const coffee = [off(0.5), off(0.0005)];   // second one is in the cluster
  const books = [off(0.001), off(-0.6)];    // first one is in the cluster
  const parks = [off(-0.3), off(0.3), off(0)];
  const [best] = bestCombos([coffee, books, parks]);
  assert.deepEqual(best.picks, [1, 0, 2]);
  assert.ok(best.km < 0.2);
});

test("bestCombos respects a starting point", () => {
  const home = { lat: 0, lng: 0 };
  const a = [{ lat: 0, lng: 0.001 }, { lat: 0, lng: 1 }];
  const b = [{ lat: 0, lng: 1.001 }, { lat: 0, lng: 0.002 }];
  const [best] = bestCombos([a, b], { start: home });
  assert.deepEqual(best.picks, [0, 1]);
  assert.deepEqual(best.order, [0, 1]);
});

test("bestCombos falls back to heuristic for huge inputs", () => {
  const group = () => Array.from({ length: 20 }, (_, i) => ({ lat: i * 0.01, lng: 0 }));
  const res = bestCombos([group(), group(), group(), group()], { limit: 3 });
  assert.equal(res.length, 3);
  assert.equal(res[0].km, 0);
});

test("bestCombos returns nothing when a group is empty", () => {
  assert.deepEqual(bestCombos([[{ lat: 0, lng: 0 }], []]), []);
});

test("formatKm", () => {
  assert.equal(formatKm(0.25), "250 m");
  assert.equal(formatKm(2.345), "2.3 km");
  assert.equal(formatKm(10, "mi"), "6.2 mi");
});

test("directionsUrl builds a Google Maps link with waypoints", () => {
  const url = new URL(
    directionsUrl(
      [
        { lat: 1, lng: 2, placeId: "A" },
        { lat: 3, lng: 4, placeId: "B" },
        { lat: 5, lng: 6, placeId: "C" },
      ],
      "walking",
    ),
  );
  assert.equal(url.searchParams.get("origin"), "1,2");
  assert.equal(url.searchParams.get("destination"), "5,6");
  assert.equal(url.searchParams.get("waypoints"), "3,4");
  assert.equal(url.searchParams.get("waypoint_place_ids"), "B");
  assert.equal(url.searchParams.get("travelmode"), "walking");
});

test("filterGroups: excluded places are dropped, pinned places replace their group", () => {
  const a = [{ placeId: "a1" }, { placeId: "a2" }, { placeId: "a3" }];
  const b = [{ placeId: "b1" }, { placeId: "b2" }];
  const out = filterGroups([a, b], { excluded: new Set(["a1", "b2"]), pinned: new Set(["a3"]) });
  assert.deepEqual(out.map((g) => g.map((p) => p.placeId)), [["a3"], ["b1"]]);
});

test("filterGroups: a group can become empty, and no filters keeps everything", () => {
  const a = [{ placeId: "a1" }];
  assert.deepEqual(filterGroups([a], { excluded: new Set(["a1"]) }), [[]]);
  assert.deepEqual(filterGroups([a]), [a]);
});
