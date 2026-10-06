/**
 * ronorp.net source for Zurich WG listings.
 * Reads the public JSON API behind ronorp.net/zurich/market/housing.
 * Exports scrapeRonorp() and works standalone.
 */

import { geocodeAddress } from "./lib.js";

const API_URL = "https://cockpit.ronorp.net/api/market/category/housing";
const GEOCODE_DELAY_MS = 1100;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUSING_CATEGORY_ID = "140";
const WG_SUB_CATEGORY_ID = "144";
const ZURICH_CITY_ID = "2";
const PAGE_SIZE = 50;
const MAX_PAGES = 10;

const HTML_ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function htmlToText(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (entity) => HTML_ENTITIES[entity] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(isoDate) {
  if (!isoDate) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day}.${month}.${year}`;
}

const SHORT_TERM_PRICE_LIMIT = 400;

// Some posters enter a nightly or weekly price in the monthly price field.
function pricePeriod(price, text) {
  if (!price || price >= SHORT_TERM_PRICE_LIMIT) return null;
  if (/(pro|per|\/)\s*(Nacht|night|Tag|day)\b/i.test(text)) return "night";
  if (/(pro|per|\/)\s*(Woche|week)\b/i.test(text)) return "week";
  return null;
}

function toListing(post) {
  const location = post.location || {};
  const price = post.price ? Math.round(parseFloat(post.price)) : null;
  const description = `${post.title} ${htmlToText(post.description)}`;
  const locationAddress = location.address?.replace(
    /,\s*(Schweiz|Suiza|Switzerland|Suisse)$/i,
    "",
  );
  // A location that names only the city is geocoded to the city centre,
  // which says nothing about where the room is. The postcode is used then.
  const hasStreet = Boolean(locationAddress) && locationAddress !== location.locality;
  const postcode = post.zip_code ? String(post.zip_code) : null;
  const postcodeAddress =
    postcode && location.locality ? `${postcode} ${location.locality}` : postcode;
  return {
    url: `https://ronorp.net/market/posts/${post.seo_slug || post.slug}`,
    price,
    pricePeriod: pricePeriod(price, description),
    address: hasStreet ? locationAddress : postcodeAddress || locationAddress || null,
    lat: hasStreet ? (location.latitude ?? null) : null,
    lng: hasStreet ? (location.longitude ?? null) : null,
    postcode: hasStreet ? null : postcode,
    isOffer: post.post_type === "offer",
    description: description.substring(0, 400),
    availableFrom: formatDate(post.housing_detail?.ready_to_move),
    isTemporary: post.housing_detail?.contract === "temporary",
    source: "ronorp",
  };
}

/** Place listings that give only a postcode at the centre of that postcode area. */
async function locateByPostcode(listings) {
  const centres = new Map();
  for (const listing of listings) {
    if (!listing.postcode) continue;
    if (!centres.has(listing.postcode)) {
      centres.set(listing.postcode, await geocodeAddress(listing.postcode));
      await delay(GEOCODE_DELAY_MS);
    }
    const centre = centres.get(listing.postcode);
    listing.lat = centre?.lat ?? null;
    listing.lng = centre?.lng ?? null;
  }
}

async function fetchPage(page) {
  const url = new URL(API_URL);
  url.searchParams.set("category_id", HOUSING_CATEGORY_ID);
  url.searchParams.set(
    "sub_category_id",
    JSON.stringify([WG_SUB_CATEGORY_ID]),
  );
  url.searchParams.set("publication_city", JSON.stringify([ZURICH_CITY_ID]));
  url.searchParams.set("city_id", ZURICH_CITY_ID);
  url.searchParams.set("pageSize", PAGE_SIZE);
  url.searchParams.set("page", page);
  url.searchParams.set("sorting_seed", "1");
  url.searchParams.set("is_mobile", "0");

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`ronorp API ${resp.status}`);
  return resp.json();
}

export async function scrapeRonorp() {
  const postsById = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { posts, total_count: totalCount } = await fetchPage(page);
    // The response mixes ad slots, which have no id, into the posts.
    const realPosts = posts.filter((p) => p.id);
    for (const post of realPosts) postsById.set(post.id, post);
    if (realPosts.length === 0 || postsById.size >= totalCount) break;
  }

  // Only return offers (not people searching for rooms)
  const offers = [...postsById.values()].map(toListing).filter((l) => l.isOffer);
  await locateByPostcode(offers);
  return offers;
}

// Standalone mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const listings = await scrapeRonorp();
  console.log(JSON.stringify(listings, null, 2));
}
