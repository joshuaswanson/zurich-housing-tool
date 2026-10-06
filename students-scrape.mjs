/**
 * students.ch source for Zurich rooms and flats.
 * Reads the public list page for the Zurich area and each listing's detail
 * page. Exports scrapeStudents() and works standalone.
 */
import { geocodeAddress } from "./lib.js";

const BASE_URL = "https://www.students.ch";
const ZURICH_LIST_URL = `${BASE_URL}/wohnen/list/140`;
const REQUEST_DELAY_MS = 1000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const HTML_ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeEntities(text) {
  return (text || "")
    .replace(/&[a-z#0-9]+;/gi, (entity) => HTML_ENTITIES[entity] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "zurich-housing-tool/2.0" },
  });
  if (!resp.ok) throw new Error(`students.ch ${resp.status}`);
  return resp.text();
}

function parseListRows(html) {
  const rows = html.match(/<tr class="list_row_\d+">[\s\S]*?<\/tr>/g) || [];
  return rows
    .map((row) => {
      const link = row.match(/href="(\/wohnen\/details\/(\d+)\/[^"]*)"/);
      if (!link) return null;
      return {
        id: link[2],
        url: BASE_URL + link[1],
        title: decodeEntities(
          row.match(/<span[^>]*title="([^"]*)"/)?.[1] ||
            row.match(/href="\/wohnen\/details\/[^>]*>\s*([^<]+)</)?.[1],
        ),
        price: parseInt(row.match(/(\d+)\s*CHF/)?.[1]) || null,
        availableFrom:
          row.match(/Frei ab: (\d{2}\.\d{2}\.\d{4})/)?.[1] || null,
      };
    })
    .filter(Boolean);
}

function parseDetails(html) {
  const until = html.match(/Frei bis: <strong>([^<]*)<\/strong>/)?.[1];
  return {
    address: decodeEntities(
      html.match(/<small>([^<]{3,80}, \d{4} [^<]{2,40})<\/small>/)?.[1],
    ),
    description: decodeEntities(
      html.match(/property="og:description" content="([^"]*)"/)?.[1],
    ),
    until: until && !/unbeschr/i.test(until) ? until.trim() : null,
  };
}

export async function scrapeStudents() {
  const rows = parseListRows(await fetchHtml(ZURICH_LIST_URL));
  const listings = [];
  for (const row of rows) {
    await delay(REQUEST_DELAY_MS);
    const details = parseDetails(await fetchHtml(row.url));
    const coords = details.address
      ? await geocodeAddress(details.address)
      : null;
    listings.push({
      url: row.url,
      price: row.price,
      address: details.address || null,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      description: `${row.title} ${details.description}`.substring(0, 400),
      availableFrom: row.availableFrom,
      until: details.until,
      source: "students",
    });
  }
  return listings;
}

// Standalone mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const listings = await scrapeStudents();
  console.log(JSON.stringify(listings, null, 2));
}
