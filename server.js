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
  TRACKER_FILE,
  LISTINGS_DIR,
  ETH_ZENTRUM,
  MAX_PRICE,
  FLATFOX_SLUG,
  SEEN_FILE,
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

function readJson(file, fallback) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : fallback;
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
      description: l.description?.substring(0, 200) || "",
      availableFrom: l.availableFrom || null,
      until: l.until || null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
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
        200,
      ),
      availableFrom: cached?.availableFrom || p.availableFrom || null,
      until: null,
      url: `https://flatfox.ch/en/flat/${FLATFOX_SLUG}/${p.pk}/`,
      firstSeen: seen[id]?.firstSeen || null,
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
      description: l.description?.substring(0, 200) || "",
      availableFrom: l.availableFrom || null,
      until: null,
      url: l.url,
      firstSeen: seen[id]?.firstSeen || null,
      ...listingFlags(l.description || "", {}),
    });
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

app.post("/api/scan", async (req, res) => {
  if (scanInProgress) {
    return res.status(409).json({ error: "A scan is already running." });
  }
  scanInProgress = true;
  try {
    // Scan all sources
    await runNodeScript(["monitor.js", "scan", "--fresh"]);
    // Batch fetch top 50 unfetched listings for geocoding
    try {
      await runNodeScript([
        "search.js",
        "--not-tracked",
        "--fetch",
        "50",
        "--limit",
        "50",
      ]);
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message.substring(0, 100) });
  } finally {
    scanInProgress = false;
  }
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

// ── API: Generate application message via Ollama ──────────────────────────

const PROFILE_FILE = path.join(__dirname, "profile.json");

app.post("/api/generate", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });

  // Load user profile
  if (!fs.existsSync(PROFILE_FILE)) {
    return res.status(400).json({
      error:
        "No profile.json found. Copy profile.example.json to profile.json and fill in your details.",
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

  try {
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",
        prompt,
        stream: false,
      }),
    });

    if (!ollamaRes.ok) {
      return res.status(500).json({
        error: "Ollama not running. Start it with: ollama serve",
      });
    }

    const result = await ollamaRes.json();
    res.json({ message: result.response });
  } catch (e) {
    res.status(500).json({
      error:
        "Could not connect to Ollama. Make sure it's running (ollama serve) and has llama3.2 pulled (ollama pull llama3.2).",
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n  zurich-housing-tool dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
