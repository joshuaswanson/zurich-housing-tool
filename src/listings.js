/**
 * Combines the source caches into the listing list shared by the dashboard
 * and the search CLI.
 */
import {
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  RONORP_CACHE_FILE,
  STUDENTS_CACHE_FILE,
  ETH_ZENTRUM,
  FLATFOX_SLUG,
  SEEN_FILE,
  STUDENT_HOUSING_PATTERN,
  config,
  distKm,
  hasEndDate,
  isGenderRestricted,
  isPostcodeOnly,
  isShortSublet,
  buildSpamPatterns,
  loadCachedListing,
  readJson,
  sourceEnabled,
} from "./lib.js";

/** Cached listings of a source, or none when it is disabled in config. */
function sourceCache(name, file) {
  return sourceEnabled(name) ? readJson(file, []) : [];
}

const SPAM_PATTERNS = buildSpamPatterns(config.exclude?.spam || []);
const MIN_DURATION_DAYS = config.search?.minDuration || 60;

function listingFlags(text, dates) {
  return {
    genderRestricted: isGenderRestricted(text),
    studentHousing: STUDENT_HOUSING_PATTERN.test(text),
    bulkPoster: SPAM_PATTERNS.some((p) => p.test(text)),
    shortSublet: isShortSublet(dates, MIN_DURATION_DAYS),
  };
}

/**
 * Every listing from the four source caches in one shape, with the flags the
 * filters use. Wgzimmer and flatfox entries are merged with fetched details.
 */
export function loadAllListings() {
  const listings = [];
  const seen = readJson(SEEN_FILE, {});

  // wgzimmer
  for (const l of sourceCache("wgzimmer", WGZIMMER_LISTINGS_FILE)) {
    if (!l.price) continue;
    const uuid = l.url.match(/([a-f0-9-]{36})/)?.[1];
    const id = `wgzimmer-${uuid || l.url.slice(-20)}`;
    const cached = loadCachedListing(l.url);
    const hasCoords = cached?.lat && cached?.lng;
    const dist = hasCoords
      ? distKm(ETH_ZENTRUM, { lat: cached.lat, lng: cached.lng })
      : null;
    const text = [l.description, l.neighborhood, JSON.stringify(cached || "")]
      .filter(Boolean)
      .join(" ");
    listings.push({
      id,
      source: "wgzimmer",
      price: l.price,
      dist: dist ? Math.round(dist * 100) / 100 : null,
      lat: cached?.lat || null,
      lng: cached?.lng || null,
      address: cached?.address || l.neighborhood || null,
      description: l.description || "",
      availableFrom: l.availableFrom || null,
      until: l.until || null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: hasEndDate(l.until),
      ...listingFlags(text, l),
    });
  }

  // flatfox
  for (const p of sourceCache("flatfox", FLATFOX_CACHE_FILE)) {
    const km = distKm(ETH_ZENTRUM, { lat: p.latitude, lng: p.longitude });
    const id = `flatfox-${p.pk}`;
    const url = `https://flatfox.ch/en/flat/${FLATFOX_SLUG}/${p.pk}/`;
    const cached = loadCachedListing(url);
    const text = [p.description, JSON.stringify(cached || "")]
      .filter(Boolean)
      .join(" ");
    listings.push({
      id,
      source: "flatfox",
      price: p.price_display,
      dist: Math.round(km * 100) / 100,
      lat: p.latitude,
      lng: p.longitude,
      address: cached?.address || p.address || null,
      description: cached?.description || p.description || "",
      availableFrom: cached?.availableFrom || p.availableFrom || null,
      until: null,
      url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: false,
      ...listingFlags(text, {}),
    });
  }

  // ronorp
  for (const l of sourceCache("ronorp", RONORP_CACHE_FILE)) {
    if (!l.price || !l.isOffer) continue;
    const id = `ronorp-${l.url.split("/").pop()}`;
    const hasCoords = l.lat && l.lng;
    listings.push({
      id,
      source: "ronorp",
      price: l.price,
      dist: hasCoords ? Math.round(distKm(ETH_ZENTRUM, l) * 100) / 100 : null,
      lat: l.lat || null,
      lng: l.lng || null,
      address: l.address || null,
      description: l.description || "",
      availableFrom: l.availableFrom || null,
      until: null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: Boolean(l.isTemporary),
      pricePeriod: l.pricePeriod || null,
      contactEmail: l.contactEmail || null,
      ...listingFlags(l.description || "", {}),
      ...(l.pricePeriod ? { shortSublet: true } : {}),
    });
  }

  // students.ch
  for (const l of sourceCache("students", STUDENTS_CACHE_FILE)) {
    if (!l.price) continue;
    const id = `students-${l.url.match(/details\/(\d+)/)?.[1]}`;
    const hasCoords = l.lat && l.lng;
    listings.push({
      id,
      source: "students",
      price: l.price,
      dist: hasCoords ? Math.round(distKm(ETH_ZENTRUM, l) * 100) / 100 : null,
      lat: l.lat || null,
      lng: l.lng || null,
      address: l.address || null,
      description: l.description || "",
      availableFrom: l.availableFrom || null,
      until: l.until || null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: Boolean(l.until),
      wholeFlat: Boolean(l.isWholeFlat),
      ...listingFlags(l.description || "", l),
    });
  }

  for (const l of listings) {
    l.approximate = Boolean(l.lat && l.lng) && isPostcodeOnly(l.address);
  }

  return listings;
}
