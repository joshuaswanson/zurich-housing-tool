/**
 * wgzimmer.ch scraper using CloakBrowser (headless, bypasses reCAPTCHA v3).
 *
 * Exports: scrapeWgzimmer(maxPrice) for programmatic use.
 * Standalone: node wgzimmer-scrape.mjs [maxPrice]
 */
import { launch } from "cloakbrowser";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape wgzimmer.ch for Zurich listings up to maxPrice.
 * Returns an array of raw listing objects.
 */
export async function scrapeWgzimmer(maxPrice = 1500) {
  const browser = await launch({ headless: true, humanize: true });
  try {
    const page = await browser.newPage();

    await page.goto(
      "https://www.wgzimmer.ch/en/wgzimmer/search/mate.html?wc_language=en",
      { waitUntil: "networkidle", timeout: 30000 },
    );

    // Dismiss cookies
    try {
      const consent = await page.$(".fc-cta-consent");
      if (consent) {
        await consent.click();
        await delay(1500);
      }
    } catch {}

    // Human-like behavior
    await page.mouse.move(400, 300);
    await delay(500);
    await page.evaluate(() => window.scrollBy(0, 300));
    await delay(1000);

    // Fill form
    await page.selectOption("#selector-state", "zurich-stadt");
    await page.selectOption('select[name="priceMax"]', String(maxPrice));
    await delay(1000);

    // Submit (reCAPTCHA handled by submitForm)
    await page.evaluate(() => submitForm());
    await delay(8000);

    // Check for results
    const info = await page.evaluate(() => {
      const m = document.body.innerText.match(/TOTAL (\d+)/);
      const p = document.body.innerText.match(/PAGE \d+\/(\d+)/);
      return { total: m ? parseInt(m[1]) : 0, pages: p ? parseInt(p[1]) : 0 };
    });

    if (!info.total) {
      return [];
    }

    const totalPages = info.pages || 1;
    const allListings = [];

    // JS to extract listings from a page
    const extractJS = () => {
      const results = [];
      const anchors = document.querySelectorAll('a[href*="/wglink/en/"]');
      for (const a of anchors) {
        const href = a.getAttribute("href");
        if (!href || href.includes("facebook")) continue;
        const entry = a.closest("li") || a.parentElement;
        if (!entry) continue;
        const text = entry.innerText || "";
        const listing = {
          url: href.startsWith("http")
            ? href
            : "https://www.wgzimmer.ch" + href,
        };
        const priceParts = href.match(/(\d+)-zurich/);
        if (priceParts) listing.price = parseInt(priceParts[1]);
        const dates = text.match(/\d{1,2}\.\d{1,2}\.\d{4}/g);
        if (dates && dates.length >= 1) listing.posted = dates[0];
        const urlDate = href.match(/(\d{1,2}-\d{1,2}-\d{4})/);
        if (urlDate) listing.availableFrom = urlDate[1].replace(/-/g, ".");
        const hood = text.match(
          /Kreis \d+|Wiedikon|Wipkingen|Oerlikon|Schwamendingen|Albisrieden|Milchbuck|Enge|Seefeld|Höngg|Hottingen|Fluntern|Unterstrass|Oberstrass|Aussersihl|Langstrasse|Altstetten|Affoltern|Leimbach|Wollishofen/i,
        );
        if (hood) listing.neighborhood = hood[0];
        const until = text.match(/Until:\s*([^\n]+)/i);
        if (until) listing.until = until[1].trim();
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 2 && l !== "\u2665");
        listing.description = lines.join(" | ").substring(0, 400);
        results.push(listing);
      }
      return results;
    };

    for (let pg = 1; pg <= totalPages; pg++) {
      process.stderr.write(`  page ${pg}/${totalPages}\r`);
      const listings = await page.evaluate(extractJS);
      allListings.push(...listings);

      if (pg < totalPages) {
        await page.evaluate(() => {
          const links = document.querySelectorAll("a");
          for (const l of links) {
            if (l.textContent.trim().toUpperCase() === "NEXT") {
              l.click();
              break;
            }
          }
        });
        await delay(4000);
      }
    }

    process.stderr.write("\n");
    return allListings;
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
