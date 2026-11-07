/**
 * ronorp.net source for Zurich WG listings.
 * Opens the public housing list in a background browser and reads the posts
 * the page loads from ronorp's API while it scrolls.
 */

import { launch } from "cloakbrowser";
import { geocodeAddress, htmlToText } from "../lib.js";

const LIST_URL =
  "https://ronorp.net/zurich/market/housing/living?sub_category_id=%5B%22144%22%5D&city=zurich&postType=housing&categoryId=140";
const POSTS_RESPONSE = "/api/market/category/housing?";
const SCROLL_PAUSE_MS = 1200;
const MAX_SCROLLS = 40;
const STALLED_SCROLLS = 3;
const GEOCODE_DELAY_MS = 1100;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

export function toListing(post) {
  const location = post.location || {};
  const price = post.price ? Math.round(parseFloat(post.price)) : null;
  const description = `${post.title}\n\n${htmlToText(post.description)}`;
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
    contactEmail: post.email_address || null,
    isOffer: post.post_type === "offer",
    description,
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

async function loadPosts() {
  const browser = await launch({ headless: true });
  const posts = new Map();
  let total = Infinity;
  try {
    const page = await browser.newPage();
    page.on("response", async (response) => {
      if (!response.url().includes(POSTS_RESPONSE)) return;
      try {
        const body = await response.json();
        total = body.total_count ?? total;
        // The response mixes ad slots, which have no id, into the posts.
        for (const post of body.posts || []) {
          if (post.id) posts.set(post.id, post);
        }
      } catch {}
    });
    await page.goto(LIST_URL, { waitUntil: "networkidle", timeout: 45000 });
    let stalled = 0;
    for (
      let scroll = 0;
      scroll < MAX_SCROLLS && posts.size < total && stalled < STALLED_SCROLLS;
      scroll++
    ) {
      const before = posts.size;
      await page.mouse.wheel(0, 4000);
      await delay(SCROLL_PAUSE_MS);
      stalled = posts.size === before ? stalled + 1 : 0;
    }
  } finally {
    await browser.close();
  }
  if (posts.size === 0) throw new Error("ronorp showed no listings");
  return [...posts.values()];
}

export async function scrapeRonorp() {
  const offers = (await loadPosts()).map(toListing).filter((l) => l.isOffer);
  await locateByPostcode(offers);
  return offers;
}
