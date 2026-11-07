/**
 * wgzimmer.ch search results, read as plain HTML page by page.
 */
import { htmlToText } from "../lib.js";

const SEARCH_URL = "https://www.wgzimmer.ch/en/wgzimmer/search/mate.html";
const REQUEST_DELAY_MS = 1000;
const MAX_PAGES = 60;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function formatDate(isoTime) {
  const date = new Date(isoTime);
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.${date.getUTCFullYear()}`;
}

function field(row, className) {
  const match = row.match(
    new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)</(a|p)>`),
  );
  return htmlToText(match?.[1]).replace(/\s+/g, " ");
}

export function parseResultRow(row) {
  const id = row.match(/data-ad-id="([^"]+)"/)?.[1];
  if (!id) return null;
  const title = field(row, "result-row__link");
  const rent = field(row, "result-row__rent");
  const meta = field(row, "result-row__meta");
  const badges = [
    ...(row.match(/class="result-row__badges">([\s\S]*?)<\/ul>/)?.[1] || "")
      .matchAll(/<li>([^<]+)<\/li>/g),
  ].map((m) => m[1].trim());
  const posted = row.match(/<time datetime="([^"]+)"/)?.[1];
  const from = meta.match(/Available from (\d{1,2}\.\d{1,2}\.\d{4})/)?.[1];
  const until = meta.match(/until (\d{1,2}\.\d{1,2}\.\d{4})/)?.[1];
  const price = parseInt(rent.replace(/\D/g, ""));
  const listing = {
    url: `https://www.wgzimmer.ch/wglink/en/${id}/`,
    price: price || null,
    place: title.split(",")[0].trim() || null,
    availableFrom: from || (/Available now/i.test(meta) ? "Immediately" : null),
    until: until || null,
    posted: posted ? formatDate(posted) : null,
    description: [title, rent, meta, ...badges].filter(Boolean).join(" | "),
  };
  return Object.fromEntries(
    Object.entries(listing).filter(([, value]) => value !== null),
  );
}

export function parseResultsPage(html) {
  const rows = html.split('<li class="result-row').slice(1);
  const pages = [...html.matchAll(/seite=(\d+)/g)].map((m) => +m[1]);
  return {
    listings: rows.map(parseResultRow).filter(Boolean),
    lastPage: Math.max(1, ...pages),
  };
}

async function fetchResultsPage(maxPrice, region, page) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("region", region);
  url.searchParams.set("max", maxPrice);
  if (page > 1) url.searchParams.set("seite", page);
  const resp = await fetch(url, {
    headers: { "User-Agent": "zurich-housing-tool/2.0" },
  });
  if (!resp.ok) throw new Error(`wgzimmer search ${resp.status}`);
  return parseResultsPage(await resp.text());
}

/** Every listing in the region up to maxPrice. */
export async function scrapeWgzimmer(maxPrice, region = "zuerich") {
  const byUrl = new Map();
  let lastPage = 1;
  for (let page = 1; page <= Math.min(lastPage, MAX_PAGES); page++) {
    if (page > 1) await delay(REQUEST_DELAY_MS);
    const result = await fetchResultsPage(maxPrice, region, page);
    lastPage = Math.max(lastPage, result.lastPage);
    for (const listing of result.listings) byUrl.set(listing.url, listing);
  }
  return [...byUrl.values()];
}
