/**
 * Shared utilities for Zurich Housing Monitor.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────
export const ETH_ZENTRUM = { lat: 47.3764, lng: 8.5483 };
export const MAX_PRICE = 1500;
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

export const FLATFOX_BOUNDS = {
  north: 47.42,
  south: 47.33,
  east: 8.6,
  west: 8.46,
};

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
    const query = encodeURIComponent(address + ", Zürich, Schweiz");
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      { headers: { "User-Agent": "zurich-housing-monitor/1.0" } },
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
