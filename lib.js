/**
 * Shared utilities for Zurich Housing Monitor.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config loading ────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, "config.json");
const CONFIG_EXAMPLE_FILE = path.join(__dirname, "config.example.json");

/**
 * Load config.json, falling back to config.example.json if it doesn't exist.
 * Returns the parsed config object.
 */
export function loadConfig() {
  const file = fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : CONFIG_EXAMPLE_FILE;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const config = loadConfig();

// ── Constants (derived from config) ───────────────────────────────────────
export { config };

export const ETH_ZENTRUM = { lat: config.target.lat, lng: config.target.lng };
export const MAX_PRICE = config.search.maxPrice || 2000;
export const MAX_DISTANCE_KM = 5;

export const DATA_DIR = path.join(__dirname, "data");
export const SEEN_FILE = path.join(DATA_DIR, "seen.json");
export const LISTINGS_DIR = path.join(DATA_DIR, "listings");
export const WGZIMMER_CACHE_FILE = path.join(DATA_DIR, "wgzimmer_cache.json");
export const WGZIMMER_LISTINGS_FILE = path.join(
  DATA_DIR,
  "wgzimmer_listings.json",
);
export const FLATFOX_CACHE_FILE = path.join(DATA_DIR, "flatfox_cache.json");
export const RONORP_CACHE_FILE = path.join(DATA_DIR, "ronorp_cache.json");
export const TRACKER_FILE = path.join(__dirname, "tracker.json");
export const SCAN_STATUS_FILE = path.join(DATA_DIR, "scan_status.json");

/**
 * Flatfox bounding box: from config or derived from target coordinates.
 * Covers roughly a 5 km radius around the target.
 */
export const FLATFOX_BOUNDS = config.flatfoxBounds || {
  north: config.target.lat + 0.044,
  south: config.target.lat - 0.046,
  east: config.target.lng + 0.052,
  west: config.target.lng - 0.088,
};

/** Flatfox URL slug for direct listing links (e.g. "8001-zurich") */
export const FLATFOX_SLUG = config.search?.flatfoxSlug || "8001-zurich";

/** Ronorp listing page URL */
export const RONORP_URL =
  config.search?.ronorpUrl ||
  "https://ronorp.net/zurich/market/housing/140?sub_category_id=%5B%22144%22%5D";

/** Suffix appended to addresses for geocoding (e.g. "Zürich, Schweiz") */
export const GEOCODE_SUFFIX = config.search?.geocodeSuffix || "";

// ── Helpers ────────────────────────────────────────────────────────────────

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LISTINGS_DIR))
    fs.mkdirSync(LISTINGS_DIR, { recursive: true });
}

export function loadSeen() {
  ensureDataDir();
  if (fs.existsSync(SEEN_FILE))
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  return {};
}

export function saveSeen(seen) {
  ensureDataDir();
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

/** Haversine distance in km */
export function distKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Walking time estimate (5 km/h average) */
export function walkMin(km) {
  return Math.round(km * 12);
}

export function formatPrice(chf) {
  return `CHF ${chf.toLocaleString("de-CH")}`;
}

export function timestamp() {
  return new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
}

// ── Geocoding ─────────────────────────────────────────────────────────────

const GEOCODE_CACHE_FILE = path.join(DATA_DIR, "geocode_cache.json");

function loadGeocodeCache() {
  if (fs.existsSync(GEOCODE_CACHE_FILE))
    return JSON.parse(fs.readFileSync(GEOCODE_CACHE_FILE, "utf8"));
  return {};
}

function saveGeocodeCache(cache) {
  ensureDataDir();
  fs.writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Geocode an address to { lat, lng } using Nominatim (OpenStreetMap).
 * Results are permanently cached to avoid rate limiting.
 * Returns null if geocoding fails.
 */
export async function geocodeAddress(address) {
  if (!address) return null;

  const cache = loadGeocodeCache();
  const key = address.trim().toLowerCase();
  if (cache[key]) return cache[key];

  try {
    const suffix = GEOCODE_SUFFIX ? ", " + GEOCODE_SUFFIX : "";
    const query = encodeURIComponent(address + suffix);
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      { headers: { "User-Agent": "swiss-housing-monitor/2.0" } },
    );
    const results = await resp.json();
    if (results.length > 0) {
      const coords = {
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon),
      };
      cache[key] = coords;
      saveGeocodeCache(cache);
      return coords;
    }
  } catch {}

  cache[key] = null;
  saveGeocodeCache(cache);
  return null;
}

// ── Flatfox details ───────────────────────────────────────────────────────

const FLATFOX_DETAILS_BATCH_SIZE = 50;

function flatfoxAvailableFrom(listing) {
  if (listing.moving_date) {
    const [year, month, day] = listing.moving_date.split("-").map(Number);
    return `${day}.${month}.${year}`;
  }
  if (listing.moving_date_type === "imm") return "Immediately";
  if (listing.moving_date_type === "agr") return "By agreement";
  return null;
}

/**
 * Fetch address, description and availability for flatfox listings from the
 * public listing API, which accepts many pks per request.
 * Returns a Map of pk -> details.
 */
export async function fetchFlatfoxDetails(pks) {
  const details = new Map();
  for (let i = 0; i < pks.length; i += FLATFOX_DETAILS_BATCH_SIZE) {
    const url = new URL("https://flatfox.ch/api/v1/public-listing/");
    for (const pk of pks.slice(i, i + FLATFOX_DETAILS_BATCH_SIZE)) {
      url.searchParams.append("pk", pk);
    }
    url.searchParams.set("limit", FLATFOX_DETAILS_BATCH_SIZE);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Flatfox API ${resp.status}`);
    const { results } = await resp.json();
    for (const l of results) {
      const locality = [l.zipcode, l.city].filter(Boolean).join(" ");
      details.set(l.pk, {
        address:
          [l.street, locality].filter(Boolean).join(", ") ||
          l.public_address ||
          null,
        description: [l.description_title, l.description]
          .filter(Boolean)
          .join("\n\n")
          .substring(0, 400),
        availableFrom: flatfoxAvailableFrom(l),
      });
    }
  }
  return details;
}

/** Extract a cache key from a listing URL */
export function cacheKeyFromUrl(url) {
  if (url.includes("flatfox.ch")) {
    const pk = url.match(/\/(\d{5,})\/?/)?.[1];
    if (pk) return `flatfox-${pk}`;
  }
  const uuid = url.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
  )?.[1];
  return uuid || null;
}

/** Load cached listing detail JSON for a URL */
export function loadCachedListing(url) {
  const key = cacheKeyFromUrl(url);
  if (!key) return null;
  const p = path.join(LISTINGS_DIR, key + ".json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return null;
}

// ── Listing filters ───────────────────────────────────────────────────────

export const STUDENT_HOUSING_PATTERN = /WOKO|under 28|unter 28|JUWO/i;

export function isGenderRestricted(text) {
  if (!text) return false;

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

export function isShortSublet(listing, minDurationDays) {
  const from = listing.availableFrom || listing.date;
  const until = listing.until;

  if (!from || !until) return false;

  const untilLower = until.toLowerCase();
  if (
    untilLower.includes("no time") ||
    untilLower.includes("unbefristet") ||
    untilLower === "?"
  )
    return false;

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

  return diffDays > 0 && diffDays < minDurationDays;
}

const BUILTIN_SPAM_PATTERNS = [
  /A\/NTERIM/i,
  /NextGen Properties/i,
  /next\.genproperties/i,
  /nextgenproperties/i,
  /different Address than this ad/i,
  /Properties are at a different/i,
  /Co-Living Anbieter/i,
];

/** Built-in bulk poster patterns plus the literal terms from the config. */
export function buildSpamPatterns(configSpamList) {
  const patterns = [...BUILTIN_SPAM_PATTERNS];
  for (const term of configSpamList) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!patterns.some((p) => p.test(term))) {
      patterns.push(new RegExp(escaped, "i"));
    }
  }
  return patterns;
}
