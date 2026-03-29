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
