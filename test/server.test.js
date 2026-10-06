import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const WG_UUID = "11111111-2222-4333-8444-555555555555";
const WG_URL = `https://www.wgzimmer.ch/wglink/en/${WG_UUID}/zurich-stadt/1-11-2026-900-zurich-stadt.html`;
const FLATFOX_URL = "https://flatfox.ch/en/flat/8001-zurich/10000001/";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "zht-test-"));
const dataDir = path.join(home, "data");
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

writeJson(path.join(dataDir, "wgzimmer_listings.json"), [
  {
    url: WG_URL,
    price: 900,
    availableFrom: "1.11.2026",
    until: "31.5.2027",
    neighborhood: "Wiedikon",
    description: "Wir suchen eine Mitbewohnerin | Wiedikon",
  },
  { url: "https://www.wgzimmer.ch/wglink/en/no-price.html" },
]);
writeJson(path.join(dataDir, "listings", `${WG_UUID}.json`), {
  address: "Beispielstrasse 12",
  lat: 47.3725,
  lng: 8.5175,
  room: "Helles Zimmer",
});
writeJson(path.join(dataDir, "flatfox_cache.json"), [
  {
    pk: 10000001,
    latitude: 47.3808,
    longitude: 8.5173,
    price_display: 1200,
    address: "8004 Zürich",
    description: "Zimmer im Kreis 4",
    availableFrom: "Immediately",
  },
  {
    pk: 10000002,
    latitude: 47.3606,
    longitude: 8.5289,
    price_display: 1500,
    address: "Schulhausstrasse 5, 8002 Zürich",
    description: "Offered by A/NTERIM",
    availableFrom: "By agreement",
  },
]);
writeJson(path.join(dataDir, "ronorp_cache.json"), [
  {
    url: "https://ronorp.net/market/posts/nightly-room",
    price: 120,
    pricePeriod: "night",
    address: "8005",
    lat: 47.3864,
    lng: 8.5245,
    isOffer: true,
    description: "CHF 120 pro Nacht",
    isTemporary: true,
  },
  { url: "https://ronorp.net/market/posts/wanted", price: 800, isOffer: false },
]);
writeJson(path.join(dataDir, "students_cache.json"), [
  {
    url: "https://www.students.ch/wohnen/details/294931/Wohnung-67qm",
    price: 1900,
    isWholeFlat: true,
    address: "Langstrasse 242, 8005 Zürich",
    lat: 47.3812,
    lng: 8.5281,
    description: "Gemütliche Wohnung",
    availableFrom: "01.11.2026",
    until: null,
  },
]);
writeJson(path.join(dataDir, "seen.json"), {
  [`wgzimmer-${WG_UUID}`]: { firstSeen: "2026-10-01T10:00:00.000Z" },
});

process.env.ZHT_HOME = home;
const { app } = await import("../server.js");

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const get = async (route) => {
  const res = await fetch(baseUrl + route);
  return { status: res.status, body: await res.json() };
};
const post = async (route, payload) => {
  const res = await fetch(baseUrl + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

test("the dashboard page is served", async () => {
  const res = await fetch(baseUrl + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Zurich housing tool<\/title>/);
});

test("config reports the target and the default exclusions", async () => {
  const { body } = await get("/api/config");
  assert.equal(body.target.label, "ETH Zentrum");
  assert.equal(body.maxPrice, 2000);
  assert.deepEqual(body.exclude, {
    genderRestricted: true,
    studentHousing: true,
    shortSublets: true,
  });
});

test("listings combine all four sources and skip unusable entries", async () => {
  const { body } = await get("/api/listings");
  assert.deepEqual(body.map((l) => l.source).sort(), [
    "flatfox",
    "flatfox",
    "ronorp",
    "students",
    "wgzimmer",
  ]);
});

test("a fetched wgzimmer listing carries its details and flags", async () => {
  const { body } = await get("/api/listings");
  const listing = body.find((l) => l.source === "wgzimmer");
  assert.equal(listing.id, `wgzimmer-${WG_UUID}`);
  assert.equal(listing.address, "Beispielstrasse 12");
  assert.equal(listing.lat, 47.3725);
  assert.ok(listing.dist > 2 && listing.dist < 3, `dist ${listing.dist}`);
  assert.equal(listing.firstSeen, "2026-10-01T10:00:00.000Z");
  assert.equal(listing.hasEndDate, true);
  assert.equal(listing.genderRestricted, true);
  assert.equal(listing.approximate, false);
});

test("flatfox listings are flagged as approximate or as bulk posters", async () => {
  const { body } = await get("/api/listings");
  const postcodeOnly = body.find((l) => l.id === "flatfox-10000001");
  const withStreet = body.find((l) => l.id === "flatfox-10000002");
  assert.equal(postcodeOnly.approximate, true);
  assert.equal(postcodeOnly.url, FLATFOX_URL);
  assert.equal(withStreet.approximate, false);
  assert.equal(withStreet.bulkPoster, true);
  assert.equal(postcodeOnly.bulkPoster, false);
});

test("ronorp nightly prices count as short sublets", async () => {
  const { body } = await get("/api/listings");
  const listing = body.find((l) => l.source === "ronorp");
  assert.equal(listing.pricePeriod, "night");
  assert.equal(listing.shortSublet, true);
  assert.equal(listing.hasEndDate, true);
  assert.equal(listing.approximate, true);
});

test("students.ch whole flats are marked", async () => {
  const { body } = await get("/api/listings");
  const listing = body.find((l) => l.source === "students");
  assert.equal(listing.id, "students-294931");
  assert.equal(listing.wholeFlat, true);
  assert.equal(listing.approximate, false);
});

test("tracking moves a listing between categories and back out", async () => {
  assert.deepEqual((await get("/api/tracker")).body.applied, []);

  await post("/api/track", {
    url: FLATFOX_URL,
    action: "apply",
    address: "8004 Zürich",
    price: 1200,
  });
  let tracker = (await get("/api/tracker")).body;
  assert.equal(tracker.applied.length, 1);
  assert.equal(tracker.applied[0].price, 1200);

  // A different URL for the same flatfox listing must match the entry.
  await post("/api/track", {
    url: "https://flatfox.ch/en/flat/8004-zurich/10000001/",
    action: "reject",
  });
  tracker = (await get("/api/tracker")).body;
  assert.equal(tracker.applied.length, 0);
  assert.equal(tracker.rejected.length, 1);
  assert.ok(tracker.rejected[0].rejectedDate);

  await post("/api/track", { url: FLATFOX_URL, action: "exclude", reason: "too far" });
  tracker = (await get("/api/tracker")).body;
  assert.equal(tracker.rejected.length, 0);
  assert.equal(tracker.excluded[0].reason, "too far");

  await post("/api/track", { url: FLATFOX_URL, action: "untrack" });
  tracker = (await get("/api/tracker")).body;
  assert.equal(tracker.excluded.length, 0);
});

test("tracking rejects bad requests", async () => {
  assert.equal((await post("/api/track", { action: "apply" })).status, 400);
  assert.equal(
    (await post("/api/track", { url: FLATFOX_URL, action: "nonsense" })).status,
    400,
  );
});

test("notes are saved under the listing and removed when emptied", async () => {
  await post("/api/note", { url: WG_URL, text: "  call on Monday  " });
  assert.equal(
    (await get("/api/tracker")).body.notes[WG_UUID],
    "call on Monday",
  );
  await post("/api/note", { url: WG_URL, text: "" });
  assert.equal((await get("/api/tracker")).body.notes[WG_UUID], undefined);
  assert.equal((await post("/api/note", { text: "x" })).status, 400);
});

test("the profile is saved with known fields only", async () => {
  const empty = (await get("/api/profile")).body;
  assert.equal(empty.profile, null);
  assert.ok(empty.fields.includes("name") && empty.fields.includes("hobbies"));

  await post("/api/profile", {
    name: "Test Person",
    age: 25,
    hobbies: ["climbing"],
    occupation: "",
    notAField: "ignored",
  });
  assert.deepEqual((await get("/api/profile")).body.profile, {
    name: "Test Person",
    age: 25,
    hobbies: ["climbing"],
  });
});

test("a saved message can be read back", async () => {
  assert.deepEqual((await get("/api/applications")).body, []);
  await post("/api/application", { url: WG_URL, message: "Hallo zusammen" });
  const saved = (await get("/api/applications")).body;
  assert.equal(saved.length, 1);
  assert.ok(saved[0].content.includes(WG_URL));
  assert.ok(saved[0].content.includes("Hallo zusammen"));
  assert.equal((await post("/api/application", { url: WG_URL })).status, 400);
});

test("listing details come from the cache", async () => {
  const hit = await get(`/api/listing-details?url=${encodeURIComponent(WG_URL)}`);
  assert.equal(hit.body.room, "Helles Zimmer");
  const miss = await get(
    `/api/listing-details?url=${encodeURIComponent(FLATFOX_URL)}`,
  );
  assert.equal(miss.body, null);
});

test("fetching details is limited to wgzimmer and flatfox", async () => {
  const res = await post("/api/fetch-details", {
    url: "https://ronorp.net/market/posts/a-room",
  });
  assert.equal(res.status, 400);
  assert.equal((await post("/api/fetch-details", { url: "--all" })).status, 400);
});

test("drafting explains what is missing", async () => {
  assert.equal((await post("/api/generate", {})).status, 400);
  const unfetched = await post("/api/generate", { url: FLATFOX_URL });
  assert.equal(unfetched.status, 400);
  assert.match(unfetched.body.error, /not fetched/i);
});

test("scan status is empty before a scan and reported after one", async () => {
  assert.equal((await get("/api/scan-status")).body, null);
  writeJson(path.join(dataDir, "scan_status.json"), {
    finishedAt: "2026-10-06T12:00:00.000Z",
    sources: { flatfox: { ok: true, count: 2 } },
  });
  const { body } = await get("/api/scan-status");
  assert.equal(body.sources.flatfox.count, 2);
  assert.equal(body.fetchingDetails, false);
});
