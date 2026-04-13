#!/usr/bin/env node
/**
 * Web dashboard server for zurich-housing-tool.
 * Usage: node server.js [port]
 */
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  DATA_DIR,
  WGZIMMER_LISTINGS_FILE,
  FLATFOX_CACHE_FILE,
  RONORP_CACHE_FILE,
  TRACKER_FILE,
  LISTINGS_DIR,
  ETH_ZENTRUM,
  MAX_PRICE,
  distKm,
  ensureDataDir,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.argv[2]) || 3456;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── API: Get all listings ─────────────────────────────────────────────────

app.get("/api/listings", (req, res) => {
  const listings = [];

  // wgzimmer
  if (fs.existsSync(WGZIMMER_LISTINGS_FILE)) {
    const wg = JSON.parse(fs.readFileSync(WGZIMMER_LISTINGS_FILE, "utf8"));
    for (const l of wg) {
      if (!l.price) continue;
      const id = l.url.match(/([a-f0-9-]{36})/)?.[1];
      let dist = null;
      let address = null;
      if (id && fs.existsSync(path.join(LISTINGS_DIR, id + ".json"))) {
        const cached = JSON.parse(
          fs.readFileSync(path.join(LISTINGS_DIR, id + ".json"), "utf8"),
        );
        if (cached.lat && cached.lng) {
          dist = distKm(ETH_ZENTRUM, { lat: cached.lat, lng: cached.lng });
        }
        address = cached.address;
      }
      let lat = null,
        lng = null;
      if (id && fs.existsSync(path.join(LISTINGS_DIR, id + ".json"))) {
        const c = JSON.parse(
          fs.readFileSync(path.join(LISTINGS_DIR, id + ".json"), "utf8"),
        );
        lat = c.lat || null;
        lng = c.lng || null;
      }
      listings.push({
        id: `wgzimmer-${id || l.url.slice(-20)}`,
        source: "wgzimmer",
        price: l.price,
        dist: dist ? Math.round(dist * 100) / 100 : null,
        lat,
        lng,
        address: address || l.neighborhood || null,
        description: l.description?.substring(0, 200) || "",
        availableFrom: l.availableFrom || null,
        until: l.until || null,
        url: l.url,
      });
    }
  }

  // flatfox
  if (fs.existsSync(FLATFOX_CACHE_FILE)) {
    const pins = JSON.parse(fs.readFileSync(FLATFOX_CACHE_FILE, "utf8"));
    for (const p of pins) {
      const km = distKm(ETH_ZENTRUM, { lat: p.latitude, lng: p.longitude });
      const cacheKey = `flatfox-${p.pk}`;
      let address = null;
      let description = "";
      let availableFrom = null;
      if (fs.existsSync(path.join(LISTINGS_DIR, cacheKey + ".json"))) {
        const cached = JSON.parse(
          fs.readFileSync(path.join(LISTINGS_DIR, cacheKey + ".json"), "utf8"),
        );
        address = cached.address;
        description = cached.description?.substring(0, 200) || "";
        availableFrom = cached.availableFrom;
      }
      listings.push({
        id: cacheKey,
        source: "flatfox",
        price: p.price_display,
        dist: Math.round(km * 100) / 100,
        lat: p.latitude,
        lng: p.longitude,
        address,
        description,
        availableFrom,
        until: null,
        url: `https://flatfox.ch/en/flat/8001-zurich/${p.pk}/`,
      });
    }
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

app.post("/api/scan", (req, res) => {
  try {
    // Scan all sources
    execSync("node monitor.js scan --fresh", {
      cwd: __dirname,
      timeout: 300000,
      stdio: "ignore",
    });
    // Batch fetch top 50 unfetched listings for geocoding
    try {
      execSync("node search.js --not-tracked --fetch 50 --limit 50", {
        cwd: __dirname,
        timeout: 300000,
        stdio: "ignore",
      });
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message.substring(0, 100) });
  }
});

// ── API: Get config ───────────────────────────────────────────────────────

app.get("/api/config", (req, res) => {
  res.json({ target: ETH_ZENTRUM, maxPrice: MAX_PRICE });
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

// ── API: Mark as rejected ─────────────────────────────────────────────────

app.post("/api/reject", (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const tracker = fs.existsSync(TRACKER_FILE)
      ? JSON.parse(fs.readFileSync(TRACKER_FILE, "utf8"))
      : { applied: [], shortlisted: [], rejected: [], excluded: [] };

    // Move from applied to rejected
    const idx = tracker.applied.findIndex((e) => e.url === url);
    if (idx > -1) {
      const entry = tracker.applied.splice(idx, 1)[0];
      entry.rejectedDate = new Date().toISOString().split("T")[0];
      tracker.rejected.push(entry);
    } else {
      tracker.rejected.push({
        url,
        date: new Date().toISOString().split("T")[0],
      });
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
