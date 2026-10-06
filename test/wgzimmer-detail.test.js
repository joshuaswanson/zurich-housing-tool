import test from "node:test";
import assert from "node:assert/strict";
import { parseWgzimmerListing } from "../wgzimmer-detail.mjs";

const DETAIL_PAGE = `
<div class="wrap col-wrap date-cost">
  <h3 class="label">Dates and rent</h3>
  <p><strong>Starting from</strong> 1.11.2026</p>
  <p><strong>Until</strong> No time restrictions</p>
  <p><strong>Monthly rent</strong> sFr. 1'250 .–</p>
</div>
<div class="wrap col-wrap adress-region">
  <h3 class="label">Address</h3>
  <p><strong>State</strong> Zurich (City)</p>
  <p><strong>Address</strong> Beispielstrasse 12</p>
  <p><strong>City</strong> 8045 Zürich</p>
  <p><strong>Neighbourhood</strong> 3</p>
  <p><strong>Nearby</strong> Tram 13, Coop &amp; Migros</p>
  <script>
    var map = new ol.Map({
      view: new ol.View({ center: ol.proj.fromLonLat([8.5225431, 47.3607379]) })
    });
  </script>
</div>
<div class="wrap col-wrap mate-content nbb">
  <h3 class="label">Description</h3>
  <p><strong class="float">The room is</strong>17qm und möbliert.<br><br>
  Ruhige Lage.</p>
</div>
<div class="wrap col-wrap room-content">
  <h3 class="label">We are looking for</h3>
  <p>Eine unkomplizierte Person.</p>
</div>
<div class="wrap col-wrap person-content">
  <h3 class="label">We are</h3>
  <p>Zwei Studierende.</p>
</div>
<div class="wrap col-wrap mate-contact">
  <h3 class="label">Contact</h3>
</div>`;

test("wgzimmer detail page is parsed without a browser", () => {
  assert.deepEqual(parseWgzimmerListing(DETAIL_PAGE, "https://example.test/x"), {
    address: "Beispielstrasse 12",
    city: "8045 Zürich",
    neighbourhood: "3",
    nearby: "Tram 13, Coop & Migros",
    rent: 1250,
    availableFrom: "1.11.2026",
    until: "No time restrictions",
    room: "17qm und möbliert.\n\nRuhige Lage.",
    lookingFor: "Eine unkomplizierte Person.",
    weAre: "Zwei Studierende.",
    lng: 8.5225431,
    lat: 47.3607379,
    url: "https://example.test/x",
  });
});

test("wgzimmer parser leaves out fields the page does not have", () => {
  const parsed = parseWgzimmerListing("<p>Not a listing</p>", "u");
  assert.deepEqual(parsed, { url: "u" });
});
