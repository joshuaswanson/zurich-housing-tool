#!/usr/bin/env node
/**
 * Fetch full details for a wgzimmer or flatfox listing.
 * Uses a permanent cache -- each listing URL maps to exactly one result.
 *
 * Usage:
 *   node fetch-listing.mjs <url>               # Fetch one listing
 *   node fetch-listing.mjs <url1> <url2>       # Fetch multiple
 *   node fetch-listing.mjs --from-file <f>     # Fetch all URLs from a file
 *   node fetch-listing.mjs --summary <url>     # Compact summary from cache
 *   node fetch-listing.mjs --all               # Summarize all cached listings
 */
import { launch } from "cloakbrowser";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  config,
  LISTINGS_DIR,
  TRACKER_FILE,
  ensureDataDir,
  geocodeAddress,
} from "./lib.js";

ensureDataDir();

// ── Config-driven exclude settings ─────────────────────────────────────────

const cfgExclude = config.exclude || {};
const overAgeLimit = cfgExclude.overAge || 28;

// ── Cache helpers (exported for programmatic use) ───────────────────────────

export function isFlatfox(url) {
  return url.includes("flatfox.ch");
}

export function cacheKey(url) {
  if (isFlatfox(url)) {
    const pk = url.match(/\/(\d{5,})\/?/)?.[1];
    return pk
      ? `flatfox-${pk}`
      : crypto.createHash("md5").update(url).digest("hex");
  }
  const uuid = url.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
  )?.[1];
  return uuid || crypto.createHash("md5").update(url).digest("hex");
}

export function cachePath(url) {
  return path.join(LISTINGS_DIR, cacheKey(url) + ".json");
}

export function loadCache(url) {
  const p = cachePath(url);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return null;
}

export function saveCache(url, data) {
  fs.writeFileSync(cachePath(url), JSON.stringify(data, null, 2));
}

// ── Flatfox fetch ───────────────────────────────────────────────────────────

export async function fetchFlatfoxListing(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const btns = await page.$$("button");
    for (const b of btns) {
      const t = await b.textContent();
      if (t.includes("Accept")) {
        await b.click();
        break;
      }
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));

  return page.evaluate(() => {
    const text = document.body.innerText;
    const data = {};

    const titleMatch = text.match(
      /(?:Rent a room.*?\n)?(.*?)\s*-\s*CHF\s*([\d']+)/,
    );
    if (titleMatch) {
      data.address = titleMatch[1].trim();
    }
    const rentMatch = text.match(
      /(?:Gross|Net) rent[^:]*:[^\d]*CHF\s*([\d\u2019']+)/,
    );
    if (rentMatch) {
      data.rent = parseInt(rentMatch[1].replace(/['\u2019]/g, ""));
    } else if (titleMatch) {
      data.rent = parseInt(titleMatch[2].replace(/['\u2019]/g, ""));
    }

    const floorMatch = text.match(/Floor:\s*(.+)/);
    if (floorMatch) data.floor = floorMatch[1].trim();

    const sizeMatch = text.match(/Livingspace:\s*(\d+)/);
    if (sizeMatch) data.livingspace = sizeMatch[1] + " m\u00B2";

    const facilitiesMatch = text.match(/Facilities:\s*(.+)/);
    if (facilitiesMatch) data.facilities = facilitiesMatch[1].trim();

    const availMatch = text.match(/Available:\s*(.+)/);
    if (availMatch) data.availableFrom = availMatch[1].trim();

    const partMatch = text.match(/Particulars:\s*(.+)/);
    if (partMatch) data.particulars = partMatch[1].trim();

    const descStart = text.indexOf("Description");
    const descEnd = text.indexOf("Contact advertiser");
    if (descStart > -1 && descEnd > -1) {
      data.description = text.substring(descStart + 11, descEnd).trim();
    }

    const cityMatch = data.address?.match(/\d{4}\s+(.+)/);
    if (cityMatch) data.city = cityMatch[1].trim();

    data.source = "flatfox";
    data.url = location.href;
    return data;
  });
}

// ── wgzimmer fetch ──────────────────────────────────────────────────────────

export async function fetchWgzimmerListing(page, url) {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const c = await page.$(".fc-cta-consent");
    if (c) await c.click();
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));

  return page.evaluate(() => {
    const text = document.body.innerText;

    const data = {};

    // Address block
    const addrMatch = text.match(/Address\s*\n(.*?)\nCity\s*\n(.*?)\n/s);
    if (addrMatch) {
      const allAddr = [...text.matchAll(/Address\s*\n(.+)/g)];
      data.address =
        allAddr.length > 1 ? allAddr[1][1].trim() : allAddr[0]?.[1]?.trim();
    }
    const cityMatch = text.match(/City\s*\n(.+)/);
    if (cityMatch) data.city = cityMatch[1].trim();

    const hoodMatch = text.match(/Neighbourhood\s*\n(.+)/);
    if (hoodMatch) data.neighbourhood = hoodMatch[1].trim();

    const nearMatch = text.match(/Nearby\s*\n([\s\S]*?)(?:\+|©|GOOGLE)/);
    if (nearMatch) data.nearby = nearMatch[1].trim();

    // Dates & price
    const rentMatch =
      text.match(/Rent per month\s*\n\s*(\d[\d.']*)/i) ||
      text.match(/Miete pro Monat\s*\n\s*(\d[\d.']*)/i);
    if (rentMatch) data.rent = parseInt(rentMatch[1].replace(/[.']/g, ""));

    const dates = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/g);
    if (dates && dates.length >= 1) data.availableFrom = dates[0];

    const untilMatch = text.match(/Until\s*\n(.+)/);
    if (untilMatch) data.until = untilMatch[1].trim();

    // Content sections
    const roomMatch = text.match(
      /The room is\s*\n([\s\S]*?)(?=We are looking for|Contact)/,
    );
    if (roomMatch) data.room = roomMatch[1].trim();

    const lookingMatch = text.match(
      /We are looking for\s*\n([\s\S]*?)(?=We are\n|Contact)/,
    );
    if (lookingMatch) data.lookingFor = lookingMatch[1].trim();

    const weAreMatch = text.match(/We are\s*\n([\s\S]*?)(?=Contact)/);
    if (weAreMatch) data.weAre = weAreMatch[1].trim();

    data.url = location.href;
    return data;
  });
}

// ── Auto-exclude patterns ──────────────────────────────────────────────────

// Hardcoded spam patterns (always active for robustness)
const SPAM_PATTERNS = [
  { pattern: /A\/NTERIM/i, reason: "Auto-excluded: A/NTERIM spam" },
  {
    pattern: /NextGen Properties/i,
    reason: "Auto-excluded: NextGen Properties spam",
  },
  {
    pattern: /next\.genproperties/i,
    reason: "Auto-excluded: NextGen Properties spam",
  },
  {
    pattern: /nextgenproperties/i,
    reason: "Auto-excluded: NextGen Properties spam",
  },
  {
    pattern: /different Address than this ad/i,
    reason: "Auto-excluded: fake address spam",
  },
  {
    pattern: /Properties are at a different/i,
    reason: "Auto-excluded: fake address spam",
  },
  {
    pattern: /Co-Living Anbieter/i,
    reason: "Auto-excluded: Co-Living Anbieter spam",
  },
  {
    pattern: /NOTE:\s*This is an advertisement\.\s*The Property is located in/i,
    reason: "Auto-excluded: fake address (property elsewhere)",
  },
];

// Add patterns from config spam list (in addition to hardcoded ones)
const configSpamList = cfgExclude.spam || [];
for (const term of configSpamList) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alreadyCovered = SPAM_PATTERNS.some((s) => s.pattern.test(term));
  if (!alreadyCovered) {
    SPAM_PATTERNS.push({
      pattern: new RegExp(escaped, "i"),
      reason: `Auto-excluded: ${term} (config spam)`,
    });
  }
}

// Hardcoded WOKO patterns (always active for robustness)
const WOKO_PATTERNS = [
  { pattern: /\bWOKO\b/, reason: "Auto-excluded: WOKO property" },
  { pattern: /\bJUWO\b/, reason: "Auto-excluded: JUWO property" },
  {
    pattern: new RegExp(`\\bunder ${overAgeLimit}\\b`, "i"),
    reason: `Auto-excluded: WOKO/JUWO age restriction (under ${overAgeLimit})`,
  },
  {
    pattern: new RegExp(`\\bunter ${overAgeLimit}\\b`, "i"),
    reason: `Auto-excluded: WOKO/JUWO age restriction (unter ${overAgeLimit})`,
  },
  { pattern: /WOKO-Kriterien/i, reason: "Auto-excluded: WOKO property" },
  { pattern: /JUWO-Kriterien/i, reason: "Auto-excluded: JUWO property" },
];

// Only auto-exclude WOKO if config says so
const excludeWoko = cfgExclude.woko !== false;

function autoExcludeIfSpam(url, data) {
  const text = JSON.stringify(data);
  const patternsToCheck = excludeWoko
    ? [...SPAM_PATTERNS, ...WOKO_PATTERNS]
    : SPAM_PATTERNS;
  for (const { pattern, reason } of patternsToCheck) {
    if (pattern.test(text)) {
      try {
        const tracker = fs.existsSync(TRACKER_FILE)
          ? JSON.parse(fs.readFileSync(TRACKER_FILE, "utf8"))
          : {
              applied: [],
              shortlisted: [],
              rejected: [],
              excluded: [],
              notes: {},
            };
        const allUrls = [
          ...tracker.applied,
          ...tracker.shortlisted,
          ...tracker.rejected,
          ...tracker.excluded,
        ].map((e) => e.url);
        if (allUrls.includes(url)) return null;
        tracker.excluded.push({
          url,
          address: data.address || null,
          price: data.rent || null,
          reason,
          date: new Date().toISOString().split("T")[0],
        });
        fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
        return reason;
      } catch {}
    }
  }
  return null;
}

async function autoGeocode(url, data) {
  if (data.lat && data.lng) return;
  const address = data.address;
  if (!address) return;
  const fullAddr =
    address +
    (data.city && !address.includes(data.city) ? ", " + data.city : "");
  try {
    const coords = await geocodeAddress(fullAddr);
    if (coords) {
      data.lat = coords.lat;
      data.lng = coords.lng;
      saveCache(url, data);
    }
  } catch {}
}

// ── Batch fetch (exported for search.js --fetch N) ──────────────────────────

/**
 * Fetch details for multiple URLs, using cache where available.
 * Returns array of { url, data, fromCache } objects.
 */
export async function fetchListings(urls) {
  const results = [];
  const toFetch = [];

  for (const url of urls) {
    const cached = loadCache(url);
    if (cached) {
      results.push({ url, data: cached, fromCache: true });
    } else {
      toFetch.push(url);
    }
  }

  if (toFetch.length > 0) {
    process.stderr.write(`Fetching ${toFetch.length} listing(s)...\n`);
    const browser = await launch({ headless: true, humanize: true });
    try {
      for (const url of toFetch) {
        process.stderr.write(`  ${cacheKey(url)}...`);
        const page = await browser.newPage();
        try {
          const data = isFlatfox(url)
            ? await fetchFlatfoxListing(page, url)
            : await fetchWgzimmerListing(page, url);
          saveCache(url, data);
          // Auto-geocode (adds lat/lng to cached data)
          await autoGeocode(url, data);
          // Auto-exclude spam/WOKO
          const excludeReason = autoExcludeIfSpam(url, data);
          if (excludeReason) {
            process.stderr.write(` [${excludeReason}]`);
          }
          results.push({ url, data, fromCache: false });
          process.stderr.write(" ok\n");
        } catch (e) {
          process.stderr.write(` error: ${e.message.substring(0, 50)}\n`);
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }

  // Restore original URL order
  results.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
  return results;
}

// ── Print helpers ───────────────────────────────────────────────────────────

function printListing(data) {
  console.log(`\n${"=".repeat(60)}`);
  if (data.source === "flatfox") {
    console.log(data.address || "?");
    if (data.rent) console.log(`Rent: CHF ${data.rent}/mo`);
    if (data.availableFrom) console.log(`Available: ${data.availableFrom}`);
    if (data.particulars) console.log(`Type: ${data.particulars}`);
    if (data.livingspace) console.log(`Size: ${data.livingspace}`);
    if (data.floor) console.log(`Floor: ${data.floor}`);
    if (data.facilities) console.log(`Facilities: ${data.facilities}`);
    if (data.description) console.log(`\nDescription:\n${data.description}`);
  } else {
    console.log(
      `${data.address || "?"}, ${data.city || "?"} (${data.neighbourhood || "?"})`,
    );
    if (data.rent) console.log(`Rent: CHF ${data.rent}/mo`);
    if (data.availableFrom)
      process.stdout.write(`Available: ${data.availableFrom}`);
    if (data.until) process.stdout.write(` → ${data.until}`);
    console.log();
    console.log(`${"=".repeat(60)}`);
    if (data.nearby) console.log(`\nNearby: ${data.nearby}`);
    if (data.room) console.log(`\nRoom: ${data.room}`);
    if (data.lookingFor) console.log(`\nLooking for: ${data.lookingFor}`);
    if (data.weAre) console.log(`\nWe are: ${data.weAre}`);
  }
  console.log(`\n${data.url}`);
}

function summarize(data) {
  const lines = [];
  lines.push(`${data.address || "?"}, ${data.city || "?"}`);
  if (data.rent) lines.push(`CHF ${data.rent}/mo`);

  const avail = [];
  if (data.availableFrom) avail.push(`from ${data.availableFrom}`);
  if (data.until && data.until !== "No time restrictions")
    avail.push(`until ${data.until}`);
  else if (data.until) avail.push("permanent");
  if (avail.length) lines.push(avail.join(" "));

  // Flatfox fields
  if (data.particulars) lines.push(`Type: ${data.particulars}`);
  if (data.livingspace) lines.push(`Size: ${data.livingspace}`);
  if (data.facilities) lines.push(`Facilities: ${data.facilities}`);

  // wgzimmer fields
  if (data.nearby) lines.push(`Near: ${data.nearby.replace(/\n/g, "; ")}`);
  if (data.room)
    lines.push(`Room: ${data.room.replace(/\n/g, " ").substring(0, 200)}`);
  if (data.lookingFor)
    lines.push(
      `Want: ${data.lookingFor.replace(/\n/g, " ").substring(0, 200)}`,
    );
  if (data.weAre)
    lines.push(`WG: ${data.weAre.replace(/\n/g, " ").substring(0, 200)}`);

  // Flatfox description (covers what wgzimmer splits into room/lookingFor/weAre)
  if (data.description)
    lines.push(
      `Desc: ${data.description.replace(/\n/g, " ").substring(0, 300)}`,
    );

  lines.push(data.url || "");
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: node fetch-listing.mjs <url> [<url2> ...]");
    console.log("       node fetch-listing.mjs --from-file <file>");
    console.log("       node fetch-listing.mjs --summary <url>");
    console.log("       node fetch-listing.mjs --all");
    process.exit(0);
  }

  // --all: summarize all cached listings
  if (args[0] === "--all") {
    if (!fs.existsSync(LISTINGS_DIR)) {
      console.log("No cached listings found. Fetch some listings first.");
      process.exit(0);
    }
    const files = fs
      .readdirSync(LISTINGS_DIR)
      .filter((f) => f.endsWith(".json"));
    if (!files.length) {
      console.log("No cached listings found. Fetch some listings first.");
      process.exit(0);
    }
    for (const f of files) {
      const data = JSON.parse(
        fs.readFileSync(path.join(LISTINGS_DIR, f), "utf8"),
      );
      console.log("\n---");
      console.log(summarize(data));
    }
    return;
  }

  // --summary: compact summaries (from cache only)
  if (args[0] === "--summary") {
    const urls = args.slice(1).filter((a) => a.startsWith("http"));
    for (const url of urls) {
      const cached = loadCache(url);
      if (cached) {
        console.log("\n---");
        console.log(summarize(cached));
      } else {
        console.log(`\n--- [not cached] ${url}`);
      }
    }
    return;
  }

  // Normal fetch mode
  let urls;
  if (args[0] === "--from-file") {
    urls = fs
      .readFileSync(args[1], "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http"));
  } else {
    urls = args.filter((a) => a.startsWith("http"));
  }

  const results = await fetchListings(urls);

  for (const { data } of results) {
    printListing(data);
  }
}

// Only run CLI when invoked directly
const isMainModule =
  process.argv[1] &&
  (import.meta.url === "file://" + process.argv[1] ||
    import.meta.url === new URL(process.argv[1], "file://").href);

if (isMainModule) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}
