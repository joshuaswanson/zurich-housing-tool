#!/usr/bin/env node
/**
 * Search wgzimmer + flatfox listings with filters.
 * Reads from cached data files (both wgzimmer and flatfox).
 *
 * Usage:
 *   node search.js                           # All listings from cache
 *   node search.js --max-price 800           # Price filter
 *   node search.js --near-eth               # <15 min walk from ETH Zentrum
 *   node search.js --no-woko                # Exclude WOKO/JUWO properties
 *   node search.js --permanent              # Only "No time restrictions"
 *   node search.js --not-tracked            # Exclude already applied/excluded/rejected
 *   node search.js --sort distance          # Sort by distance (default: price)
 *   node search.js --limit 10               # Max results
 *   node search.js --include-gendered       # Include gender-restricted listings
 *   node search.js --include-short          # Include short sublets (<2 months)
 *   node search.js --fetch N               # Fetch details for top N uncached results
 *   node search.js --max-dist N            # Max distance from ETH in km
 */

import fs from "fs";
import path from "path";
import {
  ETH_ZENTRUM,
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  RONORP_CACHE_FILE,
  LISTINGS_DIR,
  TRACKER_FILE,
  distKm,
  cacheKeyFromUrl,
  ensureDataDir,
} from "./lib.js";

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
}
function hasFlag(name) {
  return args.includes(name);
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`Usage: node search.js [options]
  --max-price N         Max rent in CHF
  --near-eth            Within ~15 min walk of ETH Zentrum
  --max-dist N          Max distance from ETH in km (flatfox only, precise)
  --no-woko             Exclude WOKO/JUWO properties
  --permanent           Only unlimited duration
  --not-tracked         Exclude applied/excluded/rejected
  --include-gendered    Include gender-restricted listings (filtered by default)
  --include-short       Include short sublets <2 months (filtered by default)
  --sort distance|price Sort order (default: price)
  --limit N             Max results (default 20)
  --fetch N             Fetch details for top N uncached results`);
  process.exit(0);
}

const maxPrice = getArg("--max-price") ? parseInt(getArg("--max-price")) : null;
const nearETH = hasFlag("--near-eth");
const noWoko = hasFlag("--no-woko");
const permanent = hasFlag("--permanent");
const notTracked = hasFlag("--not-tracked");
const includeGendered = hasFlag("--include-gendered");
const includeShort = hasFlag("--include-short");
const sortBy = getArg("--sort") || "price";
const limit = getArg("--limit") ? parseInt(getArg("--limit")) : 20;
const maxDist = getArg("--max-dist") ? parseFloat(getArg("--max-dist")) : null;
const fetchCount = getArg("--fetch") ? parseInt(getArg("--fetch")) : 0;

// ── Gender restriction detection ─────────────────────────────────────────────

/**
 * Returns true if the text indicates the listing is restricted to female tenants.
 * Must avoid false positives: "Mitbewohner oder Mitbewohnerin" is NOT restricted.
 */
function isGenderRestricted(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  // Negative patterns: inclusive phrasing (not restricted)
  if (/mitbewohner(?:in)?\s+(?:oder|or|\/)\s*mitbewohnerin/i.test(text))
    return false;
  if (/mitbewohnerin\s+(?:oder|or|\/)\s*mitbewohner(?!in)/i.test(text))
    return false;
  if (/(?:m|w|d)\s*\/\s*(?:m|w|d)\s*\/\s*(?:m|w|d)/i.test(text)) return false;

  // Positive patterns: female-only
  if (/\bmitbewohnerin\b/i.test(text)) return true;
  if (/\bweiblich\b/i.test(text)) return true;
  if (/\bfemale only\b/i.test(text)) return true;
  if (/\bgirls[- ]?wg\b/i.test(text)) return true;
  if (/\bnur frauen\b/i.test(text)) return true;
  if (/\bfrauen[- ]?wg\b/i.test(text)) return true;
  if (/\bonly.{0,10}(?:women|female|girl)/i.test(text)) return true;
  if (/\b(?:women|female|girl).{0,10}only\b/i.test(text)) return true;
  if (/\breine.{0,5}frauen/i.test(text)) return true;
  if (/\bsuchen.{0,20}mitbewohnerin\b/i.test(text)) return true;

  return false;
}

/**
 * Returns true if the listing is a short sublet (<2 months).
 * Parses available-from and until dates.
 */
function isShortSublet(listing) {
  const from = listing.availableFrom || listing.date;
  const until = listing.until;

  if (!from || !until) return false;

  // Skip "No time restrictions" / "unbefristet"
  const untilLower = until.toLowerCase();
  if (
    untilLower.includes("no time") ||
    untilLower.includes("unbefristet") ||
    untilLower === "?"
  )
    return false;

  // Try to parse dates in dd.mm.yyyy format
  const parseDate = (s) => {
    const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (!m) return null;
    return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  };

  const fromDate = parseDate(from);
  const untilDate = parseDate(until);

  if (!fromDate || !untilDate) return false;

  const diffMs = untilDate - fromDate;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // Less than ~60 days = short sublet
  return diffDays > 0 && diffDays < 60;
}

// ── Load tracker ─────────────────────────────────────────────────────────────

const trackedIds = new Set();
const trackedPks = new Set();
const trackedAddresses = new Set();
if (notTracked && fs.existsSync(TRACKER_FILE)) {
  const tracker = JSON.parse(fs.readFileSync(TRACKER_FILE, "utf8"));
  for (const cat of ["applied", "excluded", "rejected", "shortlisted"]) {
    for (const e of tracker[cat] || []) {
      const uuid = e.url.match(/([a-f0-9-]{36})/)?.[1];
      if (uuid) trackedIds.add(uuid);
      const pk = e.url.match(/\/(\d{5,})\/?/)?.[1];
      if (pk) trackedPks.add(pk);
      // Collect addresses for same-address dedup
      if (e.address) {
        const normalized = e.address
          .replace(/\s*\(.*\)/, "")
          .trim()
          .toLowerCase();
        trackedAddresses.add(normalized);
      }
    }
  }
  // Also check cached listing details for addresses
  if (fs.existsSync(LISTINGS_DIR)) {
    for (const id of [
      ...trackedIds,
      ...Array.from(trackedPks).map((p) => `flatfox-${p}`),
    ]) {
      const file = path.join(LISTINGS_DIR, id + ".json");
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data.address)
          trackedAddresses.add(data.address.trim().toLowerCase());
      }
    }
  }
}

// ── Load cached listing details for WOKO detection ───────────────────────────

const wokoIds = new Set();
if (noWoko && fs.existsSync(LISTINGS_DIR)) {
  for (const f of fs
    .readdirSync(LISTINGS_DIR)
    .filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(
      fs.readFileSync(path.join(LISTINGS_DIR, f), "utf8"),
    );
    const text = JSON.stringify(data).toLowerCase();
    if (text.includes("woko") || text.includes("juwo")) {
      wokoIds.add(f.replace(".json", ""));
    }
  }
}

// ── Near-ETH patterns ────────────────────────────────────────────────────────

const NEAR_ETH_PATTERN =
  /Kreis 1(?!\d)|Kreis 6|Hottingen|Oberstrass|Unterstrass|Fluntern|8001 |8006 |8032 |8044 /i;
const ETH_WALK_PATTERN =
  /(\d+)\s*(?:min|'|Minuten).*(?:zu Fuss|walk|Fuss).*(?:ETH|UZH)|(?:ETH|UZH).*(\d+)\s*(?:min|'|Minuten).*(?:zu Fuss|walk)|(\d+)\s*(?:min|').*(?:ETH HG|ETH Zentrum|UZH Zentrum)/i;

const allResults = [];

// ── wgzimmer ─────────────────────────────────────────────────────────────────

if (fs.existsSync(WGZIMMER_LISTINGS_FILE)) {
  const listings = JSON.parse(fs.readFileSync(WGZIMMER_LISTINGS_FILE, "utf8"));

  for (const l of listings) {
    if (!l.price) continue;
    const id = l.url.match(/([a-f0-9-]{36})/)?.[1];
    const text = (l.description || "") + " " + (l.neighborhood || "");

    if (maxPrice && l.price > maxPrice) continue;
    if (notTracked && trackedIds.has(id)) continue;

    // Same-address dedup
    if (notTracked && trackedAddresses.size > 0 && id) {
      const cachedPath = path.join(LISTINGS_DIR, id + ".json");
      if (fs.existsSync(cachedPath)) {
        const cached = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
        if (
          cached.address &&
          trackedAddresses.has(cached.address.trim().toLowerCase())
        )
          continue;
      }
    }

    // Gender filter (default on)
    if (!includeGendered) {
      // Check listing text and cached detail
      let genderText = text;
      if (id) {
        const cachedPath = path.join(LISTINGS_DIR, id + ".json");
        if (fs.existsSync(cachedPath)) {
          const cached = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
          genderText +=
            " " +
            (cached.lookingFor || "") +
            " " +
            (cached.room || "") +
            " " +
            (cached.weAre || "");
        }
      }
      if (isGenderRestricted(genderText)) continue;
    }

    // Short sublet filter (default on)
    if (!includeShort && isShortSublet(l)) continue;

    if (noWoko) {
      if (id && wokoIds.has(id)) continue;
      if (/WOKO|woko|under 28|unter 28|JUWO|juwo/i.test(text)) continue;
    }

    if (nearETH) {
      const inHood = NEAR_ETH_PATTERN.test(text);
      const walkMatch = text.match(ETH_WALK_PATTERN);
      let closeWalk = false;
      if (walkMatch) {
        const mins = parseInt(walkMatch[1] || walkMatch[2] || walkMatch[3]);
        if (mins <= 15) closeWalk = true;
      }
      if (!inHood && !closeWalk) continue;
    }

    if (permanent) {
      const until = (l.until || "").toLowerCase();
      if (
        !until.includes("no time") &&
        !until.includes("unbefristet") &&
        until !== "?"
      )
        continue;
    }

    allResults.push({
      source: "wgzimmer",
      price: l.price,
      dist: null,
      label: `${l.neighborhood || "?"} | avail: ${l.availableFrom || "?"}${l.until ? " | until: " + l.until : ""}`,
      desc: (l.description || "").substring(0, 140),
      url: l.url,
    });
  }
}

// ── flatfox (from cache file, no live API call) ──────────────────────────────

if (fs.existsSync(FLATFOX_CACHE_FILE)) {
  const distLimit = maxDist || (nearETH ? 1.0 : 5.0);
  const priceLimit = maxPrice || 2000;

  const pins = JSON.parse(fs.readFileSync(FLATFOX_CACHE_FILE, "utf8"));

  for (const p of pins) {
    const km = distKm(ETH_ZENTRUM, { lat: p.latitude, lng: p.longitude });
    if (km > distLimit) continue;
    if (maxPrice && p.price_display > maxPrice) continue;
    if (priceLimit && p.price_display > priceLimit) continue;
    if (notTracked && trackedPks.has(String(p.pk))) continue;

    const ffUrl = `https://flatfox.ch/en/flat/8001-zurich/${p.pk}/`;
    const ffCacheKey = `flatfox-${p.pk}`;

    // Same-address dedup: skip if we already applied to this address
    if (notTracked && trackedAddresses.size > 0) {
      const cachedPath = path.join(LISTINGS_DIR, ffCacheKey + ".json");
      if (fs.existsSync(cachedPath)) {
        const cached = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
        if (
          cached.address &&
          trackedAddresses.has(cached.address.trim().toLowerCase())
        )
          continue;
      }
    }

    // Gender filter
    if (!includeGendered) {
      const cachedPath = path.join(LISTINGS_DIR, ffCacheKey + ".json");
      if (fs.existsSync(cachedPath)) {
        const cached = JSON.parse(fs.readFileSync(cachedPath, "utf8"));
        const detailText =
          (cached.description || "") +
          " " +
          (cached.particulars || "") +
          " " +
          (cached.address || "");
        if (isGenderRestricted(detailText)) continue;
      }
    }

    // Check cached details for WOKO
    if (noWoko) {
      if (wokoIds.has(ffCacheKey)) continue;
    }

    allResults.push({
      source: "flatfox",
      price: p.price_display,
      dist: km,
      label: `${km.toFixed(2)} km (~${Math.round(km * 12)} min walk)`,
      desc: "",
      url: ffUrl,
    });
  }
}

// ── ronorp ────────────────────────────────────────────────────────────────────

if (fs.existsSync(RONORP_CACHE_FILE)) {
  const listings = JSON.parse(fs.readFileSync(RONORP_CACHE_FILE, "utf8"));

  for (const l of listings) {
    if (!l.price || !l.isOffer) continue;
    if (maxPrice && l.price > maxPrice) continue;

    const slug = l.url.split("/").pop();
    if (notTracked) {
      // Check by URL slug
      const isTracked = [...trackedIds, ...trackedPks].some(
        (id) => slug.includes(id) || id.includes(slug),
      );
      if (isTracked) continue;
      // Address dedup
      if (l.address && trackedAddresses.has(l.address.trim().toLowerCase()))
        continue;
    }

    const text = l.description || "";
    if (noWoko && /WOKO|woko|under 28|unter 28|JUWO|juwo/i.test(text)) continue;
    if (!includeGendered && isGenderRestricted(text)) continue;

    allResults.push({
      source: "ronorp",
      price: l.price,
      dist: null,
      label: `${l.address || "Zürich"} | ${text.substring(0, 80)}`,
      desc: "",
      url: l.url,
    });
  }
}

// ── Sort & print ─────────────────────────────────────────────────────────────

if (sortBy === "distance") {
  allResults.sort(
    (a, b) => (a.dist ?? 999) - (b.dist ?? 999) || a.price - b.price,
  );
} else {
  allResults.sort((a, b) => a.price - b.price);
}

const displayed = allResults.slice(0, limit);

for (const r of displayed) {
  const cached = cacheKeyFromUrl(r.url);
  const hasCached =
    cached && fs.existsSync(path.join(LISTINGS_DIR, cached + ".json"));
  const tag = hasCached ? " *" : "";
  console.log(`[${r.source}] CHF ${r.price} | ${r.label}${tag}`);
  if (r.desc) console.log(`  ${r.desc}`);
  console.log(`  ${r.url}`);
  console.log();
}

console.log(
  `Showing ${Math.min(allResults.length, limit)} of ${allResults.length} matches`,
);
if (!includeGendered)
  console.log("  (gender-restricted listings hidden, use --include-gendered)");
if (!includeShort)
  console.log("  (short sublets <2mo hidden, use --include-short)");

// ── Batch fetch (--fetch N) ──────────────────────────────────────────────────

if (fetchCount > 0) {
  // Find top N uncached results
  const uncached = displayed.filter((r) => {
    const key = cacheKeyFromUrl(r.url);
    return key && !fs.existsSync(path.join(LISTINGS_DIR, key + ".json"));
  });

  const toFetch = uncached.slice(0, fetchCount);
  if (toFetch.length === 0) {
    console.log("\nAll displayed results are already cached.");
  } else {
    console.log(
      `\nFetching details for ${toFetch.length} uncached listing(s)...`,
    );
    // Dynamic import to avoid loading cloakbrowser unless needed
    const { fetchListings } = await import("./fetch-listing.mjs");
    const results = await fetchListings(toFetch.map((r) => r.url));
    for (const { url, data } of results) {
      if (data) {
        console.log(`\n  ${data.address || "?"} — CHF ${data.rent || "?"}/mo`);
        console.log(`  ${url}`);
      }
    }
  }
}
