/**
 * Scans the sources of both searches, rooms and apartments, writes each
 * source's cache to data/, records the scan status and when each listing was
 * first seen.
 */

import fs from "fs";
import {
  FLATFOX_BOUNDS,
  WGZIMMER_LISTINGS_FILE,
  STUDENTS_CACHE_FILE,
  ETHZ_CACHE_FILE,
  ETHZ_BROWSER_PROFILE_DIR,
  SCAN_STATUS_FILE,
  SEARCHES,
  fetchFlatfoxDetails,
  ensureDataDir,
  loadSeen,
  saveSeen,
  readJson,
} from "./lib.js";
import { scrapeWgzimmer } from "./sources/wgzimmer-scrape.mjs";
import { scrapeRonorp } from "./sources/ronorp-scrape.mjs";
import { scrapeStudents } from "./sources/students-scrape.mjs";
import {
  ethzListing,
  fetchEthzAdvertisements,
  withEthzPortal,
} from "./sources/ethz-housing.mjs";
import { ethzCredentials } from "./ethz-session.mjs";

const FLATFOX_PIN_LIMIT = 1000;
const FLATFOX_MAX_SPLIT_DEPTH = 4;

/**
 * Fetch every pin inside the bounds. A response that reaches the API limit
 * may be truncated, so the area is then split into quadrants and each one
 * fetched separately.
 */
async function fetchFlatfoxPins(search, bounds, depth = 0) {
  const url = new URL("https://flatfox.ch/api/v1/pin/");
  url.searchParams.set("north", bounds.north);
  url.searchParams.set("south", bounds.south);
  url.searchParams.set("east", bounds.east);
  url.searchParams.set("west", bounds.west);
  for (const category of search.flatfoxCategories) {
    url.searchParams.append("object_category", category);
  }
  url.searchParams.set("max_price", search.maxPrice);
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
    all.push(...(await fetchFlatfoxPins(search, quadrant, depth + 1)));
  }
  return all;
}

async function scanFlatfox(search) {
  const pinsByPk = new Map();
  for (const p of await fetchFlatfoxPins(search, FLATFOX_BOUNDS)) {
    pinsByPk.set(p.pk, p);
  }
  const pins = [...pinsByPk.values()];
  try {
    const details = await fetchFlatfoxDetails(pins.map((p) => p.pk));
    for (const p of pins) Object.assign(p, details.get(p.pk));
  } catch (e) {
    console.log(`flatfox details unavailable (${e.message})`);
  }
  fs.writeFileSync(search.flatfoxCache, JSON.stringify(pins, null, 2));
  return pins.map((p) => ({ id: `flatfox-${p.pk}`, price: p.price_display }));
}

async function scanWgzimmer(search) {
  const listings = await scrapeWgzimmer(search.maxPrice);
  if (listings.length === 0) throw new Error("0 listings returned");
  fs.writeFileSync(WGZIMMER_LISTINGS_FILE, JSON.stringify(listings, null, 2));
  return listings
    .filter((l) => l.price && l.price <= search.maxPrice)
    .map((l) => ({
      id: `wgzimmer-${l.url.match(/([a-f0-9-]{36})/)?.[1] || l.url.slice(-30)}`,
      price: l.price,
    }));
}

async function scanRonorp(search) {
  const listings = await scrapeRonorp(search.ronorpSubcategories);
  fs.writeFileSync(search.ronorpCache, JSON.stringify(listings, null, 2));
  return listings
    .filter((l) => l.price && l.price <= search.maxPrice)
    .map((l) => ({ id: `ronorp-${l.url.split("/").pop()}`, price: l.price }));
}

async function scanStudents(search) {
  const listings = await scrapeStudents();
  fs.writeFileSync(STUDENTS_CACHE_FILE, JSON.stringify(listings, null, 2));
  return listings
    .filter((l) => l.price && l.price <= search.maxPrice)
    .map((l) => ({
      id: `students-${l.url.match(/details\/(\d+)/)[1]}`,
      price: l.price,
    }));
}

// One fetch covers both searches, and the ETH Housing Office is left out
// until the user signs in to it.
const NOT_SIGNED_IN = Symbol("not signed in");
let ethzScan = null;

async function scanEthz(search) {
  ethzScan ||= (async () => {
    const credentials = await ethzCredentials();
    if (!credentials) return NOT_SIGNED_IN;
    const ads = await withEthzPortal(ETHZ_BROWSER_PROFILE_DIR, credentials, fetchEthzAdvertisements);
    fs.writeFileSync(ETHZ_CACHE_FILE, JSON.stringify(ads, null, 2));
    return ads;
  })();
  const ads = await ethzScan;
  if (ads === NOT_SIGNED_IN) return NOT_SIGNED_IN;
  return ads
    .map(ethzListing)
    .filter((l) => search.ethzTypes.includes(l.type) && l.price && l.price <= search.maxPrice)
    .map((l) => ({ id: l.id, price: l.price }));
}

const SOURCES = {
  flatfox: scanFlatfox,
  wgzimmer: scanWgzimmer,
  ronorp: scanRonorp,
  students: scanStudents,
  ethz: scanEthz,
};

// Expected length of a step that has not run before.
const DEFAULT_STEP_MS = 15000;

/** The scan's steps in order, one per source and search. */
async function scanSteps() {
  const signedIn = Boolean(await ethzCredentials());
  return Object.entries(SEARCHES).flatMap(([type, search]) =>
    search.sources
      .filter((name) => name !== "ethz" || signedIn)
      .map((name) => ({ type, search, name, key: `${type}:${name}` })),
  );
}

/**
 * Scan every source of both searches and return the scan status that was
 * written. A source that fails for either search counts as failed.
 * onProgress gets the steps with how long each took last time, the current
 * step and how many listings were found so far.
 */
export async function scan({ onProgress = () => {} } = {}) {
  ensureDataDir();
  ethzScan = null;
  const sources = {};
  const found = [];
  const previous = readJson(SCAN_STATUS_FILE, null)?.durations || {};
  const durations = {};
  const steps = await scanSteps();
  const plan = steps.map(({ type, name, key }) => ({
    type,
    source: name,
    expectedMs: previous[key] || DEFAULT_STEP_MS,
  }));
  for (const [index, { type, search, name, key }] of steps.entries()) {
    onProgress({ steps: plan, current: index, startedAt: Date.now(), found: found.length });
    const started = Date.now();
    try {
      const listings = await SOURCES[name](search);
      if (listings === NOT_SIGNED_IN) continue;
      console.log(`${name} (${type}): ${listings.length} listings`);
      found.push(...listings);
      if (sources[name]?.ok !== false) {
        sources[name] = {
          ok: true,
          count: (sources[name]?.count || 0) + listings.length,
        };
      }
    } catch (e) {
      console.log(`${name} (${type}): ${e.message}`);
      sources[name] = { ok: false, error: e.message.split("\n")[0] };
    }
    durations[key] = Date.now() - started;
  }

  const status = { finishedAt: new Date().toISOString(), sources, durations };
  fs.writeFileSync(SCAN_STATUS_FILE, JSON.stringify(status, null, 2));

  const seen = loadSeen();
  for (const l of found) {
    seen[l.id] ||= { firstSeen: status.finishedAt, price: l.price };
  }
  saveSeen(seen);
  return status;
}
