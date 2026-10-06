import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { launch } from "cloakbrowser";
import {
  extractListings,
  goToNextPage,
  readResultCounts,
  scrapeSearchResults,
  submitSearch,
} from "../wgzimmer-scrape.mjs";

const RESULTS_PAGE_URL = new URL(
  "./fixtures/wgzimmer-results.html",
  import.meta.url,
).href;

// ── In a real browser, against a saved results page ─────────────────────────

let browser;
let page;

before(async () => {
  browser = await launch({ headless: true });
  page = await browser.newPage();
  await page.goto(RESULTS_PAGE_URL, { waitUntil: "domcontentloaded" });
});

after(async () => {
  await browser?.close();
});

test("result counts are read from the results page", async () => {
  assert.deepEqual(await page.evaluate(readResultCounts), {
    total: 3,
    pages: 2,
  });
});

test("listings are extracted from the result rows", async () => {
  const listings = await page.evaluate(extractListings);
  assert.equal(listings.length, 2);
  assert.deepEqual(listings[0], {
    url: "https://www.wgzimmer.ch/wglink/en/aaaaaaaa-1111-4111-8111-111111111111/zurich-stadt/1-12-2026-1560-zurich-stadt.html",
    price: 1490,
    posted: "6.10.2026",
    availableFrom: "1.12.2026",
    neighborhood: "Kreis 5",
    until: "No time restrictions",
    description:
      "6.10.2026 | Zürich (Stadt) | Kreis 5 Limmatplatz | Limmatplatz, Limmat, HB | 1.12.2026 | Until: No time restrictions | 1,490",
  });
  assert.equal(listings[1].price, 900);
  assert.equal(listings[1].neighborhood, "Wiedikon");
  assert.equal(listings[1].until, "31.03.2027");
});

test("the displayed price wins over the price in the link", async () => {
  const [first] = await page.evaluate(extractListings);
  assert.match(first.url, /-1560-zurich/);
  assert.equal(first.price, 1490);
});

// ── The whole search flow, with a scripted page ─────────────────────────────

function scriptedPage({ gotoFailures = 0, recaptchaFailures = 0, pages }) {
  const calls = { goto: 0, submitted: 0, nextClicks: 0 };
  let currentPage = 0;
  return {
    calls,
    async goto() {
      calls.goto++;
      if (calls.goto <= gotoFailures) {
        throw new Error("page.goto: Timeout 30000ms exceeded.\nCall log: ...");
      }
    },
    async $() {
      return null;
    },
    mouse: { async move() {} },
    async selectOption() {},
    async waitForFunction() {
      if (recaptchaFailures-- > 0) throw new Error("Timeout");
    },
    async evaluate(fn) {
      if (fn === submitSearch) calls.submitted++;
      if (fn === readResultCounts) {
        return { total: pages.flat().length, pages: pages.length };
      }
      if (fn === extractListings) return pages[currentPage];
      if (fn === goToNextPage) {
        calls.nextClicks++;
        currentPage++;
      }
    },
  };
}

const listing = (id) => ({ url: `https://www.wgzimmer.ch/wglink/en/${id}` });

test("every result page is collected and duplicates are dropped", async () => {
  const fake = scriptedPage({
    pages: [[listing("a"), listing("b")], [listing("b"), listing("c")]],
  });
  const listings = await scrapeSearchResults(fake, 2000, "zurich-stadt", {
    pace: 0,
  });
  assert.deepEqual(
    listings.map((l) => l.url.split("/").pop()),
    ["a", "b", "c"],
  );
  assert.equal(fake.calls.submitted, 1);
  assert.equal(fake.calls.nextClicks, 1);
});

test("a search with no results returns an empty list", async () => {
  const fake = scriptedPage({ pages: [] });
  assert.deepEqual(
    await scrapeSearchResults(fake, 2000, "zurich-stadt", { pace: 0 }),
    [],
  );
});

test("the search page is loaded again after a stall or a missing reCAPTCHA", async () => {
  const fake = scriptedPage({
    gotoFailures: 1,
    recaptchaFailures: 1,
    pages: [[listing("a")]],
  });
  const listings = await scrapeSearchResults(fake, 2000, "zurich-stadt", {
    pace: 0,
  });
  assert.equal(listings.length, 1);
  assert.equal(fake.calls.goto, 3);
});

test("the search gives up after three failed attempts", async () => {
  const stalled = scriptedPage({ gotoFailures: 3, pages: [[listing("a")]] });
  await assert.rejects(
    scrapeSearchResults(stalled, 2000, "zurich-stadt", { pace: 0 }),
    { message: "page.goto: Timeout 30000ms exceeded." },
  );
  assert.equal(stalled.calls.goto, 3);
  assert.equal(stalled.calls.submitted, 0);

  const noRecaptcha = scriptedPage({
    recaptchaFailures: 3,
    pages: [[listing("a")]],
  });
  await assert.rejects(
    scrapeSearchResults(noRecaptcha, 2000, "zurich-stadt", { pace: 0 }),
    { message: "reCAPTCHA script did not load" },
  );
});
