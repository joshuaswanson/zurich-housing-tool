/**
 * wgzimmer.ch scraper using CloakBrowser (headless, bypasses reCAPTCHA v3).
 *
 * Exports: scrapeWgzimmer(maxPrice, region) for programmatic use.
 * Standalone: node wgzimmer-scrape.mjs [maxPrice]
 */
import { launch } from "cloakbrowser";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCH_PAGE_ATTEMPTS = 3;
const RECAPTCHA_TIMEOUT_MS = 15000;

async function openSearchForm(page, maxPrice, region, wait) {
  await page.goto(
    "https://www.wgzimmer.ch/en/wgzimmer/search/mate.html?wc_language=en",
    { waitUntil: "networkidle", timeout: 30000 },
  );

  // Dismiss cookies
  try {
    const consent = await page.$(".fc-cta-consent");
    if (consent) {
      await consent.click();
      await wait(1500);
    }
  } catch {}

  // Human-like behavior
  await page.mouse.move(400, 300);
  await wait(500);
  await page.evaluate(() => window.scrollBy(0, 300));
  await wait(1000);

  // Fill form
  await page.selectOption("#selector-state", region);
  await page.selectOption('select[name="priceMax"]', String(maxPrice));
  await wait(1000);
}

/** submitForm on the page calls grecaptcha.execute, which exists only once the library has loaded. */
async function recaptchaReady(page) {
  try {
    await page.waitForFunction(
      () =>
        typeof grecaptcha !== "undefined" &&
        typeof grecaptcha.execute === "function",
      null,
      { timeout: RECAPTCHA_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

// The functions below run inside the page.

export function submitSearch() {
  submitForm();
}

export function readResultCounts() {
  // The page shows these in capitals through CSS.
  const m = document.body.innerText.match(/TOTAL (\d+)/i);
  const p = document.body.innerText.match(/PAGE \d+\/(\d+)/i);
  return { total: m ? parseInt(m[1]) : 0, pages: p ? parseInt(p[1]) : 0 };
}

export function extractListings() {
  const results = [];
  const anchors = document.querySelectorAll('a[href*="/wglink/en/"]');
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href || href.includes("facebook")) continue;
    const entry = a.closest("li") || a.parentElement;
    if (!entry) continue;
    const text = entry.innerText || "";
    const listing = {
      url: href.startsWith("http") ? href : "https://www.wgzimmer.ch" + href,
    };
    // The price in the link can be out of date, so the displayed one wins.
    const shownPrice = entry
      .querySelector(".cost")
      ?.textContent.replace(/\D/g, "");
    const priceParts = href.match(/(\d+)-zurich/);
    if (shownPrice) listing.price = parseInt(shownPrice);
    else if (priceParts) listing.price = parseInt(priceParts[1]);
    const dates = text.match(/\d{1,2}\.\d{1,2}\.\d{4}/g);
    if (dates && dates.length >= 1) listing.posted = dates[0];
    const urlDate = href.match(/(\d{1,2}-\d{1,2}-\d{4})/);
    if (urlDate) listing.availableFrom = urlDate[1].replace(/-/g, ".");
    const hood = text.match(
      /Kreis \d+|Wiedikon|Wipkingen|Oerlikon|Schwamendingen|Albisrieden|Milchbuck|Enge|Seefeld|Höngg|Hottingen|Fluntern|Unterstrass|Oberstrass|Aussersihl|Langstrasse|Altstetten|Affoltern|Leimbach|Wollishofen/i,
    );
    if (hood) listing.neighborhood = hood[0];
    const dateText = entry.querySelector(".from-date")?.innerText || text;
    const until = dateText.match(/Until:\s*([^\n]+)/i);
    if (until) listing.until = until[1].trim();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 2 && l !== "\u2665");
    listing.description = lines.join(" | ");
    results.push(listing);
  }
  return results;
}

export function goToNextPage() {
  const links = document.querySelectorAll("a");
  for (const l of links) {
    if (l.textContent.trim().toUpperCase() === "NEXT") {
      l.click();
      break;
    }
  }
}

/**
 * Run the search on an open page and collect the listings from every result
 * page. `pace` scales the pauses between steps.
 */
export async function scrapeSearchResults(
  page,
  maxPrice,
  region,
  { pace = 1 } = {},
) {
  const wait = (ms) => delay(ms * pace);

  // The search page sometimes stalls while loading, and the reCAPTCHA
  // library sometimes fails to download, so the page is loaded again
  // when it does not become ready.
  for (let attempt = 1; ; attempt++) {
    let failure = "reCAPTCHA script did not load";
    try {
      await openSearchForm(page, maxPrice, region, wait);
      if (await recaptchaReady(page)) break;
    } catch (e) {
      failure = e.message.split("\n")[0];
    }
    if (attempt === SEARCH_PAGE_ATTEMPTS) throw new Error(failure);
  }
  await page.evaluate(submitSearch);
  await wait(8000);

  const info = await page.evaluate(readResultCounts);
  if (!info.total) return [];

  const totalPages = info.pages || 1;
  const allListings = [];
  for (let pg = 1; pg <= totalPages; pg++) {
    process.stderr.write(`  page ${pg}/${totalPages}\r`);
    allListings.push(...(await page.evaluate(extractListings)));
    if (pg < totalPages) {
      await page.evaluate(goToNextPage);
      await wait(4000);
    }
  }
  process.stderr.write("\n");

  // A listing can appear on two result pages when new posts shift the
  // pagination during the scrape.
  return [...new Map(allListings.map((l) => [l.url, l])).values()];
}

/**
 * Scrape wgzimmer.ch for Zurich listings up to maxPrice.
 * @param {number} maxPrice - Maximum rent in CHF
 * @param {string} region - wgzimmer region selector value (default: "zurich-stadt")
 * Returns an array of raw listing objects.
 */
export async function scrapeWgzimmer(maxPrice = 1500, region = "zurich-stadt") {
  const browser = await launch({ headless: true, humanize: true });
  try {
    return await scrapeSearchResults(await browser.newPage(), maxPrice, region);
  } finally {
    await browser.close();
  }
}

// ── Standalone mode ────────────────────────────────────────────────────────
if (
  (process.argv[1] && import.meta.url === "file://" + process.argv[1]) ||
  import.meta.url === new URL(process.argv[1], "file://").href
) {
  const maxPrice = parseInt(process.argv[2]) || 1500;
  const listings = await scrapeWgzimmer(maxPrice);
  console.log(JSON.stringify(listings));
}
