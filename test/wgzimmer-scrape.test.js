import test from "node:test";
import assert from "node:assert/strict";
import {
  parseResultRow,
  parseResultsPage,
} from "../src/sources/wgzimmer-scrape.mjs";

const row = ({ id, title, rent, meta, badges = [] }) => `
<li class="result-row result-row--wish" id="inserat-${id}" data-ad-id="${id}">
  <div class="result-row__facts">
    <h2 class="result-row__title">
      <a class="result-row__link" href="/wglink/en/${id}/">
          ${title}
      </a>
    </h2>
    <p class="result-row__rent">${rent}</p>
    <p class="result-row__meta">
      ${meta}
    </p>
    <ul class="result-row__badges">${badges.map((b) => `<li>${b}</li>`).join("")}</ul>
    <p class="result-row__updated">Posted <time datetime="2026-10-29T22:53:02Z">1 week ago</time></p>
  </div>
</li>`;

const RESULTS_PAGE = `
<ul class="results">
${row({
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  title: "8050 Zürich, near Oerlikon",
  rent: "CHF 1190 per month",
  meta: "Available now\n        ·\n          until 26.1.2027",
  badges: ["Studio", "Furnished"],
})}
${row({
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  title: "8032 Zürich",
  rent: "CHF 1250 per month",
  meta: "Available from 1.12.2026 · unlimited",
})}
</ul>
<nav>
  <a href="/en/wgzimmer/search/mate.html?region=zuerich&amp;max=3000&amp;seite=2#sortierung">2</a>
  <a href="/en/wgzimmer/search/mate.html?region=zuerich&amp;max=3000&amp;seite=21#sortierung">21</a>
</nav>`;

test("a results page gives its listings and the last page number", () => {
  const { listings, lastPage } = parseResultsPage(RESULTS_PAGE);
  assert.equal(lastPage, 21);
  assert.deepEqual(listings[0], {
    url: "https://www.wgzimmer.ch/wglink/en/aaaaaaaa-1111-4111-8111-111111111111/",
    price: 1190,
    place: "8050 Zürich",
    availableFrom: "Immediately",
    until: "26.1.2027",
    posted: "29.10.2026",
    description:
      "8050 Zürich, near Oerlikon | CHF 1190 per month | Available now · until 26.1.2027 | Studio | Furnished",
  });
});

test("an open-ended listing has a start date and no end date", () => {
  const { listings } = parseResultsPage(RESULTS_PAGE);
  assert.equal(listings[1].availableFrom, "1.12.2026");
  assert.equal(listings[1].until, undefined);
});

test("a page without results has one page and no listings", () => {
  assert.deepEqual(parseResultsPage("<p>No ads found</p>"), {
    listings: [],
    lastPage: 1,
  });
});

test("a row without an ad id is skipped", () => {
  assert.equal(parseResultRow("<div>advert</div>"), null);
});
