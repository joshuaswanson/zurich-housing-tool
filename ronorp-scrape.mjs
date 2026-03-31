/**
 * ronorp.net scraper for Zurich WG listings.
 * Uses CloakBrowser. Exports scrapeRonorp() and works standalone.
 */
import { launch } from "cloakbrowser";

export async function scrapeRonorp() {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const browser = await launch({ headless: true, humanize: true });

  try {
    const page = await browser.newPage();
    await page.goto(
      "https://www.ronorp.net/zuerich/immobilien/wohnen.1450/wg.1220",
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    await delay(3000);

    // Scroll a few times to load all listings (infinite scroll)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1500);
    }

    const listings = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/market/posts/"]');
      const seen = new Set();
      const results = [];

      for (const a of cards) {
        const href = a.href;
        if (seen.has(href)) continue;
        seen.add(href);

        const text = a.textContent.trim();
        if (text.length < 30) continue;
        // Skip UMS corporate listings
        if (
          text.includes("UMS Untermietservice") ||
          href.includes("moblierte-privat")
        )
          continue;

        const priceMatch = text.match(/CHF\s*([\d']+)/);
        const price = priceMatch
          ? parseInt(priceMatch[1].replace(/'/g, ""))
          : null;

        // Try to extract address
        const addrMatch = text.match(
          /(\w+(?:strasse|gasse|weg|platz)\s*\d*,?\s*\d{4}\s*\w+)/i,
        );
        const address = addrMatch ? addrMatch[1].trim() : null;

        // Check if it's someone searching (not offering) a room
        const isSearch =
          /\bSuche\b.*\b(?:Wohnung|Zimmer|WG)\b|\b(?:Wohnung|Zimmer|WG)\b.*\bgesucht\b|\bGesuch\b|\bLooking for a (?:room|flat|apartment)\b|\bich suche\b|\bwir suchen eine Wohnung\b/i.test(
            text,
          );

        results.push({
          url: href,
          price,
          address,
          isOffer: !isSearch,
          description: text.replace(/\s+/g, " ").substring(0, 400),
          source: "ronorp",
        });
      }

      return results;
    });

    // Only return offers (not people searching for rooms)
    return listings.filter((l) => l.isOffer);
  } finally {
    await browser.close();
  }
}

// Standalone mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const listings = await scrapeRonorp();
  console.log(JSON.stringify(listings, null, 2));
}
