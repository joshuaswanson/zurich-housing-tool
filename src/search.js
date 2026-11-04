#!/usr/bin/env node
/**
 * Search the cached listings from all four sources with filters.
 * Uses the same listing list as the dashboard.
 *
 * Usage:
 *   node src/search.js                           # All listings from cache
 *   node src/search.js --max-price 800           # Price filter
 *   node src/search.js --max-dist 2.0            # Max distance from the target in km
 *   node src/search.js --no-woko                 # Exclude WOKO/JUWO properties
 *   node src/search.js --permanent               # Only listings without an end date
 *   node src/search.js --not-tracked             # Exclude applied/shortlisted/excluded/rejected
 *   node src/search.js --sort distance           # Sort by distance (default: price)
 *   node src/search.js --limit 10                # Max results
 *   node src/search.js --include-gendered        # Include gender-restricted listings
 *   node src/search.js --include-short           # Include short sublets
 *   node src/search.js --fetch N                 # Fetch details for top N uncached results
 *   node src/search.js --keyword <pattern>       # Filter by keyword/regex
 *   node src/search.js --new [hours]             # Only listings first seen within N hours (default 24)
 */

import {
  config,
  MAX_PRICE,
  TRACKER_FILE,
  cacheKeyFromUrl,
  listingKey,
  loadCachedListing,
  readJson,
} from "./lib.js";
import { loadAllListings } from "./listings.js";

const cfgExclude = config.exclude || {};

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}
function hasFlag(name) {
  return args.includes(name);
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`Usage: node src/search.js [options]
  --max-price N         Max rent in CHF (default: maxPrice from config)
  --max-dist N          Max distance from the target in km
  --no-woko             Exclude WOKO/JUWO properties
  --permanent           Only listings without an end date
  --not-tracked         Exclude applied/shortlisted/excluded/rejected
  --include-gendered    Include gender-restricted listings (filtered by default)
  --include-short       Include short sublets (filtered by default)
  --sort distance|price Sort order (default: price)
  --limit N             Max results (default 20)
  --keyword <pattern>   Filter by keyword/regex in description and address
  --new [hours]         Only listings first seen within N hours (default 24)
  --fetch N             Fetch details for top N uncached results`);
  process.exit(0);
}

const maxPrice = parseInt(getArg("--max-price")) || MAX_PRICE;
const maxDist = getArg("--max-dist") ? parseFloat(getArg("--max-dist")) : null;
const noWoko = hasFlag("--no-woko") || cfgExclude.woko === true;
const permanent = hasFlag("--permanent");
const notTracked = hasFlag("--not-tracked");
const excludeGendered =
  !hasFlag("--include-gendered") && cfgExclude.genderRestricted !== false;
const excludeShort =
  !hasFlag("--include-short") && cfgExclude.shortSublets !== false;
const sortBy = getArg("--sort") || "price";
const keyword = getArg("--keyword")
  ? new RegExp(getArg("--keyword"), "i")
  : null;
const limit = getArg("--limit") ? parseInt(getArg("--limit")) : 20;
const fetchCount = getArg("--fetch") ? parseInt(getArg("--fetch")) : 0;
const newHours = (() => {
  if (!hasFlag("--new")) return null;
  const value = getArg("--new");
  return value && /^\d+$/.test(value) ? parseInt(value) : 24;
})();

// ── Tracked listings ─────────────────────────────────────────────────────────

const normalizeAddress = (address) =>
  address.replace(/\s*\(.*\)/, "").trim().toLowerCase();

const trackedKeys = new Set();
const trackedAddresses = new Set();
if (notTracked) {
  const tracker = readJson(TRACKER_FILE, {});
  for (const category of ["applied", "excluded", "rejected", "shortlisted"]) {
    for (const entry of tracker[category] || []) {
      trackedKeys.add(listingKey(entry.url));
      const address = entry.address || loadCachedListing(entry.url)?.address;
      if (address) trackedAddresses.add(normalizeAddress(address));
    }
  }
}

// ── Filtering ────────────────────────────────────────────────────────────────

// Reposts of the same room under a new URL share their description.
const descriptionFingerprint = (description) =>
  description.replace(/\s+/g, " ").trim().toLowerCase().substring(0, 200);
const seenDescriptions = new Set();

function isTracked(listing) {
  return (
    trackedKeys.has(listingKey(listing.url)) ||
    (listing.address && trackedAddresses.has(normalizeAddress(listing.address)))
  );
}

function isRepost(listing) {
  if (!listing.description) return false;
  const fingerprint = descriptionFingerprint(listing.description);
  if (seenDescriptions.has(fingerprint)) return true;
  seenDescriptions.add(fingerprint);
  return false;
}

const newCutoff = newHours ? Date.now() - newHours * 60 * 60 * 1000 : null;

const results = loadAllListings()
  .sort((a, b) => a.price - b.price)
  .filter((l) => {
    if (l.price > maxPrice) return false;
    if (maxDist && l.dist !== null && l.dist > maxDist) return false;
    if (newCutoff && l.firstSeen && new Date(l.firstSeen) < newCutoff)
      return false;
    if (permanent && l.hasEndDate) return false;
    if (keyword && !keyword.test(`${l.description} ${l.address || ""}`))
      return false;
    if (noWoko && l.studentHousing) return false;
    if (excludeGendered && l.genderRestricted) return false;
    if (excludeShort && l.shortSublet) return false;
    if (l.bulkPoster) return false;
    if (notTracked && isTracked(l)) return false;
    return !isRepost(l);
  });

if (sortBy === "distance") {
  results.sort((a, b) => (a.dist ?? 999) - (b.dist ?? 999) || a.price - b.price);
}

// ── Output ───────────────────────────────────────────────────────────────────

const displayed = results.slice(0, limit);

for (const l of displayed) {
  const distance =
    l.dist !== null
      ? `${l.dist.toFixed(1)} km (~${Math.round(l.dist * 12)} min walk) | `
      : "";
  const dates = `avail: ${l.availableFrom || "?"}${l.until ? " | until: " + l.until : ""}`;
  const tag = loadCachedListing(l.url) ? " *" : "";
  console.log(
    `[${l.source}] CHF ${l.price} | ${distance}${l.address || "?"} | ${dates}${tag}`,
  );
  const summary = l.description.split("\n")[0].substring(0, 140);
  if (summary) console.log(`  ${summary}`);
  console.log(`  ${l.url}`);
  console.log();
}

console.log(`Showing ${displayed.length} of ${results.length} matches`);
if (excludeGendered)
  console.log("  (gender-restricted listings hidden, use --include-gendered)");
if (excludeShort) console.log("  (short sublets hidden, use --include-short)");
if (newHours)
  console.log(`  (showing listings from last ${newHours}h only, --new ${newHours})`);

// ── Batch fetch (--fetch N) ──────────────────────────────────────────────────

if (fetchCount > 0) {
  const toFetch = displayed
    .filter((l) => cacheKeyFromUrl(l.url) && !loadCachedListing(l.url))
    .slice(0, fetchCount);
  if (toFetch.length === 0) {
    console.log("\nAll displayed results are already cached.");
  } else {
    console.log(`\nFetching details for ${toFetch.length} uncached listing(s)...`);
    const { fetchListings } = await import("./fetch-listing.mjs");
    const fetched = await fetchListings(toFetch.map((l) => l.url));
    for (const { url, data } of fetched) {
      console.log(`\n  ${data.address || "?"} | CHF ${data.rent || "?"}/mo`);
      console.log(`  ${url}`);
    }
  }
}
