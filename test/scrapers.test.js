import test from "node:test";
import assert from "node:assert/strict";
import { toListing } from "../ronorp-scrape.mjs";
import { parseDetails, parseListRows } from "../students-scrape.mjs";

const ronorpPost = (overrides) => ({
  seo_slug: "a-room",
  title: "WG Zimmer",
  description: "<p>Helles&nbsp;Zimmer</p>",
  price: "990.00",
  post_type: "offer",
  zip_code: null,
  location: null,
  housing_detail: { ready_to_move: "2026-11-01", contract: "permanent" },
  ...overrides,
});

test("ronorp listing with a street keeps the site's coordinates", () => {
  const listing = toListing(
    ronorpPost({
      location: {
        address: "Kalkbreitestrasse, Zürich, Schweiz",
        locality: "Zürich",
        latitude: 47.3725,
        longitude: 8.5175,
      },
    }),
  );
  assert.equal(listing.address, "Kalkbreitestrasse, Zürich");
  assert.equal(listing.lat, 47.3725);
  assert.equal(listing.postcode, null);
  assert.equal(listing.price, 990);
  assert.equal(listing.availableFrom, "1.11.2026");
  assert.equal(listing.description, "WG Zimmer Helles Zimmer");
});

test("ronorp listing that names only the city falls back to its postcode", () => {
  const listing = toListing(
    ronorpPost({
      zip_code: 8044,
      location: {
        address: "Zürich, Schweiz",
        locality: "Zürich",
        latitude: 47.3769,
        longitude: 8.5417,
      },
    }),
  );
  assert.equal(listing.address, "8044 Zürich");
  assert.equal(listing.lat, null);
  assert.equal(listing.postcode, "8044");
});

test("ronorp listing with only a postcode shows the bare postcode", () => {
  const listing = toListing(ronorpPost({ zip_code: 8953 }));
  assert.equal(listing.address, "8953");
  assert.equal(listing.postcode, "8953");
});

test("ronorp marks wanted posts and nightly prices", () => {
  assert.equal(toListing(ronorpPost({ post_type: "wanted" })).isOffer, false);
  const nightly = toListing(
    ronorpPost({ price: "120.00", title: "CHF 120 pro Nacht" }),
  );
  assert.equal(nightly.pricePeriod, "night");
  assert.equal(toListing(ronorpPost({})).pricePeriod, null);
});

const STUDENTS_ROW = `
<tr class="list_row_0">
  <td><img src="flatshare.gif" title="WG-Zimmer" /></td>
  <td>
    <img src="clock.gif" title="Frei ab: 01.11.2026" />
    <a href="/wohnen/details/294953/WG-Zimmer-15qm-Zuerich-Zimmer">
      <span title="Möbliertes WG Zimmer mit eigenem Bad">Möbliertes WG Zimmer mit...</span>
    </a>
  </td>
  <td><a href="/wohnen/list/140">Zürich</a></td>
  <td><small>29.09.2026</small></td>
  <td align="right">15 m² </td>
  <td align="right">1195 CHF</td>
</tr>
<tr class="list_row_1">
  <td><img src="flat.gif" title="Wohnung" /></td>
  <td><a href="/wohnen/details/294931/Wohnung-67qm-Zuerich">Gemütliche Wohnung</a></td>
  <td align="right">2802 CHF</td>
</tr>`;

test("students.ch list rows are parsed into listings", () => {
  const [room, flat] = parseListRows(STUDENTS_ROW);
  assert.equal(room.id, "294953");
  assert.equal(
    room.url,
    "https://www.students.ch/wohnen/details/294953/WG-Zimmer-15qm-Zuerich-Zimmer",
  );
  assert.equal(room.title, "Möbliertes WG Zimmer mit eigenem Bad");
  assert.equal(room.price, 1195);
  assert.equal(room.availableFrom, "01.11.2026");
  assert.equal(room.isWholeFlat, false);
  assert.equal(flat.title, "Gemütliche Wohnung");
  assert.equal(flat.price, 2802);
  assert.equal(flat.isWholeFlat, true);
});

test("students.ch detail pages give address, description and end date", () => {
  const html = `
    <meta property="og:description" content="Grosses Zimmer &amp; Balkon" />
    <small>Hagenholzstrasse 105, 8050 Zürich</small>
    <div>Frei ab: <strong>01.11.2026</strong><br />Frei bis: <strong>30.06.2027</strong></div>`;
  assert.deepEqual(parseDetails(html), {
    address: "Hagenholzstrasse 105, 8050 Zürich",
    description: "Grosses Zimmer & Balkon",
    until: "30.06.2027",
  });
  const openEnded = parseDetails(
    "<div>Frei bis: <strong>Unbeschränkt</strong></div>",
  );
  assert.equal(openEnded.until, null);
});
