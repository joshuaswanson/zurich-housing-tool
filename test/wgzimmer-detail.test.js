import test from "node:test";
import assert from "node:assert/strict";
import { parseWgzimmerListing } from "../src/sources/wgzimmer-detail.mjs";

const detailPage = ({ until }) => `
<aside class="ad-page__box">
  <p class="ad-page__rent">
    <span class="ad-page__rent-label">Rent per month</span>
    <strong class="ad-page__rent-value">CHF 1'250</strong>
  </p>
  <dl class="ad-page__facts">
    <div class="ad-page__fact"><dt>From</dt><dd>1.11.2026</dd></div>
    <div class="ad-page__fact"><dt>Until</dt><dd>${until}</dd></div>
    <div class="ad-page__fact"><dt>Address</dt><dd>
      Beispielstrasse 12<br>
      8045 Zürich
    </dd></div>
    <div class="ad-page__fact"><dt>District</dt><dd>Wiedikon</dd></div>
    <div class="ad-page__fact"><dt>Furnished</dt><dd>Yes</dd></div>
  </dl>
</aside>
<div class="ad-page__texts page__prose">
  <section class="ad-page__text">
    <h2>The room</h2>
    <p class="ad-page__text-body">17qm und möbliert.\r\n\r\nRuhige Lage.</p>
  </section>
  <section class="ad-page__text">
    <h2>We are looking for</h2>
    <p class="ad-page__text-body">Eine unkomplizierte Person.</p>
  </section>
  <section class="ad-page__text">
    <h2>About us</h2>
    <p class="ad-page__text-body">Zwei Studierende.</p>
  </section>
  <section class="ad-page__text">
    <h2>Nearby</h2>
    <p class="ad-page__text-body">Tram 13, Coop &amp; Migros</p>
  </section>
  <section class="ad-map" data-lat="47.3607379" data-lon="8.5225431"></section>
</div>`;

test("wgzimmer detail page is parsed without a browser", () => {
  const page = detailPage({ until: "31.5.2027" });
  assert.deepEqual(parseWgzimmerListing(page, "https://example.test/x"), {
    address: "Beispielstrasse 12",
    city: "8045 Zürich",
    neighbourhood: "Wiedikon",
    nearby: "Tram 13, Coop & Migros",
    rent: 1250,
    availableFrom: "1.11.2026",
    until: "31.5.2027",
    furnished: "Yes",
    room: "17qm und möbliert.\n\nRuhige Lage.",
    lookingFor: "Eine unkomplizierte Person.",
    weAre: "Zwei Studierende.",
    lat: 47.3607379,
    lng: 8.5225431,
    url: "https://example.test/x",
  });
});

test("an open-ended listing has no end date", () => {
  const parsed = parseWgzimmerListing(detailPage({ until: "Open-ended" }), "u");
  assert.equal(parsed.until, undefined);
});

test("wgzimmer parser leaves out fields the page does not have", () => {
  const parsed = parseWgzimmerListing("<p>Not a listing</p>", "u");
  assert.deepEqual(parsed, { url: "u" });
});
