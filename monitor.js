#!/usr/bin/env node

/**
 * Zurich Housing Monitor — data acquisition.
 *
 * Refreshes both flatfox and wgzimmer sources, writes to data/,
 * updates seen.json.
 *
 * Usage:
 *   node monitor.js scan          # Refresh sources, print summary
 *   node monitor.js watch [mins]  # Poll every N minutes, alert on new
 *   node monitor.js links         # Show useful housing search links
 */

import fs from "fs";
import { execSync } from "child_process";
import {
  ETH_ZENTRUM,
  MAX_PRICE,
  MAX_DISTANCE_KM,
  DATA_DIR,
  FLATFOX_BOUNDS,
  WGZIMMER_CACHE_FILE,
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  ensureDataDir,
  loadSeen,
  saveSeen,
  distKm,
  walkMin,
  formatPrice,
  timestamp,
} from "./lib.js";
import { scrapeWgzimmer } from "./wgzimmer-scrape.mjs";

const WGZIMMER_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

// ── Flatfox Source ──────────────────────────────────────────────────────────

async function fetchFlatfox() {
  const url = new URL("https://flatfox.ch/api/v1/pin/");
  url.searchParams.set("north", FLATFOX_BOUNDS.north);
  url.searchParams.set("south", FLATFOX_BOUNDS.south);
  url.searchParams.set("east", FLATFOX_BOUNDS.east);
  url.searchParams.set("west", FLATFOX_BOUNDS.west);
  url.searchParams.set("object_category", "SHARED");
  url.searchParams.set("max_price", MAX_PRICE);
  url.searchParams.set("ordering", "-created");
  url.searchParams.set("max_count", "400");

  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Flatfox API ${resp.status}`);
  const pins = await resp.json();

  // Save raw pins to flatfox_cache.json for search.js
  ensureDataDir();
  fs.writeFileSync(FLATFOX_CACHE_FILE, JSON.stringify(pins, null, 2));

  return pins.map((p) => {
    const dist = distKm(ETH_ZENTRUM, { lat: p.latitude, lng: p.longitude });
    const d = 0.002;
    const searchUrl = `https://flatfox.ch/en/search/?east=${(p.longitude + d).toFixed(6)}&west=${(p.longitude - d).toFixed(6)}&north=${(p.latitude + d).toFixed(6)}&south=${(p.latitude - d).toFixed(6)}&object_category=SHARED`;
    return {
      id: `flatfox-${p.pk}`,
      source: "flatfox",
      price: p.price_display,
      lat: p.latitude,
      lng: p.longitude,
      distKm: Math.round(dist * 100) / 100,
      walkMin: walkMin(dist),
      url: searchUrl,
    };
  });
}

// ── wgzimmer Source ─────────────────────────────────────────────────────────

async function fetchWgzimmer() {
  ensureDataDir();

  // Check cache first
  if (fs.existsSync(WGZIMMER_CACHE_FILE)) {
    const stat = fs.statSync(WGZIMMER_CACHE_FILE);
    const age = Date.now() - stat.mtimeMs;
    if (age < WGZIMMER_CACHE_MAX_AGE_MS) {
      const cached = JSON.parse(fs.readFileSync(WGZIMMER_CACHE_FILE, "utf8"));
      if (cached.length > 0) {
        process.stdout.write(` (cached ${Math.round(age / 60000)}m ago)`);
        return cached;
      }
    }
  }

  // Use the imported scraper directly (no subprocess)
  const allListings = await scrapeWgzimmer(MAX_PRICE);

  // Save raw data
  fs.writeFileSync(
    WGZIMMER_LISTINGS_FILE,
    JSON.stringify(allListings, null, 2),
  );

  // Convert to standard format
  const result = allListings
    .filter((l) => l.price && l.price <= MAX_PRICE)
    .map((l) => {
      const uuid = l.url.match(/([a-f0-9-]{36})/)?.[1] || l.url.slice(-30);
      return {
        id: `wgzimmer-${uuid}`,
        source: "wgzimmer",
        price: l.price,
        title: `${l.neighborhood || "Zürich"} — ${l.description?.substring(0, 80) || ""}`,
        url: l.url,
        date: l.availableFrom,
        until: l.until,
        distKm: null,
        walkMin: null,
      };
    });

  // Cache results
  fs.writeFileSync(WGZIMMER_CACHE_FILE, JSON.stringify(result, null, 2));
  return result;
}

// ── Display ─────────────────────────────────────────────────────────────────

function printListings(
  listings,
  { showAll = false, maxDist = MAX_DISTANCE_KM } = {},
) {
  const filtered = (
    showAll
      ? listings
      : listings.filter((l) => l.distKm === null || l.distKm <= maxDist)
  ).filter((l) => !l.price || l.price <= MAX_PRICE);

  // Sort: by price first (cheapest first), then by distance
  filtered.sort((a, b) => {
    const pa = a.price || 9999;
    const pb = b.price || 9999;
    if (pa !== pb) return pa - pb;
    const da = a.distKm ?? 999;
    const db = b.distKm ?? 999;
    return da - db;
  });

  if (filtered.length === 0) {
    console.log("  No listings found matching criteria.");
    return;
  }

  const maxUrlLen = 70;
  for (const l of filtered) {
    const dist =
      l.distKm !== null
        ? `${l.distKm.toFixed(1)} km (~${l.walkMin} min walk)`
        : "distance unknown";
    const price = l.price ? formatPrice(l.price) : "price unknown";
    const title = l.title || "";
    const date = l.date ? ` | available: ${l.date}` : "";
    const url =
      l.url.length > maxUrlLen ? l.url.substring(0, maxUrlLen) + "..." : l.url;

    const until = l.until ? ` | until: ${l.until}` : "";
    console.log(`  [${l.source}] ${price} | ${dist}${date}${until}`);
    if (title) console.log(`    ${title}`);
    console.log(`    ${url}`);
    console.log();
  }

  // Summary
  const prices = filtered.filter((l) => l.price).map((l) => l.price);
  console.log(
    `  Total: ${filtered.length} listings` +
      (showAll
        ? ""
        : ` (flatfox within ${maxDist} km of ETH + all wgzimmer Zürich)`),
  );
  if (prices.length) {
    console.log(
      `  Price range: ${formatPrice(Math.min(...prices))} - ${formatPrice(Math.max(...prices))}`,
    );
    console.log(
      `  Under CHF 1'000: ${prices.filter((p) => p < 1000).length} | Under CHF 750: ${prices.filter((p) => p < 750).length}`,
    );
  }
}

// ── Refresh (exported for programmatic use) ─────────────────────────────────

export async function refresh() {
  const allListings = [];

  // Flatfox
  process.stdout.write("  Scanning flatfox.ch...");
  try {
    const ff = await fetchFlatfox();
    console.log(` ${ff.length} listings found`);
    allListings.push(...ff);
  } catch (e) {
    console.log(` error: ${e.message}`);
  }

  // wgzimmer
  process.stdout.write("  Scanning wgzimmer.ch...");
  try {
    const wg = await fetchWgzimmer();
    if (wg.length > 0) {
      console.log(` ${wg.length} listings found`);
      allListings.push(...wg);
    } else {
      console.log(" 0 listings (scraper may have failed)");
    }
  } catch (e) {
    console.log(` blocked (${e.message.substring(0, 50)})`);
  }

  // Update seen.json
  const seen = loadSeen();
  for (const l of allListings) {
    if (!seen[l.id])
      seen[l.id] = { firstSeen: new Date().toISOString(), price: l.price };
  }
  saveSeen(seen);

  return allListings;
}

// ── Main commands ───────────────────────────────────────────────────────────

async function scan(opts = {}) {
  console.log(`\n  Zurich Housing Monitor — ${timestamp()}`);
  console.log(
    `  Target: <${formatPrice(MAX_PRICE)}/mo, within ${opts.maxDist || MAX_DISTANCE_KM} km of ETH Zentrum\n`,
  );

  const seen = loadSeen();
  const allListings = await refresh();

  // Diff against previously seen listings
  const newListings = allListings.filter((l) => !seen[l.id]);
  const oldCount = Object.keys(seen).length;

  if (oldCount > 0 && newListings.length > 0) {
    console.log(`  *** ${newListings.length} NEW since last scan ***\n`);
    printListings(newListings, opts);
    console.log("\n  --- All listings ---\n");
  } else if (oldCount > 0 && newListings.length === 0) {
    console.log("  No new listings since last scan.\n");
  }

  printListings(allListings, opts);
  return allListings;
}

async function watch(intervalMin = 15, opts = {}) {
  console.log(`\n  Watching for new listings every ${intervalMin} minutes...`);
  console.log("  Press Ctrl+C to stop.\n");

  const seen = loadSeen();
  let firstRun = true;

  const tick = async () => {
    const listings = await scan({ ...opts, quiet: !firstRun });

    const newListings = listings.filter((l) => !seen[l.id]);
    if (newListings.length > 0 && !firstRun) {
      console.log(`\n  *** ${newListings.length} NEW LISTING(S) ***\n`);
      printListings(newListings, opts);

      // Desktop notification (macOS)
      try {
        const msg = newListings
          .slice(0, 3)
          .map(
            (l) =>
              `${l.price ? formatPrice(l.price) : "?"} - ${l.distKm ? l.distKm.toFixed(1) + "km" : "?"}`,
          )
          .join(", ");
        execSync(
          `osascript -e 'display notification "${msg}" with title "New Housing Listings!" sound name "Glass"'`,
        );
      } catch {}
    }

    // Mark all as seen
    for (const l of listings)
      seen[l.id] = { firstSeen: new Date().toISOString(), price: l.price };
    saveSeen(seen);

    firstRun = false;
  };

  await tick();
  setInterval(tick, intervalMin * 60 * 1000);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "scan";

  const opts = {
    showAll: args.includes("--all"),
    maxDist: (() => {
      const i = args.indexOf("--radius");
      return i > -1 ? parseFloat(args[i + 1]) : MAX_DISTANCE_KM;
    })(),
  };

  switch (cmd) {
    case "scan":
      await scan(opts);
      break;
    case "watch": {
      const mins = parseInt(args[1]) || 15;
      await watch(mins, opts);
      break;
    }
    case "links":
      console.log("\n  Useful housing links for Zurich:\n");
      console.log(
        "  flatfox.ch    https://flatfox.ch/en/search/?object_category=SHARED&max_price=1500&query=Zurich",
      );
      console.log(
        "  wgzimmer.ch   https://www.wgzimmer.ch/en/wgzimmer/search/mate/ch/zurich-stadt.html",
      );
      console.log("  WOKO          https://www.woko.ch/en/zimmer-in-zuerich");
      console.log(
        "  ronorp.net    https://www.ronorp.net/zuerich/immobilien/wohnen.1450/wg.1220",
      );
      console.log(
        "  HousingAnywhere https://housinganywhere.com/s/Zurich--Switzerland/student-accommodation",
      );
      console.log(
        "  Facebook      https://www.facebook.com/groups/487386994766428/",
      );
      console.log(
        "  ETH Housing   https://ethz.ch/en/the-eth-zurich/working-teaching-and-research/welcome-center/accommodation.html",
      );
      console.log();
      break;
    default:
      console.log("Usage: node monitor.js [scan|watch|links] [options]");
      console.log("  scan              One-time scan of all sources");
      console.log("  watch [minutes]   Poll every N minutes (default 15)");
      console.log("  links             Show useful housing search links");
      console.log("\nOptions:");
      console.log("  --all             Show all listings (no distance filter)");
      console.log(
        "  --radius N        Max distance from ETH in km (default 5)",
      );
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
