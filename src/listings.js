/**
 * Combines the source caches into one listing list for the app.
 */
import {
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  RONORP_CACHE_FILE,
  STUDENTS_CACHE_FILE,
  ZURICH_CENTER,
  FLATFOX_SLUG,
  SEEN_FILE,
  STUDENT_HOUSING_PATTERN,
  MIN_DURATION_DAYS,
  SPAM_PATTERNS,
  distKm,
  hasEndDate,
  isGenderRestricted,
  isPostcodeOnly,
  isShortSublet,
  loadCachedListing,
  readJson,
} from "./lib.js";

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
  for (const l of readJson(WGZIMMER_LISTINGS_FILE, [])) {
    if (!l.price) continue;
    const uuid = l.url.match(/([a-f0-9-]{36})/)?.[1];
    const id = `wgzimmer-${uuid || l.url.slice(-20)}`;
    const cached = loadCachedListing(l.url);
    const hasCoords = cached?.lat && cached?.lng;
    const dist = hasCoords
      ? distKm(ZURICH_CENTER, { lat: cached.lat, lng: cached.lng })
      : null;
    const text = [l.description, JSON.stringify(cached || "")]
      .filter(Boolean)
      .join(" ");
    listings.push({
      id,
      source: "wgzimmer",
      price: l.price,
      dist: dist ? Math.round(dist * 100) / 100 : null,
      lat: cached?.lat || null,
      lng: cached?.lng || null,
      address: cached?.address || l.place || null,
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
  for (const p of readJson(FLATFOX_CACHE_FILE, [])) {
    const km = distKm(ZURICH_CENTER, { lat: p.latitude, lng: p.longitude });
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
  for (const l of readJson(RONORP_CACHE_FILE, [])) {
    if (!l.price || !l.isOffer) continue;
    const id = `ronorp-${l.url.split("/").pop()}`;
    const hasCoords = l.lat && l.lng;
    listings.push({
      id,
      source: "ronorp",
      price: l.price,
      dist: hasCoords ? Math.round(distKm(ZURICH_CENTER, l) * 100) / 100 : null,
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
  for (const l of readJson(STUDENTS_CACHE_FILE, [])) {
    if (!l.price) continue;
    const id = `students-${l.url.match(/details\/(\d+)/)?.[1]}`;
    const hasCoords = l.lat && l.lng;
    listings.push({
      id,
      source: "students",
      price: l.price,
      dist: hasCoords ? Math.round(distKm(ZURICH_CENTER, l) * 100) / 100 : null,
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
