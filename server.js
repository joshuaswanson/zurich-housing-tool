#!/usr/bin/env node
/**
 * Web dashboard server for zurich-housing-tool.
 * Usage: node server.js [port]
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  DATA_DIR,
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  RONORP_CACHE_FILE,
  STUDENTS_CACHE_FILE,
  TRACKER_FILE,
  LISTINGS_DIR,
  ETH_ZENTRUM,
  MAX_PRICE,
  FLATFOX_SLUG,
  SEEN_FILE,
  loadCachedListing,
  SCAN_STATUS_FILE,
  STUDENT_HOUSING_PATTERN,
  isGenderRestricted,
  isShortSublet,
  buildSpamPatterns,
  config,
  distKm,
  ensureDataDir,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const SCAN_STEP_TIMEOUT_MS = 300000;
const app = express();
const PORT = parseInt(process.argv[2]) || 3456;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── API: Get all listings ─────────────────────────────────────────────────

const SPAM_PATTERNS = buildSpamPatterns(config.exclude?.spam || []);
const MIN_DURATION_DAYS = config.search?.minDuration || 60;
const DESCRIPTION_LENGTH = 400;

function hasEndDate(until) {
  return Boolean(until) && until !== "?" && !/no time|unbefristet/i.test(until);
}

function readJson(file, fallback) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : fallback;
}

// Such a listing is placed at the centre of its postcode area.
function isPostcodeOnly(address) {
  return !address || /^\d{4}(\s+\D.*)?$/.test(address.trim());
}

function listingFlags(text, dates) {
  return {
    genderRestricted: isGenderRestricted(text),
    studentHousing: STUDENT_HOUSING_PATTERN.test(text),
    bulkPoster: SPAM_PATTERNS.some((p) => p.test(text)),
    shortSublet: isShortSublet(dates, MIN_DURATION_DAYS),
  };
}

app.get("/api/listings", (req, res) => {
  const listings = [];
  const seen = readJson(SEEN_FILE, {});
  const cachedDetails = (key) =>
    key ? readJson(path.join(LISTINGS_DIR, key + ".json"), null) : null;

  // wgzimmer
  for (const l of readJson(WGZIMMER_LISTINGS_FILE, [])) {
    if (!l.price) continue;
    const uuid = l.url.match(/([a-f0-9-]{36})/)?.[1];
    const id = `wgzimmer-${uuid || l.url.slice(-20)}`;
    const cached = cachedDetails(uuid);
    const hasCoords = cached?.lat && cached?.lng;
    const dist = hasCoords
      ? distKm(ETH_ZENTRUM, { lat: cached.lat, lng: cached.lng })
      : null;
    const text = [l.description, l.neighborhood, JSON.stringify(cached || "")]
      .filter(Boolean)
      .join(" ");
    listings.push({
      id,
      source: "wgzimmer",
      price: l.price,
      dist: dist ? Math.round(dist * 100) / 100 : null,
      lat: cached?.lat || null,
      lng: cached?.lng || null,
      address: cached?.address || l.neighborhood || null,
      description: l.description?.substring(0, DESCRIPTION_LENGTH) || "",
      availableFrom: l.availableFrom || null,
      until: l.until || null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: hasEndDate(l.until),
      ...listingFlags(text, l),
    });
  }

  // flatfox
  for (const p of readJson(FLATFOX_CACHE_FILE, [])) {
    const km = distKm(ETH_ZENTRUM, { lat: p.latitude, lng: p.longitude });
    const id = `flatfox-${p.pk}`;
    const cached = cachedDetails(id);
    const text = [p.description, JSON.stringify(cached || "")]
      .filter(Boolean)
      .join(" ");
    listings.push({
      id,
      source: "flatfox",
      price: p.price_display,
      dist: Math.round(km * 100) / 100,
      lat: p.latitude,
      lng: p.longitude,
      address: cached?.address || p.address || null,
      description: (cached?.description || p.description || "").substring(
        0,
        DESCRIPTION_LENGTH,
      ),
      availableFrom: cached?.availableFrom || p.availableFrom || null,
      until: null,
      url: `https://flatfox.ch/en/flat/${FLATFOX_SLUG}/${p.pk}/`,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: false,
      ...listingFlags(text, {}),
    });
  }

  // ronorp
  for (const l of readJson(RONORP_CACHE_FILE, [])) {
    if (!l.price || !l.isOffer) continue;
    const id = `ronorp-${l.url.split("/").pop()}`;
    const hasCoords = l.lat && l.lng;
    listings.push({
      id,
      source: "ronorp",
      price: l.price,
      dist: hasCoords ? Math.round(distKm(ETH_ZENTRUM, l) * 100) / 100 : null,
      lat: l.lat || null,
      lng: l.lng || null,
      address: l.address || null,
      description: l.description?.substring(0, DESCRIPTION_LENGTH) || "",
      availableFrom: l.availableFrom || null,
      until: null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: Boolean(l.isTemporary),
      pricePeriod: l.pricePeriod || null,
      ...listingFlags(l.description || "", {}),
      ...(l.pricePeriod ? { shortSublet: true } : {}),
    });
  }

  // students.ch
  for (const l of readJson(STUDENTS_CACHE_FILE, [])) {
    if (!l.price) continue;
    const id = `students-${l.url.match(/details\/(\d+)/)?.[1]}`;
    const hasCoords = l.lat && l.lng;
    listings.push({
      id,
      source: "students",
      price: l.price,
      dist: hasCoords ? Math.round(distKm(ETH_ZENTRUM, l) * 100) / 100 : null,
      lat: l.lat || null,
      lng: l.lng || null,
      address: l.address || null,
      description: l.description?.substring(0, DESCRIPTION_LENGTH) || "",
      availableFrom: l.availableFrom || null,
      until: l.until || null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      hasEndDate: Boolean(l.until),
      wholeFlat: Boolean(l.isWholeFlat),
      ...listingFlags(l.description || "", l),
    });
  }

  for (const l of listings) {
    l.approximate = Boolean(l.lat && l.lng) && isPostcodeOnly(l.address);
  }

  res.json(listings);
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

function runNodeScript(args) {
  return execFileAsync(process.execPath, args, {
    cwd: __dirname,
    timeout: SCAN_STEP_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const DETAILS_PER_SCAN = 50;

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
    .filter((l) => l.price && l.price <= MAX_PRICE)
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
    // Scan all sources
    await runNodeScript(["monitor.js", "scan", "--fresh"]);
    try {
      const urls = unfetchedWgzimmerUrls(DETAILS_PER_SCAN);
      if (urls.length > 0) await runNodeScript(["fetch-listing.mjs", ...urls]);
    } catch {}
    res.json({ ok: true, status: readJson(SCAN_STATUS_FILE, null) });
  } catch (e) {
    res.status(500).json({ error: e.message.substring(0, 100) });
  } finally {
    scanInProgress = false;
  }
});

app.get("/api/scan-status", (req, res) => {
  res.json(readJson(SCAN_STATUS_FILE, null));
});

// ── API: Get config ───────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({
    target: { ...ETH_ZENTRUM, label: config.target.label },
    maxPrice: MAX_PRICE,
    exclude: {
      genderRestricted: config.exclude?.genderRestricted !== false,
      studentHousing: config.exclude?.woko === true,
      shortSublets: config.exclude?.shortSublets !== false,
    },
  });
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

function listingKey(url) {
  return (
    url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
    )?.[1] ||
    url.match(/\/(\d{5,})\/?$/)?.[1] ||
    url
  );
}

app.post("/api/track", (req, res) => {
  const { url, action, address, price, reason } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  if (!(action in TRACK_ACTIONS)) {
    return res.status(400).json({ error: "unknown action" });
  }
  try {
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Notes ───────────────────────────────────────────────────────────

// Same key that track.js uses for notes.
function noteKey(url) {
  return (
    url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
    )?.[1] || url
  );
}

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

let detailFetchInProgress = false;

app.post("/api/fetch-details", async (req, res) => {
  const { url } = req.body;
  if (!url || !isFetchableUrl(url)) {
    return res
      .status(400)
      .json({ error: "Details can be fetched for wgzimmer and flatfox only." });
  }
  if (scanInProgress || detailFetchInProgress) {
    return res
      .status(409)
      .json({ error: "A scan or another fetch is already running." });
  }
  detailFetchInProgress = true;
  try {
    await runNodeScript(["fetch-listing.mjs", url]);
    const details = loadCachedListing(url);
    if (!details) {
      return res.status(502).json({ error: "The listing page gave no details." });
    }
    res.json({ details });
  } catch (e) {
    res.status(500).json({ error: e.message.substring(0, 100) });
  } finally {
    detailFetchInProgress = false;
  }
});

// ── API: Applicant profile ───────────────────────────────────────────────

const PROFILE_EXAMPLE_FILE = path.join(__dirname, "profile.example.json");

app.get("/api/profile", (req, res) => {
  const fields = Object.keys(readJson(PROFILE_EXAMPLE_FILE, {}));
  res.json({ fields, profile: readJson(PROFILE_FILE, null) });
});

app.post("/api/profile", (req, res) => {
  const fields = Object.keys(readJson(PROFILE_EXAMPLE_FILE, {}));
  const profile = {};
  for (const field of fields) {
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

app.post("/api/application", (req, res) => {
  const { url, message } = req.body;
  if (!url || !message) {
    return res.status(400).json({ error: "url and message required" });
  }
  try {
    const appDir = path.join(DATA_DIR, "applications");
    fs.mkdirSync(appDir, { recursive: true });
    const name = listingKey(url).replace(/[^a-zA-Z0-9-]/g, "_").slice(-80);
    fs.writeFileSync(path.join(appDir, `${name}.md`), `${url}\n\n${message}\n`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Generate application message via Ollama ──────────────────────────

const PROFILE_FILE = path.join(__dirname, "profile.json");
const OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";

/**
 * The model from config.llm.model or the default when it is installed,
 * otherwise the smallest installed model. Returns null when none is installed.
 */
async function chooseOllamaModel() {
  const resp = await fetch(`${OLLAMA_URL}/api/tags`);
  const { models } = await resp.json();
  const preferred = config.llm?.model || DEFAULT_OLLAMA_MODEL;
  const match = models.find(
    (m) => m.name === preferred || m.name === `${preferred}:latest`,
  );
  if (match) return match.name;
  const bySize = [...models].sort((a, b) => a.size - b.size);
  return bySize[0]?.name || null;
}

app.post("/api/generate", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // Load user profile
  if (!fs.existsSync(PROFILE_FILE)) {
    return res.status(400).json({
      error:
        "No profile yet. Fill in the Profile tab first, or create profile.json from profile.example.json.",
    });
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));

  // Load listing details from cache
  const cacheKey =
    url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
    )?.[1] ||
    (url.match(/\/(\d{5,})\/?/)
      ? `flatfox-${url.match(/\/(\d{5,})\/?/)[1]}`
      : null);

  let listing = null;
  if (cacheKey && fs.existsSync(path.join(LISTINGS_DIR, cacheKey + ".json"))) {
    listing = JSON.parse(
      fs.readFileSync(path.join(LISTINGS_DIR, cacheKey + ".json"), "utf8"),
    );
  }

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

  const prompt = `You are writing a short, friendly WG (shared flat) application message. Write from the perspective of the applicant based on their profile below. The message should be tailored to the specific listing. Be genuine, not generic. Keep it under 200 words.

${isGerman ? "The listing is in German. Write the message in German first, then add a note '(Übersetzung mit Hilfe eines Übersetzungsdienstes. Englische Originalversion unten.)' and include the English version below." : "The listing is in English. Write in English only."}

${profile.languages && /german|deutsch/i.test(profile.languages) ? "" : "If writing in German, mention that you can read/follow German but need to speak English day-to-day."}

APPLICANT PROFILE:
${JSON.stringify(profile, null, 2)}

LISTING:
${listingDesc.substring(0, 2000)}

Write the application message now. Do not include a subject line. Start with a greeting.`;

  let model;
  try {
    model = await chooseOllamaModel();
  } catch {
    return res.status(500).json({
      error: "Could not connect to Ollama. Start it with: ollama serve",
    });
  }
  if (!model) {
    return res.status(500).json({
      error: `Ollama has no model installed. Run: ollama pull ${DEFAULT_OLLAMA_MODEL}`,
    });
  }

  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
    });
    if (!ollamaRes.ok) {
      return res
        .status(500)
        .json({ error: `Ollama returned an error for model ${model}.` });
    }
    const result = await ollamaRes.json();
    res.json({ message: result.response, model });
  } catch (e) {
    res.status(500).json({ error: `Ollama request failed. ${e.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`\n  zurich-housing-tool dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
