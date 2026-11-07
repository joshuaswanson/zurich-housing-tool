/**
 * Fetches full details for wgzimmer and flatfox listings into a permanent
 * cache, with one cache file per listing.
 */
import { launch } from "cloakbrowser";
import { fetchWgzimmerListing } from "./sources/wgzimmer-detail.mjs";
import fs from "fs";
import {
  TRACKER_FILE,
  ensureDataDir,
  geocodeAddress,
  cacheKeyFromUrl,
  loadCachedListing,
  saveCachedListing,
} from "./lib.js";

ensureDataDir();

const WGZIMMER_REQUEST_DELAY_MS = 1000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ── Auto-exclude patterns ──────────────────────────────────────────────────

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

function autoExcludeIfSpam(url, data) {
  const text = JSON.stringify(data);
  for (const { pattern, reason } of SPAM_PATTERNS) {
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
      saveCachedListing(url, data);
    }
  } catch {}
}

// ── Batch fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch details for multiple URLs, using cache where available.
 * Returns array of { url, data, fromCache } objects.
 */
export async function fetchListings(urls) {
  const results = [];
  const toFetch = [];

  for (const url of urls) {
    const cached = loadCachedListing(url);
    if (!cacheKeyFromUrl(url)) {
      process.stderr.write(`Not a wgzimmer or flatfox listing: ${url}\n`);
    } else if (cached) {
      results.push({ url, data: cached, fromCache: true });
    } else {
      toFetch.push(url);
    }
  }

  if (toFetch.length > 0) {
    process.stderr.write(`Fetching ${toFetch.length} listing(s)...\n`);
    // Only flatfox pages need a browser, so it is launched on first use.
    let browser = null;
    try {
      for (const url of toFetch) {
        process.stderr.write(`  ${cacheKeyFromUrl(url)}...`);
        try {
          let data;
          if (url.includes("flatfox.ch")) {
            browser = browser || (await launch({ headless: true, humanize: true }));
            const page = await browser.newPage();
            try {
              data = await fetchFlatfoxListing(page, url);
            } finally {
              await page.close();
            }
          } else {
            data = await fetchWgzimmerListing(url);
            await delay(WGZIMMER_REQUEST_DELAY_MS);
          }
          saveCachedListing(url, data);
          await autoGeocode(url, data);
          const excludeReason = autoExcludeIfSpam(url, data);
          if (excludeReason) {
            process.stderr.write(` [${excludeReason}]`);
          }
          results.push({ url, data, fromCache: false });
          process.stderr.write(" ok\n");
        } catch (e) {
          process.stderr.write(` error: ${e.message.substring(0, 50)}\n`);
        }
      }
    } finally {
      await browser?.close();
    }
  }

  // Restore original URL order
  results.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
  return results;
}
