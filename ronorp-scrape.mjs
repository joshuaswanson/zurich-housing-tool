/**
 * ronorp.net source for Zurich WG listings.
 * Reads the public JSON API behind ronorp.net/zurich/market/housing.
 * Exports scrapeRonorp() and works standalone.
 */

const API_URL = "https://cockpit.ronorp.net/api/market/category/housing";
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

function toListing(post) {
  const location = post.location || {};
  const address =
    location.address?.replace(/,\s*(Schweiz|Suiza|Switzerland|Suisse)$/i, "") ||
    (post.zip_code ? String(post.zip_code) : null);
  return {
    url: `https://ronorp.net/market/posts/${post.seo_slug || post.slug}`,
    price: post.price ? Math.round(parseFloat(post.price)) : null,
    address,
    lat: location.latitude ?? null,
    lng: location.longitude ?? null,
    isOffer: post.post_type === "offer",
    description: `${post.title} ${htmlToText(post.description)}`.substring(
      0,
      400,
    ),
    availableFrom: formatDate(post.housing_detail?.ready_to_move),
    isTemporary: post.housing_detail?.contract === "temporary",
    source: "ronorp",
  };
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
  return [...postsById.values()].map(toListing).filter((l) => l.isOffer);
}

// Standalone mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const listings = await scrapeRonorp();
  console.log(JSON.stringify(listings, null, 2));
}
