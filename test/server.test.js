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
    place: "8003 Zürich",
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
const { app } = await import("../src/server.js");

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

test("drafting offers Ollama and an online service without the macOS app", async () => {
  const { body } = await get("/api/llm-providers");
  assert.deepEqual(body, ["ollama", "api"]);
});

test("the API key is stored privately and never sent back", async () => {
  assert.equal((await get("/api/llm-api")).body.keyEnding, null);
  const saved = await post("/api/llm-api", {
    apiKey: "sk-or-test-1234",
    model: "",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.keyEnding, "1234");
  assert.equal(saved.body.model, "openai/gpt-4.1-mini");
  assert.equal(JSON.stringify((await get("/api/llm-api")).body).includes("sk-or"), false);
  const file = path.join(home, "data", "llm-api.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  await post("/api/llm-api", { model: "gpt-test" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).apiKey, "sk-or-test-1234");
  await post("/api/llm-api", { apiKey: "sk-or-test-1234" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "gpt-test");
});

test("a key saved for another service is not sent to OpenRouter", async () => {
  const file = path.join(home, "data", "llm-api.json");
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ service: "openai", apiKey: "sk-openai-5678", model: "gpt-x" }));
  assert.deepEqual((await get("/api/llm-api")).body, { model: "openai/gpt-4.1-mini", keyEnding: null });
  fs.writeFileSync(file, before);
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

test("sending to WGZimmer validates the profile and target before launching", async () => {
  const missingContact = await post("/api/send-wgzimmer", {
    url: WG_URL,
    message: "Hallo zusammen",
  });
  assert.equal(missingContact.status, 400);
  assert.match(missingContact.body.error, /email/i);

  const wrongTarget = await post("/api/send-wgzimmer", {
    url: "https://example.com/11111111-2222-4333-8444-555555555555",
    message: "Hallo zusammen",
  });
  assert.equal(wrongTarget.status, 400);
  assert.match(wrongTarget.body.error, /WGZimmer listing URL/i);
});

test("sending to Flatfox validates the profile and target before launching", async () => {
  const missingContact = await post("/api/send-flatfox", {
    url: FLATFOX_URL,
    message: "Hello there",
  });
  assert.equal(missingContact.status, 400);
  assert.match(missingContact.body.error, /email/i);

  const wrongTarget = await post("/api/send-flatfox", {
    url: "https://example.com/en/flat/8001-zurich/10000001/",
    message: "Hello there",
  });
  assert.equal(wrongTarget.status, 400);
  assert.match(wrongTarget.body.error, /Flatfox listing URL/i);

  const dossier = await post("/api/send-flatfox", {
    url: "https://flatfox.ch/en/listing/10000001/submit/",
    message: "Hello there",
  });
  assert.equal(dossier.status, 400);
  assert.match(dossier.body.error, /Flatfox listing URL/i);
});

test("Flatfox reports a disconnected session before a profile exists", async () => {
  const status = await get("/api/flatfox-session");
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { connected: false });
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

test("drafting through an online service sends the prompt with the saved key", async () => {
  await post("/api/profile", { name: "Jane Doe", occupation: "Student" });
  await post("/api/llm-api", { apiKey: "sk-test-9876", model: "gpt-test" });
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://openrouter.ai/")) return realFetch(url, options);
    sent = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({ choices: [{ message: { content: " Hallo zusammen " } }] });
  };
  try {
    const { status, body } = await post("/api/generate", { url: WG_URL, provider: "api" });
    assert.equal(status, 200);
    assert.deepEqual(body, { message: "Hallo zusammen", model: "gpt-test" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(sent.headers.Authorization, "Bearer sk-test-9876");
  assert.equal(sent.body.model, "gpt-test");
  assert.match(sent.body.messages[0].content, /Helles Zimmer/);
});

test("a rejected API key is reported", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    String(url).startsWith("https://openrouter.ai/")
      ? Response.json({ error: { message: "bad key" } }, { status: 401 })
      : realFetch(url, options);
  try {
    const { status, body } = await post("/api/generate", { url: WG_URL, provider: "api" });
    assert.equal(status, 500);
    assert.match(body.error, /rejected the API key/);
  } finally {
    globalThis.fetch = realFetch;
  }
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

test("geocoding retries after network errors and remembers misses", async () => {
  const { geocodeAddress } = await import("../src/lib.js");
  const answers = [
    () => {
      throw new Error("offline");
    },
    () => Response.json([{ lat: "47.37", lon: "8.54" }]),
    () => Response.json([]),
  ];
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => answers[calls++]();
  try {
    assert.equal(await geocodeAddress("Seefeldstrasse 1"), null);
    const found = { lat: 47.37, lng: 8.54 };
    assert.deepEqual(await geocodeAddress("Seefeldstrasse 1"), found);
    assert.deepEqual(await geocodeAddress("Seefeldstrasse 1"), found);
    assert.equal(await geocodeAddress("Nowhere 99"), null);
    assert.equal(await geocodeAddress("Nowhere 99"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 3);
});

test("the search covers rooms until apartments are chosen", async () => {
  assert.deepEqual((await get("/api/search")).body, { housing: "room", maxPrice: 3000 });
  assert.equal((await post("/api/search", { housing: "castle" })).status, 400);
});

test("an apartment search drops room-only sites and writes to a landlord", async () => {
  const { status, body } = await post("/api/search", { housing: "apartment" });
  assert.equal(status, 200);
  assert.deepEqual(body, { housing: "apartment", maxPrice: 6000 });
  assert.ok(!fs.existsSync(path.join(dataDir, "flatfox_cache.json")));
  assert.ok(!fs.existsSync(path.join(dataDir, "ronorp_cache.json")));
  assert.deepEqual((await get("/api/listings")).body, []);

  const realFetch = globalThis.fetch;
  let prompt;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith("https://openrouter.ai/")) return realFetch(url, options);
    prompt = JSON.parse(options.body).messages[0].content;
    return Response.json({ choices: [{ message: { content: "Guten Tag" } }] });
  };
  try {
    assert.equal((await post("/api/generate", { url: WG_URL, provider: "api" })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(prompt, /landlord or property manager/);
  assert.match(prompt, /application dossier/);
});

test("only a fluent German entry counts as speaking German", async () => {
  const { germanLevel } = await import("../src/server.js");
  assert.equal(germanLevel("Deutsch (Muttersprache), Englisch"), "fluent");
  assert.equal(germanLevel("English native, German C1"), "fluent");
  assert.equal(germanLevel("English, a bit of German"), "learning");
  assert.equal(germanLevel("Native English and basic German"), "learning");
  assert.equal(germanLevel("Fluent in English and German A2"), "learning");
  assert.equal(germanLevel("English, French"), "none");
  assert.equal(germanLevel(undefined), "none");
});

test("the template is saved with the profile and filled in per listing", async () => {
  const { fillMessage } = await import("../src/server.js");
  assert.equal(
    fillMessage("Is the room at {address} free? {address}", { address: "8004 Zürich" }),
    "Is the room at 8004 Zürich free? 8004 Zürich",
  );

  await post("/api/profile", { name: "Jane Doe", message: "Hi, is {address} still free?" });
  assert.equal((await get("/api/profile")).body.profile.message, "Hi, is {address} still free?");
});

test("the saved message goes to new Flatfox listings in one paced batch", async () => {
  const flatfoxUrl = (pk) => `https://flatfox.ch/en/flat/8004-zurich/${pk}/`;
  writeJson(path.join(dataDir, "flatfox_cache.json"), [
    { pk: 20000001, latitude: 47.38, longitude: 8.51, price_display: 1200, address: "A 1, 8004 Zürich", url: flatfoxUrl(20000001) },
    { pk: 20000002, latitude: 47.38, longitude: 8.51, price_display: 1300, address: "B 2, 8004 Zürich", url: flatfoxUrl(20000002) },
    { pk: 20000003, latitude: 47.38, longitude: 8.51, price_display: 1400, address: "C 3, 8004 Zürich", url: flatfoxUrl(20000003) },
  ]);
  const urls = (await get("/api/listings")).body
    .filter((l) => l.source === "flatfox")
    .map((l) => l.url);
  assert.equal(urls.length, 3);

  await post("/api/profile", { name: "Jane Doe" });
  const noMessage = await post("/api/send-flatfox-batch", { urls });
  assert.equal(noMessage.status, 400);
  assert.match(noMessage.body.error, /message/i);

  await post("/api/profile", { name: "Jane Doe", email: "jane@example.com", phone: "+41 79 000 00 00", message: "Hi about {address}" });
  await post("/api/track", { url: urls[2], action: "shortlist" });

  const sent = [];
  app.locals.flatfoxBatchPauseMs = () => 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  app.locals.sendFlatfox = async (application) => {
    await gate;
    if (application.url.includes("20000002")) throw new Error("Flatfox returned HTTP 500.");
    sent.push(application);
  };
  const started = await post("/api/send-flatfox-batch", { urls: [...urls, "https://example.com/x"] });
  assert.equal(started.status, 200);
  assert.equal(started.body.total, 2);
  assert.equal((await post("/api/send-flatfox-batch", { urls })).status, 409);
  release();

  let status;
  do status = (await get("/api/send-flatfox-batch")).body;
  while (status.running);
  assert.equal(status.sent.length, 1);
  assert.equal(status.failed.length, 1);
  assert.match(status.failed[0].error, /HTTP 500/);
  assert.equal(sent[0].message, "Hi about A 1, 8004 Zürich");
  assert.equal(sent[0].email, "jane@example.com");

  const tracker = (await get("/api/tracker")).body;
  assert.ok(tracker.applied.some((e) => e.url === sent[0].url));
  assert.ok(!tracker.applied.some((e) => e.url.includes("20000002")));
  const messages = (await get("/api/applications")).body;
  assert.ok(messages.some((m) => m.content.includes("Hi about A 1")));

  const again = await post("/api/send-flatfox-batch", { urls: [urls[0], urls[2]] });
  assert.equal(again.status, 400);
});

test("Ollama lists installed models and writes with the chosen one", async () => {
  const realFetch = globalThis.fetch;
  let used;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target === "http://localhost:11434/api/tags") {
      return Response.json({ models: [{ name: "qwen3:8b", size: 5 }, { name: "llama3.2:latest", size: 2 }] });
    }
    if (target === "http://localhost:11434/api/generate") {
      used = JSON.parse(options.body).model;
      return Response.json({ response: "Hallo" });
    }
    return realFetch(url, options);
  };
  try {
    assert.deepEqual((await get("/api/ollama-models")).body, {
      models: ["qwen3:8b", "llama3.2:latest"],
      default: "llama3.2:latest",
    });
    await post("/api/generate", { url: WG_URL, provider: "ollama", model: "qwen3:8b" });
    assert.equal(used, "qwen3:8b");
    await post("/api/generate", { url: WG_URL, provider: "ollama", model: "not-installed" });
    assert.equal(used, "llama3.2:latest");
  } finally {
    globalThis.fetch = realFetch;
  }
});
