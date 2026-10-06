import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpamPatterns,
  cacheKeyFromUrl,
  distKm,
  isGenderRestricted,
  isShortSublet,
  walkMin,
} from "../lib.js";

test("distKm measures ETH Zentrum to ETH Hönggerberg", () => {
  const km = distKm(
    { lat: 47.3764, lng: 8.5483 },
    { lat: 47.4085, lng: 8.5075 },
  );
  assert.ok(km > 4.6 && km < 4.8, `got ${km}`);
});

test("walkMin assumes 12 minutes per km", () => {
  assert.equal(walkMin(2.5), 30);
});

test("cacheKeyFromUrl uses the wgzimmer UUID and the flatfox number", () => {
  assert.equal(
    cacheKeyFromUrl(
      "https://www.wgzimmer.ch/wglink/en/357c17cb-5f5d-4310-afaf-99452aac5993/zurich-stadt/x.html",
    ),
    "357c17cb-5f5d-4310-afaf-99452aac5993",
  );
  assert.equal(
    cacheKeyFromUrl("https://flatfox.ch/en/flat/8001-zurich/86422385/"),
    "flatfox-86422385",
  );
  assert.equal(cacheKeyFromUrl("https://ronorp.net/market/posts/a-room"), null);
});

test("isGenderRestricted flags female-only listings", () => {
  assert.equal(isGenderRestricted("Wir suchen eine Mitbewohnerin"), true);
  assert.equal(isGenderRestricted("female only flat"), true);
  assert.equal(isGenderRestricted("Frauen-WG im Kreis 4"), true);
});

test("isGenderRestricted accepts inclusive wording", () => {
  assert.equal(
    isGenderRestricted("Wir suchen Mitbewohner oder Mitbewohnerin"),
    false,
  );
  assert.equal(isGenderRestricted("Helles Zimmer nahe ETH"), false);
  assert.equal(isGenderRestricted(""), false);
});

test("isShortSublet compares the stay with the minimum duration", () => {
  const sixWeeks = { availableFrom: "1.11.2026", until: "15.12.2026" };
  const sixMonths = { availableFrom: "1.11.2026", until: "30.4.2027" };
  assert.equal(isShortSublet(sixWeeks, 60), true);
  assert.equal(isShortSublet(sixMonths, 60), false);
});

test("isShortSublet treats open-ended and undated listings as long", () => {
  assert.equal(
    isShortSublet({ availableFrom: "1.11.2026", until: "No time restrictions" }, 60),
    false,
  );
  assert.equal(isShortSublet({ availableFrom: "1.11.2026" }, 60), false);
  assert.equal(isShortSublet({}, 60), false);
});

test("buildSpamPatterns matches built-in posters and config terms", () => {
  const patterns = buildSpamPatterns(["Acme Living (Zürich)"]);
  const matches = (text) => patterns.some((p) => p.test(text));
  assert.equal(matches("Furnished rooms by A/NTERIM"), true);
  assert.equal(matches("offered by acme living (zürich)"), true);
  assert.equal(matches("Private room in a shared flat"), false);
});
