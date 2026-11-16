/**
 * Background process for the Zurich Housing Tool app. It serves the interface
 * and the API on 127.0.0.1. The app starts it with port 0 and reads the
 * chosen port from the first line it prints.
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import os from "os";
import { execFile, spawn } from "child_process";
import {
  DATA_DIR,
  WGZIMMER_LISTINGS_FILE,
  TRACKER_FILE,
  PROFILE_FILE,
  TEMPLATE_FILE,
  SEARCHES,
  SEARCH_FILE,
  currentSearch,
  loadCachedListing,
  SCAN_STATUS_FILE,
  listingKey,
  noteKey,
  ensureDataDir,
  readJson,
  ETHZ_BROWSER_PROFILE_DIR,
  ETHZ_CACHE_FILE,
  ROUTE_SHAPES_FILE,
} from "./lib.js";
import { fetchRideShape } from "./route-shapes.mjs";
import {
  fetchEthzAccount,
  fetchEthzAdvertisements,
  profileFromAccount,
  withEthzPortal,
} from "./sources/ethz-housing.mjs";
import {
  ethzUsername,
  forgetEthzCredentials,
  saveEthzCredentials,
} from "./ethz-session.mjs";
import { loadAllListings } from "./listings.js";
import { scan as scanSources } from "./scan.js";
import { fetchListings } from "./details.mjs";
import {
  sendWgzimmerApplication,
  validateWgzimmerApplication,
} from "./sources/wgzimmer-send.mjs";
import {
  sendFlatfoxApplication,
  validateFlatfoxApplication,
} from "./sources/flatfox-send.mjs";
import {
  checkFlatfoxSession,
  FlatfoxLogin,
  persistentFlatfoxLauncher,
} from "./sources/flatfox-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.argv[2] ?? 0);
// The macOS app sets this to its bundled Foundation Models helper.
const APPLE_LLM = process.env.ZHT_APPLE_LLM;

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

// ── API: Get all listings ─────────────────────────────────────────────────

app.get("/api/listings", (req, res) => {
  res.json(loadAllListings());
});

// ── API: Get tracker ──────────────────────────────────────────────────────

app.get("/api/tracker", (req, res) => {
  if (fs.existsSync(TRACKER_FILE)) {
    res.json(JSON.parse(fs.readFileSync(TRACKER_FILE, "utf8")));
  } else {
    res.json({ applied: [], shortlisted: [], rejected: [], excluded: [] });
  }
});

// ── API: Trigger scan ─────────────────────────────────────────────────────

let scanInProgress = false;

// The detail pages are fetched one per second, after the scan has answered.
const DETAILS_PER_SCAN = 60;
let detailFetchInProgress = false;

async function fetchWgzimmerDetailsInBackground() {
  if (detailFetchInProgress) return;
  const urls = unfetchedWgzimmerUrls(DETAILS_PER_SCAN);
  if (urls.length === 0) return;
  detailFetchInProgress = true;
  try {
    await fetchListings(urls);
  } catch (e) {
    console.log(`Detail fetch failed: ${e.message}`);
  } finally {
    detailFetchInProgress = false;
  }
}

/**
 * wgzimmer listings carry no address until their detail page is fetched.
 * Returns the cheapest untracked ones that have not been fetched yet.
 */
function unfetchedWgzimmerUrls(limit) {
  const tracker = readJson(TRACKER_FILE, {});
  const trackedKeys = new Set(
    TRACKER_CATEGORIES.flatMap((category) => tracker[category] || []).map(
      (entry) => listingKey(entry.url),
    ),
  );
  const urls = readJson(WGZIMMER_LISTINGS_FILE, [])
    .filter((l) => l.price && l.price <= SEARCHES.room.maxPrice)
    .filter((l) => !loadCachedListing(l.url))
    .filter((l) => !trackedKeys.has(listingKey(l.url)))
    .sort((a, b) => a.price - b.price)
    .map((l) => l.url);
  return [...new Set(urls)].slice(0, limit);
}

app.post("/api/scan", async (req, res) => {
  if (scanInProgress) {
    return res.status(409).json({ error: "A scan is already running." });
  }
  scanInProgress = true;
  try {
    await scanSources();
    fetchWgzimmerDetailsInBackground();
    res.json({ ok: true, status: scanStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message.substring(0, 100) });
  } finally {
    scanInProgress = false;
  }
});

function scanStatus() {
  const status = readJson(SCAN_STATUS_FILE, null);
  return status && { ...status, fetchingDetails: detailFetchInProgress };
}

app.get("/api/scan-status", (req, res) => {
  res.json(scanStatus());
});

// ── API: Rooms or apartments ──────────────────────────────────────────────

function publicSearch() {
  const { type, maxPrice } = currentSearch();
  return { housing: type, maxPrice };
}

app.get("/api/search", (req, res) => {
  res.json(publicSearch());
});

app.post("/api/search", (req, res) => {
  const { housing } = req.body;
  if (!(housing in SEARCHES)) {
    return res.status(400).json({ error: "Unknown search" });
  }
  if (housing !== currentSearch().type) {
    ensureDataDir();
    fs.writeFileSync(SEARCH_FILE, JSON.stringify({ housing }, null, 2));
  }
  res.json(publicSearch());
});

// ── API: Drafting models available on this Mac ────────────────────────────

app.get("/api/llm-providers", (req, res) => {
  res.json(APPLE_LLM ? ["apple", "ollama", "api"] : ["ollama", "api"]);
});

// ── API: Drafting through OpenRouter ─────────────────────────────────────

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4.1-mini";
const API_SETTINGS_FILE = path.join(DATA_DIR, "llm-api.json");

// Settings saved for another service hold a key OpenRouter would refuse.
function loadApiSettings() {
  const saved = readJson(API_SETTINGS_FILE, {});
  if (saved.service && saved.service !== "openrouter") return { apiKey: "", model: "" };
  return { apiKey: saved.apiKey || "", model: saved.model || "" };
}

function publicApiSettings({ apiKey, model }) {
  return {
    model: model || OPENROUTER_DEFAULT_MODEL,
    keyEnding: apiKey ? apiKey.slice(-4) : null,
  };
}

app.get("/api/llm-api", (req, res) => {
  res.json(publicApiSettings(loadApiSettings()));
});

app.post("/api/llm-api", (req, res) => {
  const { apiKey, model } = req.body;
  const settings = { ...loadApiSettings(), service: "openrouter" };
  if (typeof model === "string") settings.model = model.trim();
  if (typeof apiKey === "string") settings.apiKey = apiKey.trim();
  ensureDataDir();
  fs.writeFileSync(API_SETTINGS_FILE, JSON.stringify(settings, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(API_SETTINGS_FILE, 0o600);
  res.json(publicApiSettings(settings));
});

// ── API: Get sent applications with messages ──────────────────────────────

app.get("/api/applications", (req, res) => {
  const appDir = path.join(DATA_DIR, "applications");
  if (!fs.existsSync(appDir)) return res.json([]);
  const files = fs.readdirSync(appDir).filter((f) => f.endsWith(".md"));
  const apps = files.map((f) => {
    const content = fs.readFileSync(path.join(appDir, f), "utf8");
    return { id: f.replace(".md", ""), content };
  });
  res.json(apps);
});

// ── API: Change the tracking status of a listing ─────────────────────────

const TRACKER_CATEGORIES = ["applied", "shortlisted", "rejected", "excluded"];
const TRACK_ACTIONS = {
  apply: "applied",
  shortlist: "shortlisted",
  reject: "rejected",
  exclude: "excluded",
  untrack: null,
};

function trackListing(url, action, { address, price, reason } = {}) {
  const tracker = {
    applied: [],
    shortlisted: [],
    rejected: [],
    excluded: [],
    notes: {},
    ...readJson(TRACKER_FILE, {}),
  };
  const today = new Date().toISOString().split("T")[0];
  const key = listingKey(url);

  let entry = null;
  for (const category of TRACKER_CATEGORIES) {
    const idx = tracker[category].findIndex((e) => listingKey(e.url) === key);
    if (idx > -1) entry = tracker[category].splice(idx, 1)[0];
  }

  const category = TRACK_ACTIONS[action];
  if (category) {
    entry = entry || {
      url,
      address: address || null,
      price: price || null,
      date: today,
    };
    if (action === "reject") entry.rejectedDate = today;
    if (action === "exclude") entry.reason = reason || null;
    tracker[category].push(entry);
  }

  fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
}

app.post("/api/track", (req, res) => {
  const { url, action } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  if (!(action in TRACK_ACTIONS)) {
    return res.status(400).json({ error: "unknown action" });
  }
  try {
    trackListing(url, action, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Notes ───────────────────────────────────────────────────────────

app.post("/api/note", (req, res) => {
  const { url, text } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const tracker = { notes: {}, ...readJson(TRACKER_FILE, {}) };
    if (text?.trim()) tracker.notes[noteKey(url)] = text.trim();
    else delete tracker.notes[noteKey(url)];
    fs.writeFileSync(TRACKER_FILE, JSON.stringify(tracker, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Full listing details ────────────────────────────────────────────

const FETCHABLE_HOSTS = ["www.wgzimmer.ch", "wgzimmer.ch", "flatfox.ch"];

function isFetchableUrl(url) {
  try {
    return FETCHABLE_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

app.get("/api/listing-details", (req, res) => {
  res.json(loadCachedListing(String(req.query.url || "")));
});

app.post("/api/fetch-details", async (req, res) => {
  const { url } = req.body;
  if (!url || !isFetchableUrl(url)) {
    return res
      .status(400)
      .json({ error: "Details can be fetched for wgzimmer and flatfox only." });
  }
  try {
    await fetchListings([url]);
    const details = loadCachedListing(url);
    if (!details) {
      return res.status(502).json({ error: "The listing page gave no details." });
    }
    res.json({ details });
  } catch (e) {
    res.status(500).json({ error: e.message.substring(0, 100) });
  }
});

// ── API: Applicant profile ───────────────────────────────────────────────

const PROFILE_FIELDS = [
  "name",
  "email",
  "phone",
  "dateOfBirth",
  "affiliation",
  "street",
  "postalCode",
  "city",
  "country",
  "occupation",
  "situation",
  "futurePlans",
  "hobbies",
  "personality",
  "nationality",
  "languages",
  "wgExperience",
  "extras",
];
const FLATFOX_BROWSER_PROFILE_DIR = path.join(
  DATA_DIR,
  "flatfox-browser-profile",
);

// ── API: Public transport route to the chosen ETH or UZH location ───────

const TIMETABLE_URL = "https://search.ch/timetable/api/route.json";
const routeCache = new Map();

/** The next weekday at 08:00, so routes reflect a usual morning commute. */
export function commuteStart(now) {
  const day = new Date(now);
  day.setDate(day.getDate() + 1);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${pad(day.getMonth() + 1)}/${pad(day.getDate())}/${day.getFullYear()}`, time: "08:00" };
}

const point = (place) =>
  place && place.lat != null ? { lat: place.lat, lng: place.lon, name: place.name } : null;

/** The quickest connection reduced to what the listing panel and map show. */
export function simplifyRoute(body) {
  const connection = (body.connections || [])
    .slice()
    .sort((a, b) => a.duration - b.duration)[0];
  if (!connection) return null;
  const legs = (connection.legs || [])
    .filter((leg) => leg.type && leg.exit)
    .map((leg) => ({
      type: leg.type,
      line: leg.line || null,
      color: leg.bgcolor ? `#${leg.bgcolor}` : null,
      textColor: leg.fgcolor ? `#${leg.fgcolor}` : null,
      from: leg.name,
      to: leg.exit.name,
      minutes: Math.round((leg.runningtime || 0) / 60),
      path: [point(leg), ...(leg.stops || []).map(point), point(leg.exit)].filter(Boolean),
    }));
  return { minutes: Math.round(connection.duration / 60), legs };
}

app.locals.fetchTimetable = async (params) => {
  const resp = await fetch(`${TIMETABLE_URL}?${params}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`The timetable returned HTTP ${resp.status}.`);
  return resp.json();
};

app.get("/api/route", async (req, res) => {
  const coords = (value) => {
    const [lat, lng] = String(value || "").split(",").map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(5)},${lng.toFixed(5)}` : null;
  };
  const from = coords(req.query.from);
  const to = coords(req.query.to);
  if (!from || !to) return res.status(400).json({ error: "from and to coordinates required" });
  const { date, time } = commuteStart(new Date());
  const key = `${from}|${to}|${date}`;
  try {
    if (!routeCache.has(key)) {
      const params = new URLSearchParams({ from, to, date, time, num: "4", show_delays: "0" });
      routeCache.set(key, simplifyRoute(await app.locals.fetchTimetable(params)));
    }
    res.json(routeCache.get(key));
  } catch (e) {
    res.status(502).json({ error: e.message.substring(0, 200) });
  }
});

// Ride shapes are cached on disk, so each stretch of a line is fetched once.
app.locals.fetchRideShape = fetchRideShape;

app.post("/api/route-shape", async (req, res) => {
  const { type, line } = req.body;
  const stops = (Array.isArray(req.body.stops) ? req.body.stops : [])
    .map((p) => [Number(p.lng), Number(p.lat)])
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (!type || !line || stops.length < 2) {
    return res.status(400).json({ error: "type, line and stops required" });
  }
  const key = [type, line, ...stops.map((p) => p.map((n) => n.toFixed(4)).join(","))].join("|");
  const cache = readJson(ROUTE_SHAPES_FILE, {});
  if (key in cache) return res.json({ path: cache[key] });
  try {
    const path = await app.locals.fetchRideShape({ type, line: String(line), stops });
    ensureDataDir();
    fs.writeFileSync(ROUTE_SHAPES_FILE, JSON.stringify({ ...readJson(ROUTE_SHAPES_FILE, {}), [key]: path }));
    res.json({ path });
  } catch (e) {
    res.status(502).json({ error: e.message.substring(0, 200) });
  }
});

// ── API: ETH Housing Office sign-in ──────────────────────────────────────

app.locals.ethzPortal = (credentials, fn) =>
  withEthzPortal(ETHZ_BROWSER_PROFILE_DIR, credentials, fn);
let ethzBusy = false;

app.get("/api/ethz-session", (req, res) => {
  const username = ethzUsername();
  res.json({ connected: Boolean(username), username });
});

/** Fill profile fields that are still empty from the portal account. */
function importProfile(account) {
  const profile = readJson(PROFILE_FILE, null) || {};
  const imported = [];
  for (const [field, value] of Object.entries(profileFromAccount(account))) {
    if (!profile[field]) {
      profile[field] = value;
      imported.push(field);
    }
  }
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
  return imported;
}

app.post("/api/ethz-session/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!username || !password) {
    return res.status(400).json({ error: "Enter your ETH user name and password." });
  }
  if (ethzBusy) {
    return res.status(409).json({ error: "Already signing in. Try again in a moment." });
  }
  ethzBusy = true;
  try {
    ensureDataDir();
    const { account, ads } = await app.locals.ethzPortal(
      { username, password },
      async (page) => ({
        account: await fetchEthzAccount(page),
        ads: await fetchEthzAdvertisements(page),
      }),
    );
    await saveEthzCredentials({ username, password });
    fs.writeFileSync(ETHZ_CACHE_FILE, JSON.stringify(ads, null, 2));
    res.json({ connected: true, username, imported: importProfile(account), count: ads.length });
  } catch (e) {
    const message = /login exception/i.test(e.message)
      ? "ETH did not accept the user name or password."
      : e.message.split("\n")[0].substring(0, 300);
    res.status(400).json({ error: message });
  } finally {
    ethzBusy = false;
  }
});

app.post("/api/ethz-session/logout", async (req, res) => {
  await forgetEthzCredentials();
  fs.rmSync(ETHZ_BROWSER_PROFILE_DIR, { recursive: true, force: true });
  fs.rmSync(ETHZ_CACHE_FILE, { force: true });
  res.json({ connected: false });
});

app.get("/api/profile", (req, res) => {
  res.json({ fields: PROFILE_FIELDS, profile: readJson(PROFILE_FILE, null) });
});

app.post("/api/profile", (req, res) => {
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    if (req.body[field] !== undefined && req.body[field] !== "") {
      profile[field] = req.body[field];
    }
  }
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Save an application message ─────────────────────────────────────

function saveApplication(url, message) {
  const appDir = path.join(DATA_DIR, "applications");
  fs.mkdirSync(appDir, { recursive: true });
  const name = listingKey(url).replace(/[^a-zA-Z0-9-]/g, "_").slice(-80);
  fs.writeFileSync(path.join(appDir, `${name}.md`), `${url}\n\n${message}\n`);
}

// ── API: Template ────────────────────────────────────────────────────────

function readTemplate() {
  return String(readJson(TEMPLATE_FILE, {})?.template || "").trim();
}

app.get("/api/template", (req, res) => {
  res.json({ template: readTemplate() });
});

app.post("/api/template", (req, res) => {
  const template = String(req.body.template ?? "").trim();
  try {
    fs.writeFileSync(TEMPLATE_FILE, JSON.stringify({ template }, null, 2));
    res.json({ template });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/application", (req, res) => {
  const { url, message } = req.body;
  if (!url || !message) {
    return res.status(400).json({ error: "url and message required" });
  }
  try {
    saveApplication(url, message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Send a WGZimmer application ─────────────────────────────────────

const wgzimmerSendsInProgress = new Set();

app.post("/api/send-wgzimmer", async (req, res) => {
  const profile = readJson(PROFILE_FILE, null);
  const application = {
    url: req.body.url,
    message: req.body.message,
    name: profile?.name,
    email: profile?.email,
    phone: profile?.phone,
  };

  try {
    validateWgzimmerApplication(application);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const key = listingKey(application.url);
  if (wgzimmerSendsInProgress.has(key)) {
    return res
      .status(409)
      .json({ error: "A message to this listing is already being sent." });
  }

  wgzimmerSendsInProgress.add(key);
  try {
    const result = await sendWgzimmerApplication(application);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message.substring(0, 300) });
  } finally {
    wgzimmerSendsInProgress.delete(key);
  }
});

// ── API: Send a Flatfox contact request ──────────────────────────────────

const flatfoxSendsInProgress = new Set();
let flatfoxBrowserBusy = false;
let flatfoxConnected = null;

app.get("/api/flatfox-session", async (req, res) => {
  if (flatfoxBrowserBusy) {
    return res.json({ connected: flatfoxConnected === true, busy: true });
  }

  flatfoxBrowserBusy = true;
  try {
    const status = await checkFlatfoxSession(FLATFOX_BROWSER_PROFILE_DIR);
    flatfoxConnected = status.connected;
    res.json(status);
  } catch (e) {
    res.status(502).json({ error: e.message.substring(0, 300) });
  } finally {
    flatfoxBrowserBusy = false;
  }
});

// A sign-in keeps the Flatfox profile open between its steps and gives it
// up after a few idle minutes.
const FLATFOX_LOGIN_IDLE_MS = 5 * 60 * 1000;
let flatfoxLogin = null;
let flatfoxLoginTimer = null;

async function endFlatfoxLogin() {
  clearTimeout(flatfoxLoginTimer);
  const login = flatfoxLogin;
  flatfoxLogin = null;
  if (login) {
    await login.close();
    flatfoxBrowserBusy = false;
  }
}

app.post("/api/flatfox-session/login", async (req, res) => {
  const { email, password, code } = req.body;
  clearTimeout(flatfoxLoginTimer);
  try {
    let status;
    if (email) {
      await endFlatfoxLogin();
      if (flatfoxBrowserBusy) {
        return res.status(409).json({
          error: "Flatfox is busy with another request. Try again in a moment.",
        });
      }
      flatfoxBrowserBusy = true;
      ensureDataDir();
      flatfoxLogin = new FlatfoxLogin(FLATFOX_BROWSER_PROFILE_DIR);
      status = await flatfoxLogin.start(String(email).trim());
    } else if (flatfoxLogin) {
      status = await flatfoxLogin.submit({ password, code });
    } else {
      return res.status(409).json({ error: "Start again with your email." });
    }
    if (status.connected) {
      flatfoxConnected = true;
      await endFlatfoxLogin();
    } else {
      flatfoxLoginTimer = setTimeout(endFlatfoxLogin, FLATFOX_LOGIN_IDLE_MS);
    }
    res.json(status);
  } catch (e) {
    // A wrong password or code can be retried in the same sign-in.
    if (flatfoxLogin?.step) {
      flatfoxLoginTimer = setTimeout(endFlatfoxLogin, FLATFOX_LOGIN_IDLE_MS);
    } else {
      await endFlatfoxLogin();
    }
    res.status(400).json({ error: e.message.split("\n")[0].substring(0, 300) });
  }
});

app.post("/api/flatfox-session/cancel", async (req, res) => {
  await endFlatfoxLogin();
  res.json({ ok: true });
});

app.post("/api/flatfox-session/logout", async (req, res) => {
  await endFlatfoxLogin();
  if (flatfoxBrowserBusy) {
    return res.status(409).json({
      error: "Flatfox is busy sending a message. Try again in a moment.",
    });
  }
  fs.rmSync(FLATFOX_BROWSER_PROFILE_DIR, { recursive: true, force: true });
  flatfoxConnected = false;
  res.json({ connected: false });
});

app.post("/api/send-flatfox", async (req, res) => {
  const profile = readJson(PROFILE_FILE, null);
  const application = {
    url: req.body.url,
    message: req.body.message,
    name: profile?.name,
    email: profile?.email,
    phone: profile?.phone,
  };

  try {
    validateFlatfoxApplication(application);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const key = listingKey(application.url);
  if (flatfoxSendsInProgress.has(key)) {
    return res
      .status(409)
      .json({ error: "A message to this listing is already being sent." });
  }
  if (flatfoxBrowserBusy) {
    return res.status(409).json({
      error: "Finish the Flatfox login or session check before sending.",
    });
  }

  flatfoxSendsInProgress.add(key);
  flatfoxBrowserBusy = true;
  try {
    ensureDataDir();
    await sendFlatfoxApplication(
      application,
      persistentFlatfoxLauncher(FLATFOX_BROWSER_PROFILE_DIR),
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message.substring(0, 300) });
  } finally {
    flatfoxSendsInProgress.delete(key);
    flatfoxBrowserBusy = false;
  }
});

// ── API: Send the saved message to many Flatfox listings ────────────────

// Small batches with pauses keep the sending pace close to a person's, so
// Flatfox does not treat the account as a spammer.
const FLATFOX_BATCH_LIMIT = 20;
const FLATFOX_BATCH_MAX_FAILURES_IN_ROW = 3;
app.locals.flatfoxBatchPauseMs = () => 20000 + Math.random() * 20000;
app.locals.sendFlatfox = (application) =>
  sendFlatfoxApplication(
    application,
    persistentFlatfoxLauncher(FLATFOX_BROWSER_PROFILE_DIR),
  );

let flatfoxBatch = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function batchStatus() {
  if (!flatfoxBatch) return { running: false };
  const { running, total, sent, failed, current, stopping } = flatfoxBatch;
  return { running, total, sent, failed, current, stopping };
}

function appliedKeys() {
  const tracker = readJson(TRACKER_FILE, {});
  return new Set((tracker.applied || []).map((e) => listingKey(e.url)));
}

async function runFlatfoxBatch(batch, listings, profile, template) {
  let failuresInRow = 0;
  for (const [index, listing] of listings.entries()) {
    if (batch.stopping) break;
    if (index > 0) await wait(app.locals.flatfoxBatchPauseMs());
    while (flatfoxBrowserBusy && !batch.stopping) await wait(1000);
    if (batch.stopping) break;

    const message = fillMessage(template, listing);
    batch.current = listing.address || listing.url;
    flatfoxBrowserBusy = true;
    try {
      await app.locals.sendFlatfox({
        url: listing.url,
        message,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
      });
      saveApplication(listing.url, message);
      trackListing(listing.url, "apply", listing);
      batch.sent.push(listing.url);
      failuresInRow = 0;
    } catch (e) {
      batch.failed.push({
        url: listing.url,
        address: listing.address,
        error: e.message.substring(0, 300),
      });
      failuresInRow += 1;
      if (failuresInRow >= FLATFOX_BATCH_MAX_FAILURES_IN_ROW) break;
    } finally {
      flatfoxBrowserBusy = false;
    }
  }
  batch.current = null;
  batch.running = false;
}

app.get("/api/send-flatfox-batch", (req, res) => {
  res.json(batchStatus());
});

app.post("/api/send-flatfox-batch", (req, res) => {
  if (flatfoxBatch?.running) {
    return res.status(409).json({ error: "Messages are already being sent." });
  }
  const profile = readJson(PROFILE_FILE, {}) || {};
  const template = readTemplate();
  if (!template) {
    return res.status(400).json({
      error: "Write your template in the Template tab first.",
    });
  }
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  const wanted = new Set(urls.map(listingKey));
  const applied = appliedKeys();
  const listings = loadAllListings()
    .filter((l) => l.source === "flatfox")
    .filter((l) => wanted.has(listingKey(l.url)))
    .filter((l) => !applied.has(listingKey(l.url)))
    .slice(0, FLATFOX_BATCH_LIMIT);
  if (listings.length === 0) {
    return res.status(400).json({ error: "No Flatfox listings left to send to." });
  }
  try {
    validateFlatfoxApplication({
      ...profile,
      url: listings[0].url,
      message: fillMessage(template, listings[0]),
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  flatfoxBatch = {
    running: true,
    total: listings.length,
    sent: [],
    failed: [],
    current: null,
    stopping: false,
  };
  runFlatfoxBatch(flatfoxBatch, listings, profile, template);
  res.json(batchStatus());
});

app.post("/api/send-flatfox-batch/stop", (req, res) => {
  if (flatfoxBatch?.running) flatfoxBatch.stopping = true;
  res.json(batchStatus());
});

// ── API: Generate application message with a local model ──────────────────

const OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";

async function installedOllamaModels() {
  const resp = await fetch(`${OLLAMA_URL}/api/tags`);
  return (await resp.json()).models;
}

/**
 * The requested model when it is installed, then the default model, then the
 * smallest installed model. Returns null when none is installed.
 */
function pickOllamaModel(models, requested) {
  if (models.some((m) => m.name === requested)) return requested;
  const match = models.find(
    (m) =>
      m.name === DEFAULT_OLLAMA_MODEL ||
      m.name === `${DEFAULT_OLLAMA_MODEL}:latest`,
  );
  if (match) return match.name;
  const bySize = [...models].sort((a, b) => a.size - b.size);
  return bySize[0]?.name || null;
}

async function chooseOllamaModel(requested) {
  return pickOllamaModel(await installedOllamaModels(), requested);
}

const FLUENT_PATTERN =
  /fluent|native|mother tongue|bilingual|\bC[12]\b|fliessend|fließend|Muttersprache|verhandlungssicher/i;

/**
 * "fluent", "learning" or "none" from the profile's free-text languages.
 * Only a German entry that states a fluent level counts as fluent.
 */
export function germanLevel(languages) {
  const entries = (languages || "")
    .split(/[,;/\n]|\band\b|\bund\b/i)
    .filter((entry) => /german|deutsch/i.test(entry));
  if (entries.length === 0) return "none";
  return entries.some((entry) => FLUENT_PATTERN.test(entry)) ? "fluent" : "learning";
}

/** The saved message with {address} filled in for a listing. */
export function fillMessage(template, listing) {
  return template.replaceAll("{address}", listing?.address || "").trim();
}

// The Ollama app starts its own server. A Homebrew or script install only
// has the command, which needs `ollama serve`.
app.locals.ollamaInstalls = [
  { app: "/Applications/Ollama.app" },
  { app: path.join(os.homedir(), "Applications", "Ollama.app") },
  { command: "/opt/homebrew/bin/ollama" },
  { command: "/usr/local/bin/ollama" },
];
const OLLAMA_START_TIMEOUT_MS = 45000;

function findOllama() {
  return app.locals.ollamaInstalls.find((install) =>
    fs.existsSync(install.app || install.command),
  );
}

async function ollamaStatus() {
  try {
    const models = await installedOllamaModels();
    return { models: models.map((m) => m.name), default: pickOllamaModel(models) };
  } catch {
    return { models: [], default: null, unreachable: true, installed: Boolean(findOllama()) };
  }
}

app.get("/api/ollama-models", async (req, res) => {
  res.json(await ollamaStatus());
});

app.post("/api/ollama/start", async (req, res) => {
  let status = await ollamaStatus();
  if (!status.unreachable) return res.json(status);
  const install = findOllama();
  if (!install) {
    return res.status(404).json({ ...status, error: "Ollama is not installed." });
  }
  const child = install.app
    ? spawn("open", ["-a", install.app], { stdio: "ignore" })
    : spawn(install.command, ["serve"], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  const deadline = Date.now() + OLLAMA_START_TIMEOUT_MS;
  while (status.unreachable && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    status = await ollamaStatus();
  }
  if (status.unreachable) {
    return res.status(502).json({ ...status, error: "Ollama did not start." });
  }
  res.json(status);
});

/** Whole years since a dd.mm.yyyy birth date, or null. */
export function ageOn(dateOfBirth, today) {
  const m = String(dateOfBirth || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [day, month, year] = m.slice(1).map(Number);
  const hadBirthday =
    today.getMonth() + 1 > month || (today.getMonth() + 1 === month && today.getDate() >= day);
  return today.getFullYear() - year - (hadBirthday ? 0 : 1);
}

/** Details that come with the listing itself, as for the ETH Housing Office. */
function listingDetails(url) {
  const key = listingKey(url);
  return loadAllListings().find((l) => listingKey(l.url) === key)?.details || null;
}

app.post("/api/generate", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // Load user profile
  if (!fs.existsSync(PROFILE_FILE)) {
    return res.status(400).json({
      error:
        "No profile yet. Fill in the Profile tab first.",
    });
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
  // Contact details are for the contact form and stay out of the prompt.
  const { email, phone, dateOfBirth, street, postalCode, city, country, ...promptProfile } =
    profile;
  const age = ageOn(dateOfBirth, new Date());
  if (age) promptProfile.age = age;

  const listing = loadCachedListing(url) || listingDetails(url);
  if (!listing) {
    return res
      .status(400)
      .json({ error: "Listing not fetched yet. Fetch it first." });
  }

  const listingDesc = [
    listing.description || "",
    listing.room || "",
    listing.lookingFor || "",
    listing.weAre || "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const isGerman =
    /[äöüß]|Zürich|Strasse|Wohnung/i.test(listingDesc) &&
    !/english version|ENG|For English/i.test(listingDesc.substring(0, 200));

  const german = germanLevel(profile.languages);
  const languageNote = !isGerman
    ? "The listing is in English. Write in English only."
    : german === "fluent"
      ? "The listing is in German. Write the message in German only."
      : `The listing is in German. Write the message in German first, then add the line '(Übersetzt mit Hilfe eines Übersetzungsdienstes. Englische Originalversion unten.)' and the English version below it. In the German version, say briefly that ${german === "learning" ? "you are learning German and" : "you"} are comfortable communicating in English.`;

  const task =
    currentSearch().type === "apartment"
      ? 'You are writing a short application message to a landlord or property manager (Verwaltung) in Switzerland about an apartment. Write from the perspective of the applicant based on their profile below. Be polite, concise and professional: introduce the applicant, their job and why the apartment fits, offer to send a complete application dossier and ask to view the apartment. Tailor it to the listing. Do not invent facts that are not in the profile. Keep it under 180 words. In German, use the formal "Sie".'
      : "You are writing a short, friendly WG (shared flat) application message. Write from the perspective of the applicant based on their profile below. The message should be tailored to the specific listing. Be genuine, not generic. Keep it under 200 words.";

  const prompt = `${task}

Use only the parts of the profile that matter for this listing and what it asks for. Leave out details that do not help this application. The message does not need to mention everything in the profile.

${languageNote}

APPLICANT PROFILE:
${JSON.stringify(promptProfile, null, 2)}

LISTING:
${listingDesc.substring(0, 2000)}

Write the application message now. Do not include a subject line. Start with a greeting.`;

  const provider = req.body.provider || "ollama";
  const generate =
    { apple: generateWithApple, api: generateWithApi }[provider] ||
    generateWithOllama;
  try {
    res.json(await generate(prompt, req.body.model));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function generateWithOllama(prompt, requested) {
  let model;
  try {
    model = await chooseOllamaModel(requested);
  } catch {
    throw new Error("Could not connect to Ollama. Start it with: ollama serve");
  }
  if (!model) {
    throw new Error(
      `Ollama has no model installed. Run: ollama pull ${DEFAULT_OLLAMA_MODEL}`,
    );
  }
  let ollamaRes;
  try {
    ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
  } catch (e) {
    throw new Error(`Ollama request failed. ${e.message}`);
  }
  if (!ollamaRes.ok) {
    throw new Error(`Ollama returned an error for model ${model}.`);
  }
  const result = await ollamaRes.json();
  return { message: result.response, model };
}

const API_TIMEOUT_MS = 120000;

async function generateWithApi(prompt) {
  const { apiKey, model } = loadApiSettings();
  if (!apiKey) {
    throw new Error("Add an OpenRouter API key in the settings first.");
  }
  const chosenModel = model || OPENROUTER_DEFAULT_MODEL;
  let resp;
  try {
    resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: chosenModel,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach OpenRouter. ${e.message}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 401) {
    throw new Error(`OpenRouter rejected the API key.`);
  }
  if (!resp.ok) {
    const detail = body.error?.message || `HTTP ${resp.status}`;
    throw new Error(`OpenRouter returned an error. ${detail}`);
  }
  const message = body.choices?.[0]?.message?.content?.trim();
  if (!message) throw new Error(`OpenRouter returned no text.`);
  return { message, model: chosenModel };
}

const APPLE_TIMEOUT_MS = 180000;

function generateWithApple(prompt) {
  if (!APPLE_LLM) {
    return Promise.reject(new Error("Apple Intelligence is available in the macOS app only."));
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      APPLE_LLM,
      { timeout: APPLE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || `Apple Intelligence failed. ${error.message}`));
        } else {
          resolve({ message: stdout.trim(), model: "Apple Intelligence" });
        }
      },
    );
    child.stdin.end(prompt);
  });
}

export { app };

const startedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (startedDirectly) {
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`Dashboard at http://127.0.0.1:${server.address().port}/`);
  });
}
