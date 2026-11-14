import assert from "node:assert/strict";
import test from "node:test";
import { priceRows, records, stationRows, upserts } from "../scripts/fetch.mjs";
import worker, { distance } from "../src/worker.js";

test("records are found inside a wrapper", () => {
  assert.deepEqual(records({ data: [{ node_id: "a" }] }), [{ node_id: "a" }]);
  assert.deepEqual(records([{ node_id: "a" }]), [{ node_id: "a" }]);
});

test("stations: quotes escaped, closures kept, rows without a place dropped", () => {
  const rows = stationRows([
    { node_id: "1", trading_name: "Bob's Garage", location: { latitude: "51.5", longitude: -0.7 } },
    { node_id: 2, brand_name: "Shell", location: { latitude: 51.6, longitude: -0.8 }, permanent_closure: true },
    { node_id: "3", trading_name: "No place", location: {} },
  ]);
  assert.deepEqual(rows, ["('1','Bob''s Garage',51.5,-0.7,0)", "('2','Shell',51.6,-0.8,1)"]);
});

test("prices: short names aliased, out-of-range prices dropped", () => {
  const rows = priceRows([{ node_id: "1", fuel_prices: [
    { fuel_type: "B7S", price: "149.9", price_last_updated: "2026-11-14T08:00:00Z" },
    { fuel_type: "E10", price: 1.399 },
  ] }]);
  assert.deepEqual(rows, ["('1','B7_STANDARD',149.9,'2026-11-14T08:00:00Z')"]);
  assert.match(upserts([], rows), /ON CONFLICT\(id,fuel\) DO UPDATE/);
});

test("nearby: key checked, nearest first, prices grouped", async () => {
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [
    { id: "far", name: "Far", lat: 51.5005, lon: -0.7, fuel: "E10", pence: 140.9, updated: null },
    { id: "near", name: "Near", lat: 51.5001, lon: -0.7, fuel: "E10", pence: 139.9, updated: "x" },
    { id: "near", name: "Near", lat: 51.5001, lon: -0.7, fuel: "E5", pence: 155.9, updated: "x" },
  ] }) }) }) };
  const env = { APP_KEY: "k", DB: db };
  const url = "https://w/nearby?lat=51.5&lon=-0.7&radius=100";
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  const body = await (await worker.fetch(new Request(url, { headers: { "X-App-Key": "k" } }), env)).json();
  assert.deepEqual(body.stations.map((s) => s.name), ["Near", "Far"]);
  assert.deepEqual(Object.keys(body.stations[0].prices), ["E10", "E5"]);
  assert.ok(Math.abs(distance(51.5, -0.7, 51.5009, -0.7) - 100) < 1);
});
