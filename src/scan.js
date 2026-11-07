/**
 * Scans flatfox, wgzimmer, ronorp and students.ch, writes each source's
 * cache to data/, records the scan status and when each listing was first seen.
 */

import fs from "fs";
import {
  MAX_PRICE,
  FLATFOX_BOUNDS,
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  RONORP_CACHE_FILE,
  STUDENTS_CACHE_FILE,
  SCAN_STATUS_FILE,
  fetchFlatfoxDetails,
  ensureDataDir,
  loadSeen,
  saveSeen,
} from "./lib.js";
import { scrapeWgzimmer } from "./sources/wgzimmer-scrape.mjs";
import { scrapeRonorp } from "./sources/ronorp-scrape.mjs";
import { scrapeStudents } from "./sources/students-scrape.mjs";

const FLATFOX_PIN_LIMIT = 1000;
const FLATFOX_MAX_SPLIT_DEPTH = 4;

/**
 * Fetch every pin inside the bounds. A response that reaches the API limit
 * may be truncated, so the area is then split into quadrants and each one
 * fetched separately.
 */
async function fetchFlatfoxPins(bounds, depth = 0) {
  const url = new URL("https://flatfox.ch/api/v1/pin/");
  url.searchParams.set("north", bounds.north);
  url.searchParams.set("south", bounds.south);
  url.searchParams.set("east", bounds.east);
  url.searchParams.set("west", bounds.west);
  url.searchParams.set("object_category", "SHARED");
  url.searchParams.set("max_price", MAX_PRICE);
  url.searchParams.set("ordering", "-created");
  url.searchParams.set("max_count", FLATFOX_PIN_LIMIT);

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Flatfox API ${resp.status}`);
  const pins = await resp.json();
  if (pins.length < FLATFOX_PIN_LIMIT || depth >= FLATFOX_MAX_SPLIT_DEPTH) {
    return pins;
  }

  const midLat = (bounds.north + bounds.south) / 2;
  const midLng = (bounds.east + bounds.west) / 2;
  const quadrants = [
    { ...bounds, south: midLat, east: midLng },
    { ...bounds, south: midLat, west: midLng },
    { ...bounds, north: midLat, east: midLng },
    { ...bounds, north: midLat, west: midLng },
  ];
  const all = [];
  for (const quadrant of quadrants) {
    all.push(...(await fetchFlatfoxPins(quadrant, depth + 1)));
  }
  return all;
}

async function scanFlatfox() {
  const pinsByPk = new Map();
  for (const p of await fetchFlatfoxPins(FLATFOX_BOUNDS)) pinsByPk.set(p.pk, p);
  const pins = [...pinsByPk.values()];
  try {
    const details = await fetchFlatfoxDetails(pins.map((p) => p.pk));
    for (const p of pins) Object.assign(p, details.get(p.pk));
  } catch (e) {
    console.log(`flatfox details unavailable (${e.message})`);
  }
  fs.writeFileSync(FLATFOX_CACHE_FILE, JSON.stringify(pins, null, 2));
  return pins.map((p) => ({ id: `flatfox-${p.pk}`, price: p.price_display }));
}

async function scanWgzimmer() {
  const listings = await scrapeWgzimmer(MAX_PRICE);
  if (listings.length === 0) throw new Error("0 listings returned");
  fs.writeFileSync(WGZIMMER_LISTINGS_FILE, JSON.stringify(listings, null, 2));
  return listings
    .filter((l) => l.price && l.price <= MAX_PRICE)
    .map((l) => ({
      id: `wgzimmer-${l.url.match(/([a-f0-9-]{36})/)?.[1] || l.url.slice(-30)}`,
      price: l.price,
    }));
}

async function scanRonorp() {
  const listings = await scrapeRonorp();
  fs.writeFileSync(RONORP_CACHE_FILE, JSON.stringify(listings, null, 2));
  return listings
    .filter((l) => l.price && l.price <= MAX_PRICE)
    .map((l) => ({ id: `ronorp-${l.url.split("/").pop()}`, price: l.price }));
}

async function scanStudents() {
  const listings = await scrapeStudents();
  fs.writeFileSync(STUDENTS_CACHE_FILE, JSON.stringify(listings, null, 2));
  return listings
    .filter((l) => l.price && l.price <= MAX_PRICE)
    .map((l) => ({
      id: `students-${l.url.match(/details\/(\d+)/)[1]}`,
      price: l.price,
    }));
}

const SOURCES = {
  flatfox: scanFlatfox,
  wgzimmer: scanWgzimmer,
  ronorp: scanRonorp,
  students: scanStudents,
};

/** Scan every source and return the scan status that was written. */
export async function scan() {
  ensureDataDir();
  const sources = {};
  const found = [];
  for (const [name, scanSource] of Object.entries(SOURCES)) {
    try {
      const listings = await scanSource();
      console.log(`${name}: ${listings.length} listings`);
      found.push(...listings);
      sources[name] = { ok: true, count: listings.length };
    } catch (e) {
      console.log(`${name}: ${e.message}`);
      sources[name] = { ok: false, error: e.message.split("\n")[0] };
    }
  }

  const status = { finishedAt: new Date().toISOString(), sources };
  fs.writeFileSync(SCAN_STATUS_FILE, JSON.stringify(status, null, 2));

  const seen = loadSeen();
  for (const l of found) {
    seen[l.id] ||= { firstSeen: status.finishedAt, price: l.price };
  }
  saveSeen(seen);
  return status;
}
